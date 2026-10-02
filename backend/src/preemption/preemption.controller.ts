import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard';
import { JwtUser } from '../auth/auth.service';
import { DbService } from '../database/db.service';
import { isIntervalCovered, ShareWindow } from '../domain/availability';
import { assessPreemption, PREEMPTION } from '../domain/preemption';

function code(prefix: string) {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4)
    .toString(36)
    .toUpperCase()}`;
}

const OPEN_STATUSES = ['assessing', 'relocatable', 'awaiting_owner_choice', 'waiting', 'property_coordination'];

/**
 * 业主提前回家抢占处理：
 * 业主上报提前回家 -> 平台评估（车辆是否入场/剩余时长/附近替代车位/历史提前结束次数）
 * -> 可替换：车主收换位导航+费用补偿；不可替换：业主选择等待/违约补偿收回/申请物业协调。
 * 每次提前结束都写入业主发布记录，后续开放时段审核更谨慎。
 */
@Controller('dispatch/preempt')
@UseGuards(AuthGuard)
export class PreemptionController {
  constructor(private db: DbService) {}

  // 业主上报"提前回家"：平台评估并生成抢占处理单
  @Roles('owner')
  @Post()
  async preempt(
    @CurrentUser() user: JwtUser,
    @Body() body: { spot_id: number; eta_minutes?: number; note?: string; occurred_at?: string },
  ) {
    const occurredAt = body.occurred_at ? new Date(body.occurred_at) : new Date();
    return this.db.withTx(async (c) => {
      const spotQ = await c.query(
        `SELECT s.*, (SELECT json_agg(json_build_object('weekday',weekday,'start_time',start_time::text,'end_time',end_time::text))
                      FROM spot_share_windows w WHERE w.spot_id=s.id) AS windows
         FROM parking_spots s WHERE s.id=$1 AND s.owner_id=$2 FOR UPDATE`,
        [body.spot_id, user.sub],
      );
      const spot = spotQ.rows[0];
      if (!spot) throw new BadRequestException('车位不存在或不属于本人');

      // 幂等：该车位已有进行中的抢占处理单时直接返回现有单（重复点击不产生脏数据）
      const exist = await c.query(
        `SELECT * FROM preemption_cases WHERE spot_id=$1 AND status = ANY($2) ORDER BY id DESC LIMIT 1`,
        [body.spot_id, OPEN_STATUSES],
      );
      if (exist.rows[0]) {
        return { ok: true, case: exist.rows[0], assessment: exist.rows[0].assessment?.report ?? null, duplicated: true };
      }

      // 1) 当前预约：共享时段内正在履约的订单（预约窗覆盖上报时点）
      const resQ = await c.query(
        `SELECT r.*, v.is_new_energy, v.is_visitor, u.name AS driver_name
         FROM reservations r
         JOIN vehicles v ON v.id=r.vehicle_id
         JOIN users u ON u.id=r.driver_id
         WHERE r.spot_id=$1 AND r.status IN ('reserved','admitted','in_garage')
           AND r.start_at <= $2 AND r.end_at > $2
         ORDER BY r.start_at ASC LIMIT 1`,
        [body.spot_id, occurredAt],
      );
      const reservation = resQ.rows[0] ?? null;

      // 2) 附近可替代车位：同小区已上架、共享窗覆盖剩余时段、车辆属性兼容、时段无冲突
      let alternatives: any[] = [];
      if (reservation) {
        alternatives = await this.findAlternatives(c, spot, reservation, occurredAt);
      }

      // 3) 业主历史提前结束次数（含历史 owner_return 工单，不含本次）
      const historyCount = await this.countOwnerEarlyReturns(c, user.sub);

      // 4) 领域评估
      const assessment = assessPreemption({
        now: occurredAt,
        reservation: reservation
          ? {
              id: reservation.id,
              status: reservation.status,
              start_at: reservation.start_at,
              end_at: reservation.end_at,
              gate_entry_at: reservation.gate_entry_at,
              parking_confirmed_at: reservation.parking_confirmed_at,
            }
          : null,
        alternatives,
        ownerHistoryCount: historyCount,
      });

      const status = !reservation ? 'resolved' : assessment.replaceable ? 'relocatable' : 'awaiting_owner_choice';
      const ins = await c.query(
        `INSERT INTO preemption_cases(code, spot_id, reservation_id, owner_id, status,
           vehicle_entered, remaining_minutes, owner_history_count, alternatives, assessment,
           resolution, occurred_at, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          code('P'),
          body.spot_id,
          reservation?.id ?? null,
          user.sub,
          status,
          assessment.vehicleEntered,
          assessment.remainingMinutes,
          historyCount,
          JSON.stringify(alternatives),
          JSON.stringify({
            report: assessment,
            eta_minutes: body.eta_minutes ?? 30,
            note: body.note ?? null,
            original_hourly_rate: Number(spot.hourly_rate),
            original_overnight_cap: spot.overnight_cap != null ? Number(spot.overnight_cap) : null,
            original_spot_code: spot.code,
          }),
          !reservation ? '当前无在途预约，业主直接收回车位自用' : null,
          occurredAt,
          !reservation ? occurredAt : null,
        ],
      );
      const pcase = ins.rows[0];

      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail, occurred_at)
         VALUES ($1,$2,'preemption_assessed',$3,'owner',$4,$5,$6)`,
        [
          reservation?.id ?? null,
          body.spot_id,
          user.sub,
          reservation?.plate ?? null,
          JSON.stringify({
            case_code: pcase.code,
            vehicle_entered: assessment.vehicleEntered,
            remaining_minutes: assessment.remainingMinutes,
            alternatives: alternatives.map((a) => a.code),
            owner_history_count: historyCount,
            recommended: assessment.recommendedAction,
          }),
          occurredAt,
        ],
      );

      return { ok: true, case: pcase, assessment };
    });
  }

  // 列表：业主看自己 / 物业、管理员看全部 / 车主看与自己订单相关的
  @Get()
  async list(@CurrentUser() user: JwtUser, @Query('status') status?: string) {
    const params: any[] = [];
    let where = '1=1';
    if (user.role === 'owner') {
      params.push(user.sub);
      where += ` AND p.owner_id=$${params.length}`;
    } else if (user.role === 'driver') {
      params.push(user.sub);
      where += ` AND r.driver_id=$${params.length}`;
    }
    if (status) {
      params.push(status.split(','));
      where += ` AND p.status = ANY($${params.length})`;
    }
    const { rows } = await this.db.query(
      `SELECT p.*, s.code AS spot_code, c.name AS community_name, r.code AS reservation_code, r.plate,
              r.start_at AS reserved_start, r.end_at AS reserved_end,
              u.name AS owner_name, d.name AS driver_name,
              alt.code AS alternative_spot_code
       FROM preemption_cases p
       JOIN parking_spots s ON s.id=p.spot_id
       JOIN communities c ON c.id=s.community_id
       LEFT JOIN reservations r ON r.id=p.reservation_id
       LEFT JOIN users u ON u.id=p.owner_id
       LEFT JOIN users d ON d.id=r.driver_id
       LEFT JOIN parking_spots alt ON alt.id=p.alternative_spot_id
       WHERE ${where}
       ORDER BY CASE p.status WHEN 'awaiting_owner_choice' THEN 0 WHEN 'relocatable' THEN 1
                WHEN 'property_coordination' THEN 2 WHEN 'waiting' THEN 3 ELSE 4 END, p.id DESC
       LIMIT 200`,
      params,
    );
    return rows;
  }

  @Get(':id')
  async detail(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    const { rows } = await this.db.query(
      `SELECT p.*, s.code AS spot_code, c.name AS community_name, r.code AS reservation_code, r.plate,
              u.name AS owner_name, d.name AS driver_name, alt.code AS alternative_spot_code
       FROM preemption_cases p
       JOIN parking_spots s ON s.id=p.spot_id
       JOIN communities c ON c.id=s.community_id
       LEFT JOIN reservations r ON r.id=p.reservation_id
       LEFT JOIN users u ON u.id=p.owner_id
       LEFT JOIN users d ON d.id=r.driver_id
       LEFT JOIN parking_spots alt ON alt.id=p.alternative_spot_id
       WHERE p.id=$1`,
      [id],
    );
    if (!rows[0]) throw new BadRequestException('抢占处理单不存在');
    return rows[0];
  }

  // 业主确认换位：预约迁移至替代车位，车主收换位导航 + 费用补偿
  @Roles('owner')
  @Post(':id/relocate')
  async relocate(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() body: { alternative_spot_id: number }) {
    return this.db.withTx(async (c) => {
      const caseQ = await c.query(`SELECT * FROM preemption_cases WHERE id=$1 FOR UPDATE`, [id]);
      const pcase = caseQ.rows[0];
      if (!pcase) throw new BadRequestException('抢占处理单不存在');
      if (pcase.owner_id !== user.sub) throw new BadRequestException('只能处理本人车位的抢占单');
      if (pcase.status !== 'relocatable') throw new BadRequestException('当前状态不可换位（需先完成评估且存在替代车位）');
      if (!pcase.reservation_id) throw new BadRequestException('该单无关联预约，无法换位');

      const alternatives: any[] = pcase.alternatives ?? [];
      const target = alternatives.find((a) => Number(a.id) === Number(body.alternative_spot_id));
      if (!target) throw new BadRequestException('目标车位不在评估出的可替代车位列表中');

      // 迁移预约到替代车位（时段不变，计费锚定原车位价格）
      const rq = await c.query(
        `UPDATE reservations SET spot_id=$1 WHERE id=$2 AND status IN ('reserved','admitted','in_garage')
         RETURNING *`,
        [body.alternative_spot_id, pcase.reservation_id],
      );
      if (!rq.rows[0]) throw new BadRequestException('预约已结束，无法换位');
      const reservation = rq.rows[0];

      const cash = PREEMPTION.relocationCashCompensation;
      const couponAmount = PREEMPTION.relocationCouponCompensation;
      const couponCode = code('RELOC');

      // 平台换位补偿券（非现金，下次抵扣）
      await c.query(`INSERT INTO coupons(user_id, code, amount) VALUES ($1,$2,$3)`, [
        reservation.driver_id,
        couponCode,
        couponAmount,
      ]);

      // 更新处理单
      const updated = await c.query(
        `UPDATE preemption_cases SET status='relocated', chosen_action='relocate',
           alternative_spot_id=$1, compensation_amount=$2, coupon_compensation=$3,
           resolution=$4, resolved_by=$5, resolved_at=now()
         WHERE id=$6 RETURNING *`,
        [
          body.alternative_spot_id,
          cash,
          couponAmount,
          `已换位至 ${target.code}：车主获换位现金补偿 ¥${cash}（业主承担）+ 平台补偿券 ¥${couponAmount}`,
          user.sub,
          id,
        ],
      );

      // 换位工单（挂靠挪车/换位通知，进入调度看板与订单追溯）
      const ticket = await c.query(
        `INSERT INTO incident_tickets(code, spot_id, reservation_id, type, status, plate, reporter_role,
           description, resolution, detail, resolved_by, resolved_at)
         VALUES ($1,$2,$3,'owner_preempt','resolved',$4,'owner',$5,$6,$7,$8,now()) RETURNING *`,
        [
          code('T'),
          pcase.spot_id,
          pcase.reservation_id,
          reservation.plate,
          `业主提前回家，平台为车主安排换位至 ${target.code}`,
          `已换位至 ${target.code}，补偿现金 ¥${cash} + 券 ¥${couponAmount}`,
          JSON.stringify({ preemption_case_id: pcase.id, action: 'relocate', to_spot_id: target.id }),
          user.sub,
        ],
      );

      // 换位导航通知（App 推送 + 车位 LED）
      const guidance = this.buildRelocationGuidance(pcase.assessment?.original_spot_code, target);
      await c.query(
        `INSERT INTO move_notices(ticket_id, target_plate, channel, message, delivered_at)
         VALUES ($1,$2,'app_push+led',$3, now())`,
        [ticket.rows[0].id, reservation.plate, `【换位导航】${guidance.voice}；补偿：现金 ¥${cash} + 平台券 ¥${couponAmount}`],
      );

      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
         VALUES ($1,$2,'spot_relocated',$3,'owner',$4,$5)`,
        [
          pcase.reservation_id,
          pcase.spot_id,
          user.sub,
          reservation.plate,
          JSON.stringify({
            case_code: pcase.code,
            from_spot: pcase.assessment?.original_spot_code ?? null,
            to_spot: target.code,
            to_spot_id: target.id,
            cash_compensation: cash,
            coupon_compensation: couponAmount,
            guidance,
          }),
        ],
      );

      return { ok: true, case: updated.rows[0], guidance, coupon_code: couponCode };
    });
  }

  // 无法/不愿替换时，业主三选一：等待 / 支付违约补偿收回 / 申请物业协调
  @Roles('owner')
  @Post(':id/choose')
  async choose(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() body: { action: 'wait' | 'breach_compensation' | 'property_coordination'; note?: string },
  ) {
    if (!['wait', 'breach_compensation', 'property_coordination'].includes(body.action)) {
      throw new BadRequestException('非法的处置选择');
    }
    return this.db.withTx(async (c) => {
      const caseQ = await c.query(`SELECT * FROM preemption_cases WHERE id=$1 FOR UPDATE`, [id]);
      const pcase = caseQ.rows[0];
      if (!pcase) throw new BadRequestException('抢占处理单不存在');
      if (pcase.owner_id !== user.sub) throw new BadRequestException('只能处理本人车位的抢占单');
      if (!['awaiting_owner_choice', 'relocatable', 'waiting'].includes(pcase.status)) {
        throw new BadRequestException('当前状态不可选择处置方式');
      }

      if (body.action === 'wait') {
        await c.query(
          `UPDATE preemption_cases SET status='waiting', chosen_action='wait',
             assessment=jsonb_set(assessment, '{wait_note}', $1::jsonb) WHERE id=$2`,
          [JSON.stringify(body.note ?? '业主选择等待车主离场'), id],
        );
        await c.query(
          `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, detail)
           VALUES ($1,$2,'preemption_wait',$3,'owner',$4)`,
          [pcase.reservation_id, pcase.spot_id, user.sub, JSON.stringify({ case_code: pcase.code, note: body.note ?? null })],
        );
        return { ok: true, status: 'waiting' };
      }

      if (body.action === 'property_coordination') {
        await c.query(
          `UPDATE preemption_cases SET status='property_coordination', chosen_action='property_coordination' WHERE id=$1`,
          [id],
        );
        await c.query(
          `INSERT INTO incident_tickets(code, spot_id, reservation_id, type, status, plate, reporter_role, description, detail)
           VALUES ($1,$2,$3,'owner_preempt','open',$4,'owner',$5,$6)`,
          [
            code('T'),
            pcase.spot_id,
            pcase.reservation_id,
            null,
            `业主提前回家且无法安排换位，申请物业现场协调（${body.note ?? '等待物业到场'}）`,
            JSON.stringify({ preemption_case_id: pcase.id, action: 'property_coordination' }),
          ],
        );
        await c.query(
          `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, detail)
           VALUES ($1,$2,'preemption_coordination_requested',$3,'owner',$4)`,
          [pcase.reservation_id, pcase.spot_id, user.sub, JSON.stringify({ case_code: pcase.code })],
        );
        return { ok: true, status: 'property_coordination' };
      }

      // breach_compensation：支付违约补偿立即收回车位（复用业主回家违约链路：
      // 按实际可用时长计费 + 现金补偿车主 ¥20 + 业主信用 -5，证据链可自动归责）
      await c.query(
        `UPDATE preemption_cases SET status='breach_settled', chosen_action='breach_compensation',
           compensation_amount=$1, resolution=$2, resolved_by=$3, resolved_at=now()
         WHERE id=$4`,
        [
          0,
          '业主支付违约补偿立即收回车位：订单按实际可用时长结算，另付车主违约补偿（结算时从分成扣减）',
          user.sub,
          id,
        ],
      );
      if (pcase.reservation_id) {
        const rq = await c.query(`SELECT * FROM reservations WHERE id=$1`, [pcase.reservation_id]);
        const plate = rq.rows[0]?.plate ?? null;
        const ticket = await c.query(
          `INSERT INTO incident_tickets(code, spot_id, reservation_id, type, status, plate, reporter_role, description, detail, created_at)
           VALUES ($1,$2,$3,'owner_return','notified',$4,'owner',$5,$6,$7) RETURNING *`,
          [
            code('T'),
            pcase.spot_id,
            pcase.reservation_id,
            plate,
            '业主提前回家，选择支付违约补偿立即收回车位',
            JSON.stringify({ preemption_case_id: pcase.id, owner_home_at: pcase.occurred_at }),
            pcase.occurred_at,
          ],
        );
        await c.query(
          `INSERT INTO move_notices(ticket_id, target_plate, channel, message, delivered_at)
           VALUES ($1,$2,'app_push',$3, now())`,
          [ticket.rows[0].id, plate ?? '未知车牌', '您的共享车位业主提前回家，请尽快挪车；平台将按实际时长结算并发放违约补偿'],
        );
        // 与既有"业主回家"证据链兼容的事件（申诉裁决可自动归责业主）
        await c.query(
          `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail, occurred_at)
           VALUES ($1,$2,'owner_return_report',$3,'owner',$4,$5,$6)`,
          [
            pcase.reservation_id,
            pcase.spot_id,
            user.sub,
            plate,
            JSON.stringify({ preemption_case_id: pcase.id, breach_compensation: true, owner_home_at: pcase.occurred_at }),
            pcase.occurred_at,
          ],
        );
      }
      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, detail)
         VALUES ($1,$2,'preemption_breach',$3,'owner',$4)`,
        [pcase.reservation_id, pcase.spot_id, user.sub, JSON.stringify({ case_code: pcase.code })],
      );
      return { ok: true, status: 'breach_settled' };
    });
  }

  // 处置完成：等待结束（车主已离场）/ 物业协调完成；物业可判定"按违约收回车位"
  @Roles('property', 'admin', 'owner')
  @Post(':id/resolve')
  async resolve(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() body: { resolution: string; action?: 'close' | 'breach' },
  ) {
    return this.db.withTx(async (c) => {
      const caseQ = await c.query(`SELECT * FROM preemption_cases WHERE id=$1 FOR UPDATE`, [id]);
      const pcase = caseQ.rows[0];
      if (!pcase) throw new BadRequestException('抢占处理单不存在');
      if (user.role === 'owner' && pcase.owner_id !== user.sub) throw new BadRequestException('只能处置本人车位的抢占单');
      if (!OPEN_STATUSES.includes(pcase.status)) throw new BadRequestException('该处理单已完结');

      // 物业协调结论为"收回车位"：转入违约收回链路
      if (body.action === 'breach') {
        if (!['property', 'admin'].includes(user.role)) throw new BadRequestException('仅物业/平台可判定违约收回');
        await c.query(
          `UPDATE preemption_cases SET status='awaiting_owner_choice' WHERE id=$1`,
          [id],
        );
        // 直接代业主执行违约收回（复用 choose 的 breach 分支语义）
        const rq = await c.query(`SELECT * FROM reservations WHERE id=$1`, [pcase.reservation_id]);
        const plate = rq.rows[0]?.plate ?? null;
        await c.query(
          `UPDATE preemption_cases SET status='breach_settled', chosen_action='breach_compensation',
             resolution=$1, resolved_by=$2, resolved_at=now() WHERE id=$3`,
          [`物业协调后判定业主收回车位：${body.resolution}`, user.sub, id],
        );
        if (pcase.reservation_id) {
          const ticket = await c.query(
            `INSERT INTO incident_tickets(code, spot_id, reservation_id, type, status, plate, reporter_role, description, detail, created_at)
             VALUES ($1,$2,$3,'owner_return','notified',$4,'property',$5,$6,$7) RETURNING *`,
            [
              code('T'),
              pcase.spot_id,
              pcase.reservation_id,
              plate,
              `物业协调：业主提前回家收回车位（${body.resolution}）`,
              JSON.stringify({ preemption_case_id: pcase.id, owner_home_at: pcase.occurred_at }),
              pcase.occurred_at,
            ],
          );
          await c.query(
            `INSERT INTO move_notices(ticket_id, target_plate, channel, message, delivered_at)
             VALUES ($1,$2,'app_push',$3, now())`,
            [ticket.rows[0].id, plate ?? '未知车牌', '物业协调结果：业主收回车位，请尽快挪车；平台将按实际时长结算并发放违约补偿'],
          );
          await c.query(
            `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail, occurred_at)
             VALUES ($1,$2,'owner_return_report',$3,'property',$4,$5,$6)`,
            [
              pcase.reservation_id,
              pcase.spot_id,
              user.sub,
              plate,
              JSON.stringify({ preemption_case_id: pcase.id, by: 'property_coordination', owner_home_at: pcase.occurred_at }),
              pcase.occurred_at,
            ],
          );
        }
        return { ok: true, status: 'breach_settled' };
      }

      await c.query(
        `UPDATE preemption_cases SET status='resolved', resolution=$1, resolved_by=$2, resolved_at=now() WHERE id=$3`,
        [body.resolution, user.sub, id],
      );
      // 协调工单同步关闭
      await c.query(
        `UPDATE incident_tickets SET status='resolved', resolution=$1, resolved_by=$2, resolved_at=now()
         WHERE type='owner_preempt' AND detail->>'preemption_case_id'=$3 AND status IN ('open','notified')`,
        [body.resolution, user.sub, String(pcase.id)],
      );
      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, detail)
         VALUES ($1,$2,'preemption_resolved',$3,$4,$5)`,
        [pcase.reservation_id, pcase.spot_id, user.sub, user.role, JSON.stringify({ case_code: pcase.code, resolution: body.resolution })],
      );
      return { ok: true, status: 'resolved' };
    });
  }

  // 业主取消本次提前回家（又不回来了 / 误触）
  @Roles('owner')
  @Post(':id/cancel')
  async cancel(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.db.withTx(async (c) => {
      const caseQ = await c.query(`SELECT * FROM preemption_cases WHERE id=$1 FOR UPDATE`, [id]);
      const pcase = caseQ.rows[0];
      if (!pcase) throw new BadRequestException('抢占处理单不存在');
      if (pcase.owner_id !== user.sub) throw new BadRequestException('只能取消本人车位的抢占单');
      if (!OPEN_STATUSES.includes(pcase.status)) throw new BadRequestException('该处理单已完结，不可取消');
      await c.query(
        `UPDATE preemption_cases SET status='cancelled', resolution='业主取消本次提前回家', resolved_by=$1, resolved_at=now() WHERE id=$2`,
        [user.sub, id],
      );
      await c.query(
        `UPDATE incident_tickets SET status='cancelled', resolved_by=$1, resolved_at=now()
         WHERE type='owner_preempt' AND detail->>'preemption_case_id'=$2 AND status IN ('open','notified')`,
        [user.sub, String(pcase.id)],
      );
      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, detail)
         VALUES ($1,$2,'preemption_cancelled',$3,'owner',$4)`,
        [pcase.reservation_id, pcase.spot_id, user.sub, JSON.stringify({ case_code: pcase.code })],
      );
      return { ok: true, status: 'cancelled' };
    });
  }

  // ---- 附近可替代车位搜索 ----
  private async findAlternatives(c: any, spot: any, reservation: any, now: Date): Promise<any[]> {
    const needCharger = !!spot.near_charger && !!reservation.is_new_energy;
    const cand = await c.query(
      `SELECT s.id, s.code, s.hourly_rate, s.overnight_cap, s.near_charger, s.location_desc,
         (SELECT json_agg(json_build_object('weekday',weekday,'start_time',start_time::text,'end_time',end_time::text))
            FROM spot_share_windows w WHERE w.spot_id=s.id) AS windows
       FROM parking_spots s
       WHERE s.community_id=$1 AND s.id<>$2 AND s.active AND s.review_status='approved'
         AND ($3::boolean IS FALSE OR s.near_charger=true)
         AND ($4::boolean IS FALSE OR s.allow_visitor=true)
       ORDER BY s.hourly_rate ASC, s.id ASC LIMIT 100`,
      [spot.community_id, spot.id, needCharger, !!reservation.is_visitor],
    );
    const end = new Date(reservation.end_at);
    const out: any[] = [];
    for (const s of cand.rows) {
      const windows: ShareWindow[] = (s.windows ?? []).map((w: any) => ({
        weekday: Number(w.weekday),
        start_time: w.start_time,
        end_time: w.end_time,
      }));
      // 共享窗必须覆盖剩余停车时段
      if (!isIntervalCovered(now, end, windows)) continue;
      // 剩余时段内不得与既有预约冲突
      const conflict = await c.query(
        `SELECT 1 FROM reservations WHERE spot_id=$1 AND status IN ('reserved','admitted','in_garage')
           AND start_at < $2 AND $3 < end_at LIMIT 1`,
        [s.id, end, now],
      );
      if (conflict.rowCount && conflict.rowCount > 0) continue;
      out.push({
        id: s.id,
        code: s.code,
        hourly_rate: Number(s.hourly_rate),
        overnight_cap: s.overnight_cap != null ? Number(s.overnight_cap) : null,
        near_charger: s.near_charger,
        location_desc: s.location_desc,
      });
      if (out.length >= 3) break;
    }
    return out;
  }

  // ---- 业主历史提前结束次数：抢占单（非取消）+ 未关联抢占单的历史 owner_return 工单 ----
  private async countOwnerEarlyReturns(c: any, ownerId: number): Promise<number> {
    const q = await c.query(
      `SELECT
         (SELECT count(*) FROM preemption_cases p WHERE p.owner_id=$1 AND p.status<>'cancelled') AS cases,
         (SELECT count(*) FROM incident_tickets i JOIN parking_spots s ON s.id=i.spot_id
           WHERE s.owner_id=$1 AND i.type='owner_return' AND NOT (i.detail ? 'preemption_case_id')) AS legacy`,
      [ownerId],
    );
    return Number(q.rows[0].cases) + Number(q.rows[0].legacy);
  }

  private buildRelocationGuidance(fromCode: string | undefined, target: any) {
    return {
      from_spot: fromCode ?? null,
      to_spot: target.code,
      steps: [
        `请从当前车位${fromCode ? ` ${fromCode}` : ''} 驶出，沿地库主通道行驶`,
        target.location_desc ? `按标识前往新预约车位：${target.location_desc}` : `按标识前往车位 ${target.code}`,
        target.near_charger ? '新车位靠近充电桩，可继续充电服务' : '新车位为普通车位，减速倒车入位',
        '入位后请在 App 点击"我已停好"完成停放确认，原预约时段与价格不变',
      ],
      voice: `业主提前回家，平台已为您免费换位至 ${target.code}，原预约时段与价格不变，另有补偿到账`,
    };
  }
}
