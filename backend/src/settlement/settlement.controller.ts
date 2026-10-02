import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard';
import { JwtUser } from '../auth/auth.service';
import { DbService } from '../database/db.service';
import { Ruling } from '../domain/pricing';
import { buildSpotTimeline, TimelineIncident, TimelineOrder } from '../domain/timeline';
import { SettlementService } from './settlement.service';

class ExitDto {
  charge_kwh?: number;
  exit_at?: string; // 道闸时钟/离场补录时间
}

@Controller()
@UseGuards(AuthGuard)
export class SettlementController {
  constructor(
    private db: DbService,
    private settlement: SettlementService,
  ) {}

  // 离场结算：把计费规则、异常、申诉裁决合并清算
  @Post('reservations/:id/exit')
  async exit(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: ExitDto) {
    return this.db.withTx((c) =>
      this.settlement.completeSettlement(c, id, {
        exitAt: dto.exit_at ? new Date(dto.exit_at) : undefined,
        chargeKwh: dto.charge_kwh ?? 0,
        actorId: user.sub,
        actorRole: user.role,
      }),
    );
  }

  // 仅试算（离场前预览账单）
  @Get('reservations/:id/quote')
  async quote(@CurrentUser() user: JwtUser, @Param('id') id: string, @Query('charge_kwh') kwh?: string) {
    const rq = await this.db.query(
      `SELECT r.*, s.hourly_rate, s.overnight_cap, s.near_charger, s.owner_id, v.is_new_energy
       FROM reservations r
       JOIN parking_spots s ON s.id=r.spot_id
       JOIN vehicles v ON v.id=r.vehicle_id
       WHERE r.id=$1`,
      [id],
    );
    const r = rq.rows[0];
    if (!r) throw new BadRequestException('预约不存在');
    return this.settlement.computeBreakdown(this.db, r, new Date(), Number(kwh ?? 0));
  }

  @Get('reservations/:id/settlement')
  async getSettlement(@Param('id') id: string) {
    const sq = await this.db.query(`SELECT * FROM settlements WHERE reservation_id=$1`, [id]);
    if (!sq.rows[0]) return null;
    const ledger = await this.db.query(`SELECT * FROM ledger_entries WHERE settlement_id=$1 ORDER BY id`, [sq.rows[0].id]);
    return { ...sq.rows[0], ledger: ledger.rows };
  }

