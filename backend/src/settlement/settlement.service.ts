import { BadRequestException, Injectable } from '@nestjs/common';
import { DbService } from '../database/db.service';
import { Ruling, settlePrice, SettlementBreakdown } from '../domain/pricing';

export interface CompleteSettlementOptions {
  exitAt?: Date;
  chargeKwh?: number;
  forcedRuling?: Ruling | null;
  appealId?: number;
  relocationCompensation?: number; // 业主提前回家成功换位时的换位费用补偿
  actorId?: number | null;
  actorRole?: string;
  recompute?: boolean; // 终裁重算：订单已是 completed，跳过状态流转（调用方负责冲销旧结算）
}

@Injectable()
export class SettlementService {
  constructor(private db: DbService) {}

  /**
   * 完成一笔预约的离场结算：更新订单状态 → 计费分账 → 落结算单/流水 → 信用调整 → 事件流。
   * 必须在调用方的事务 client 内执行（离场、换位、违约补偿、终裁重算共用）。
   */
  async completeSettlement(client: any, reservationId: number | string, opts: CompleteSettlementOptions = {}) {
    const rq = await client.query(
      `SELECT r.*, s.hourly_rate, s.overnight_cap, s.near_charger, s.owner_id,
              v.is_new_energy, v.plate AS vplate
       FROM reservations r
       JOIN parking_spots s ON s.id=r.spot_id
       JOIN vehicles v ON v.id=r.vehicle_id
       WHERE r.id=$1 FOR UPDATE`,
      [reservationId],
    );
    const r = rq.rows[0];
    if (!r) throw new BadRequestException('预约不存在');
    if (!opts.recompute && ['completed', 'cancelled'].includes(r.status)) throw new BadRequestException('订单已结束');

    const exitAt = opts.exitAt ?? new Date();
    await client.query(
      `UPDATE reservations SET status='completed',
         gate_exit_at=COALESCE($2::timestamptz, gate_exit_at, now()) WHERE id=$1`,
      [r.id, exitAt],
    );

    const breakdown = await this.computeBreakdown(client, r, exitAt, opts.chargeKwh ?? 0, opts.forcedRuling ?? null, opts.appealId, {
      relocationCompensation: opts.relocationCompensation,
    });
    const settlement = await this.persistSettlement(client, r, exitAt, breakdown, opts.appealId, opts.forcedRuling ?? breakdown.ruling);

    if (breakdown.creditTarget !== 'none' && breakdown.creditDelta !== 0) {
      const targetId =
        breakdown.creditTarget === 'owner'
          ? r.owner_id
          : breakdown.creditTarget === 'property'
            ? null
            : r.driver_id;
      if (targetId) {
        await client.query(`UPDATE users SET credit_score=GREATEST(0, credit_score + $1) WHERE id=$2`, [
          breakdown.creditDelta,
          targetId,
        ]);
      }
      await client.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_role, detail)
         VALUES ($1,$2,'credit_adjusted',$3,$4)`,
        [
          r.id,
          r.spot_id,
          opts.actorRole ?? 'system',
          JSON.stringify({ target: breakdown.creditTarget, delta: breakdown.creditDelta }),
        ],
      );
    }

    await client.query(
      `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
       VALUES ($1,$2,'settlement_completed',$3,$4,$5,$6)`,
      [
        r.id,
        r.spot_id,
        opts.actorId ?? null,
        opts.actorRole ?? 'system',
        r.plate,
        JSON.stringify({
          payable: breakdown.payable,
          refund: breakdown.refund,
          exit_charge: breakdown.exitCharge,
          relocation_compensation: opts.relocationCompensation ?? 0,
        }),
      ],
    );

    return settlement;
  }

  // ---- 组装分账输入 ----
  async computeBreakdown(
    client: any,
    r: any,
    exitAt: Date,
    chargeKwh: number,
    forcedRuling?: Ruling | null,
    appealId?: number,
    extra: { relocationCompensation?: number } = {},
  ): Promise<SettlementBreakdown> {
    // 该笔服务关联的异常（业主上报回家后若最终选择等待/取消，则共享实际未中断，不计为有效回家事件）
    const iq = await client.query(
      `SELECT i.type, i.created_at, i.resolved_at, i.detail FROM incident_tickets i
       WHERE i.reservation_id=$1
         AND NOT (i.type='owner_return' AND EXISTS (
           SELECT 1 FROM owner_return_records rr
           WHERE rr.ticket_id=i.id AND rr.resolution IN ('owner_wait','cancelled')))
       ORDER BY i.created_at`,
      [r.id],
    );
    const incidents = iq.rows.map((i: any) => ({
      type: i.type,
      started_at: i.created_at,
      resolved_at: i.resolved_at,
      detail: i.detail ?? {},
    }));

    // 申诉裁决（优先使用传入的终裁，其次取已关闭申诉）
    let ruling: Ruling | null = forcedRuling ?? null;
    if (!ruling) {
      const aq = await client.query(
        `SELECT ruling FROM appeals WHERE reservation_id=$1 AND status='closed' ORDER BY ruled_at DESC NULLS LAST LIMIT 1`,
        [r.id],
      );
      ruling = aq.rows[0]?.ruling ?? null;
    }

    // 优惠券抵扣（预约时已核销，这里从 coupon 关联反查）
    const cq = await client.query(
      `SELECT COALESCE(SUM(amount),0) AS amount FROM coupons WHERE used_reservation_id=$1`,
      [r.id],
    );
    const couponAmount = Number(cq.rows[0].amount);

    // usable_from：若存在陌生车占用，为占用解除时间；否则入场/停车确认时间
    let usableFrom = r.parking_confirmed_at ?? r.gate_entry_at ?? r.start_at;
    const stranger = iq.rows.find((i: any) => ['stranger_occupy', 'ice_occupy_charger'].includes(i.type));
    if (stranger?.resolved_at && new Date(stranger.resolved_at) > new Date(usableFrom)) {
      usableFrom = stranger.resolved_at;
    }

    // 充电量结算优先使用已持久化的值（重算场景）
    let kwh = chargeKwh;
    if (!kwh) {
      const detail = await client.query(
        `SELECT detail FROM service_events WHERE reservation_id=$1 AND type='charging_session' ORDER BY id DESC LIMIT 1`,
        [r.id],
      );
      kwh = Number(detail.rows[0]?.detail?.kwh ?? 0);
    }

    return settlePrice({
      reservedStart: r.start_at,
      reservedEnd: r.end_at,
      actualEntry: r.gate_entry_at ?? r.start_at,
      actualExit: exitAt,
      usableFrom,
      hourlyRate: Number(r.hourly_rate),
      overnightCap: r.overnight_cap != null ? Number(r.overnight_cap) : null,
      isNewEnergy: r.is_new_energy,
      chargeKwh: kwh,
      incidents,
      ruling,
      couponAmount,
      prepaid: Number(r.estimated_fee && couponAmount ? Math.max(0, Number(r.estimated_fee) - couponAmount) : (r.estimated_fee ?? 0)),
      relocationCompensation: extra.relocationCompensation,
    });
  }

  async persistSettlement(
    c: any,
    r: any,
    exitAt: Date,
    b: SettlementBreakdown,
    appealId?: number,
    ruling?: Ruling | null,
  ) {
    const code = 'ST' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000).toString(36).toUpperCase();
    const ins = await c.query(
      `INSERT INTO settlements(code, reservation_id, spot_id, actual_entry_at, actual_exit_at, usable_from,
         duration_minutes, base_fee, charging_fee, overtime_fee, wrong_park_fine,
         coupon_discount, abnormal_compensation, coupon_compensation, owner_compensation, prepaid, refund, exit_charge, payable,
         owner_income, property_fee, platform_fee, owner_share, property_share, platform_share,
         credit_target, credit_delta, appeal_id, ruling, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
       RETURNING *`,
      [
        code, r.id, r.spot_id, b.actualEntryAt, b.actualExitAt, b.usableFrom,
        b.durationMinutes, b.baseFee, b.chargingFee, b.overtimeFee, b.wrongParkFine,
        b.couponDiscount, b.abnormalCompensation, b.couponCompensation, b.ownerCompensation, b.prepaid, b.refund, b.exitCharge, b.payable,
        b.ownerIncome, b.propertyFee, b.platformFee, b.ownerShare, b.propertyShare, b.platformShare,
        b.creditTarget, b.creditDelta, appealId ?? null, ruling ?? b.ruling,
        JSON.stringify({ notes: b.notes }),
      ],
    );
    const settlement = ins.rows[0];
    await c.query(`UPDATE reservations SET settled_at=now(), settlement_id=$1 WHERE id=$2`, [
      settlement.id,
      r.id,
    ]);
    for (const e of b.ledger) {
      await c.query(
        `INSERT INTO ledger_entries(settlement_id, account, direction, amount, memo)
         VALUES ($1,$2,$3,$4,$5)`,
        [settlement.id, e.account === 'owner' ? `owner:${r.owner_id}` : e.account, e.direction, e.amount, e.memo],
      );
    }
    const ledger = await c.query(`SELECT * FROM ledger_entries WHERE settlement_id=$1 ORDER BY id`, [settlement.id]);
    return { ...settlement, ledger: ledger.rows, notes: b.notes };
  }
}