  // 申诉终裁后重算分账（物业/管理员）
  @Roles('property', 'admin')
  @Post('appeals/:id/resettle')
  async resettle(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.db.withTx(async (c) => {
      const aq = await c.query(
        `SELECT * FROM appeals WHERE id=$1 AND status='closed'`,
        [id],
      );
      const appeal = aq.rows[0];
      if (!appeal) throw new BadRequestException('申诉未终裁，不能重算');
      const rq = await c.query(
        `SELECT r.*, s.hourly_rate, s.overnight_cap, s.near_charger, s.owner_id, v.is_new_energy
         FROM reservations r
         JOIN parking_spots s ON s.id=r.spot_id
         JOIN vehicles v ON v.id=r.vehicle_id
         WHERE r.id=$1 FOR UPDATE`,
        [appeal.reservation_id],
      );
      const r = rq.rows[0];
      const old = await c.query(`SELECT * FROM settlements WHERE reservation_id=$1`, [r.id]);
      // 若终裁认定为业主提前回家且已换位，沿用换位补偿金额（记录在旧结算 detail/事件流）
      let relocationCompensation: number | undefined;
      if (appeal.ruling === 'owner_fault') {
        const oe = await c.query(
          `SELECT detail FROM service_events
           WHERE reservation_id=$1 AND type='settlement_completed'
           ORDER BY id DESC LIMIT 1`,
          [r.id],
        );
        const rc = Number(oe.rows[0]?.detail?.relocation_compensation ?? 0);
        if (rc > 0) relocationCompensation = rc;
      }
      // 重算前反向冲销旧结算对信用分的影响（仅系统内账号：车主/业主）
      if (old.rows[0] && old.rows[0].credit_delta !== 0 && ['driver', 'owner'].includes(old.rows[0].credit_target)) {
        const oldTargetId = old.rows[0].credit_target === 'owner' ? r.owner_id : r.driver_id;
        await c.query(
          `UPDATE users SET credit_score=GREATEST(0, credit_score - $1) WHERE id=$2`,
          [old.rows[0].credit_delta, oldTargetId],
        );
      }
      if (old.rows[0]) await c.query(`DELETE FROM settlements WHERE id=$1`, [old.rows[0].id]);

      const settlement = await this.settlement.completeSettlement(c, r.id, {
        exitAt: r.gate_exit_at ?? new Date(),
        chargeKwh: 0,
        forcedRuling: appeal.ruling as Ruling,
        appealId: appeal.id,
        relocationCompensation,
        actorId: user.sub,
        actorRole: user.role,
        recompute: true,
      });

      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, detail)
         VALUES ($1,$2,'settlement_recomputed',$3,$4,$5)`,
        [r.id, r.spot_id, user.sub, user.role, JSON.stringify({ appeal_id: id, ruling: appeal.ruling })],
      );
      return settlement;
    });
  }

  // 分账流水总览（物业/管理员/业主看自己车位）
  @Get('ledger')
  async ledger(
    @CurrentUser() user: JwtUser,
    @Query('account') account?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const params: any[] = [];
    let where = '1=1';
    if (account) {
      params.push(account);
      where += ` AND l.account=$${params.length}`;
    }
    if (from) {
      params.push(new Date(from));
      where += ` AND l.created_at >= $${params.length}`;
    }
    if (to) {
      params.push(new Date(to));
      where += ` AND l.created_at <= $${params.length}`;
    }
    if (user.role === 'owner') {
      params.push(user.sub);
      where += ` AND s.spot_id IN (SELECT id FROM parking_spots WHERE owner_id=$${params.length})`;
    }
    return this.db
      .query(
        `SELECT l.*, st.code AS settlement_code, r.code AS reservation_code, r.spot_id, sp.code AS spot_code
         FROM ledger_entries l
         JOIN settlements st ON st.id=l.settlement_id
         JOIN reservations r ON r.id=st.reservation_id
         JOIN parking_spots sp ON sp.id=st.spot_id
         WHERE ${where}
         ORDER BY l.id DESC LIMIT 300`,
        params,
      )
      .then((q) => q.rows);
  }

  // ---- 单车位一晚时间轴：解释每段时间谁使用/谁付款/谁违约 ----
  @Get('spots/:id/timeline')
  async timeline(
    @Param('id') id: string,
    @Query('date') date?: string, // YYYY-MM-DD（当晚起点，默认今晚）
    @Query('start') startQ?: string, // 审计任意时间窗（优先于 date）
    @Query('end') endQ?: string,
  ) {
    const spot = await this.db.query(`SELECT * FROM parking_spots WHERE id=$1`, [id]);
    if (!spot.rows[0]) throw new BadRequestException('车位不存在');

    // 默认"今晚"：当天 18:00 到次日 09:00；也可用 start/end 指定任意审计窗口
    let nightStart: Date;
    let nightEnd: Date;
    if (startQ && endQ) {
      nightStart = new Date(startQ);
      nightEnd = new Date(endQ);
    } else {
      const base = date ? new Date(`${date}T18:00:00`) : (() => {
        const d = new Date();
        d.setHours(18, 0, 0, 0);
        return d;
      })();
      nightStart = base;
      nightEnd = new Date(base.getTime() + 15 * 3600000);
    }

    const oq = await this.db.query(
      `SELECT r.id, r.code, u.name AS driver_name, r.plate, r.status, r.start_at, r.end_at,
              r.gate_entry_at, r.parking_confirmed_at, r.gate_exit_at,
              st.ruling, st.base_fee, st.overtime_fee, st.wrong_park_fine,
              st.abnormal_compensation, st.payable,
              (SELECT MIN(occurred_at) FROM service_events e
                WHERE e.reservation_id=r.id AND e.type IN ('parking_confirmed','gate_entry')) AS dummy
       FROM reservations r
       JOIN users u ON u.id=r.driver_id
       LEFT JOIN settlements st ON st.reservation_id=r.id
       WHERE r.spot_id=$1 AND r.start_at < $2 AND r.end_at > $3
       ORDER BY r.start_at`,
      [id, nightEnd, nightStart],
    );

    // usable_from：识别成功/可使用时间点（被陌生车占用则以占用解除时间为准，简化用停车确认时间）
    const orders: TimelineOrder[] = oq.rows.map((o: any) => ({
      id: o.id,
      code: o.code,
      driverName: o.driver_name,
      plate: o.plate,
      status: o.status,
      reservedStart: o.start_at,
      reservedEnd: o.end_at,
      gateEntryAt: o.gate_entry_at,
      parkingConfirmedAt: o.parking_confirmed_at,
      gateExitAt: o.gate_exit_at,
      usableFrom: o.parking_confirmed_at ?? o.gate_entry_at,
      settlement: o.ruling || o.base_fee != null
        ? {
            ruling: o.ruling,
            baseFee: Number(o.base_fee ?? 0),
            overtimeFee: Number(o.overtime_fee ?? 0),
            wrongParkFine: Number(o.wrong_park_fine ?? 0),
            abnormalCompensation: Number(o.abnormal_compensation ?? 0),
            payable: Number(o.payable ?? 0),
          }
        : null,
    }));

    const iq = await this.db.query(
      `SELECT id, type, status, plate, created_at, resolved_at, resolution, reservation_id
       FROM incident_tickets
       WHERE spot_id=$1 AND created_at < $2 AND (resolved_at IS NULL OR resolved_at > $3)
       ORDER BY created_at`,
      [id, nightEnd, nightStart],
    );
    const incidents: TimelineIncident[] = iq.rows.map((i: any) => ({
      id: i.id,
      type: i.type,
      status: i.status,
      plate: i.plate,
      createdAt: i.created_at,
      resolvedAt: i.resolved_at,
      resolution: i.resolution,
      reservationId: i.reservation_id,
    }));

    const segments = buildSpotTimeline(nightStart, nightEnd, orders, incidents);
    return {
      spot: { id: spot.rows[0].id, code: spot.rows[0].code },
      night_start: nightStart,
      night_end: nightEnd,
      orders,
      incidents,
      segments,
    };
  }
}
