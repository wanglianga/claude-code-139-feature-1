import { BadRequestException, Injectable } from '@nestjs/common';
import { DbService } from '../database/db.service';
import { estimateFee, ShareWindow } from '../domain/availability';
import {
  assessReservation,
  buildRelocationNavigation,
  evaluateReturnRisk,
  findRelocationCandidates,
  relocationTopupFee,
  RELOCATION,
  RISK_LABEL,
  CandidateSpot,
} from '../domain/ownerReturn';
import { SettlementService } from '../settlement/settlement.service';

function genCode(prefix: string) {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4)
    .toString(36)
    .toUpperCase()}`;
}

@Injectable()
export class DispatchService {
  constructor(
    private db: DbService,
    private settlement: SettlementService,
  ) {}

  /**
   * 业主提前回家：平台先评估在场状态/剩余时长/历史次数与风险，
   * 再匹配附近可替代车位并下发换位导航与费用补偿；无法替换时交由业主三选一。
   */
  async ownerReturn(
    user: { sub: number; role: string },
    body: { spot_id: number; eta_minutes?: number; note?: string; occurred_at?: string },
  ) {
    const now = body.occurred_at ? new Date(body.occurred_at) : new Date();
    return this.db.withTx(async (c) => {
      const sq = await c.query(
        `SELECT s.*, c.name AS community_name FROM parking_spots s
         JOIN communities c ON c.id=s.community_id
         WHERE s.id=$1 AND s.owner_id=$2 FOR UPDATE`,
        [body.spot_id, user.sub],
      );
      const spot = sq.rows[0];
      if (!spot) throw new BadRequestException('车位不存在或不属于本人');

      const aq = await c.query(
        `SELECT r.*, v.is_new_energy, v.is_visitor, v.is_monthly
         FROM reservations r JOIN vehicles v ON v.id=r.vehicle_id
         WHERE r.spot_id=$1 AND r.status IN ('reserved','admitted','in_garage')
         ORDER BY r.start_at ASC LIMIT 1 FOR UPDATE OF r`,
        [body.spot_id],
      );
      const active = aq.rows[0];

      // 同一车位存在未结案的业主回家记录时不重复抢占
      if (active) {
        const dup = await c.query(
          `SELECT id FROM owner_return_records
           WHERE reservation_id=$1 AND resolution IN ('pending','property_coordinating')
           LIMIT 1`,
          [active.id],
        );
        if (dup.rows[0]) throw new BadRequestException('该车位已有进行中的提前回家处理，请先完成处置');
      }

      // 1) 评估：是否已入场、剩余停车时长
      const assessment = active
        ? assessReservation(
            {
              id: active.id,
              code: active.code,
              spotId: active.spot_id,
              plate: active.plate,
              status: active.status,
              startAt: active.start_at,
              endAt: active.end_at,
              gateEntryAt: active.gate_entry_at,
              parkingConfirmedAt: active.parking_confirmed_at,
              isNewEnergy: active.is_new_energy,
              isVisitor: active.is_visitor,
              isMonthly: active.is_monthly,
            },
            now,
          )
        : null;

      // 2) 业主历史提前结束次数（90 天内，含本次）
      const hq = await c.query(
        `SELECT COUNT(*)::int AS n FROM owner_return_records
         WHERE owner_id=$1 AND created_at > now() - interval '${RELOCATION.historyWindowDays} days'
           AND resolution NOT IN ('cancelled','owner_wait')`,
        [user.sub],
      );
      const historyCountBefore = Number(hq.rows[0].n);
      const sharedEnd = active ? new Date(active.end_at) : now;
      const earlyMinutes = active ? Math.max(0, Math.round((sharedEnd.getTime() - now.getTime()) / 60000)) : 0;
      // 风险按"含本次"的累计提前结束次数评估
      const riskLevel = evaluateReturnRisk(historyCountBefore + 1, earlyMinutes);

      // 3) 开工单 + 事件流（与既有夜间调度看板打通）
      const ins = await c.query(
        `INSERT INTO incident_tickets(code, spot_id, reservation_id, type, status, plate, reporter_role, description, detail, created_at)
         VALUES ($1,$2,$3,'owner_return','open',$4,'owner',$5,$6,$7) RETURNING *`,
        [
          genCode('T'),
          body.spot_id,
          active?.id ?? null,
          active?.plate ?? null,
          body.note ?? `业主预计 ${body.eta_minutes ?? 30} 分钟后回家，申请提前收回共享车位`,
          JSON.stringify({
            eta_minutes: body.eta_minutes ?? 30,
            owner_home_at: now,
            car_on_site: assessment?.carOnSite ?? false,
            remaining_minutes: assessment?.remainingMinutes ?? 0,
            risk_level: riskLevel,
            early_termination_count: historyCountBefore + 1,
          }),
          now,
        ],
      );
      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail, occurred_at)
         VALUES ($1,$2,'owner_return_report',$3,'owner',$4,$5,$6)`,
        [
          active?.id ?? null,
          body.spot_id,
          user.sub,
          active?.plate ?? null,
          JSON.stringify({
            eta_minutes: body.eta_minutes ?? 30,
            owner_home_at: now,
            risk_level: riskLevel,
            history_count: historyCountBefore + 1,
          }),
          now,
        ],
      );

      // 4) 写入业主提前结束发布记录
      const rq2 = await c.query(
        `INSERT INTO owner_return_records(code, owner_id, spot_id, reservation_id, ticket_id,
           shared_end_at, reported_at, early_minutes, car_on_site, remaining_minutes,
           early_termination_count, risk_level, resolution, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13) RETURNING *`,
        [
          genCode('OR'),
          user.sub,
          body.spot_id,
          active?.id ?? null,
          ins.rows[0].id,
          sharedEnd,
          now,
          earlyMinutes,
          assessment?.carOnSite ?? false,
          assessment?.remainingMinutes ?? 0,
          historyCountBefore + 1,
          riskLevel,
          JSON.stringify({ eta_minutes: body.eta_minutes ?? 30, note: body.note ?? null }),
        ],
      );
      const record = rq2.rows[0];

      // 5) 匹配附近可替代车位（仅在存在受影响预约时）
      let candidates: any[] = [];
      let rejected: Array<{ code: string; reason: string }> = [];
      if (active) {
        const pool = await c.query(
          `SELECT s.*,
             (SELECT json_agg(json_build_object('weekday',weekday,'start_time',start_time::text,'end_time',end_time::text))
                FROM spot_share_windows w WHERE w.spot_id=s.id) AS windows
           FROM parking_spots s
           WHERE s.community_id=$1 AND s.active AND s.review_status='approved' AND s.id <> $2`,
          [spot.community_id, body.spot_id],
        );
        // 各候选车位在换位窗口内的占用区间（一次性按候选集合查出，下方逐个挂接）
        const candidateSpots: CandidateSpot[] = pool.rows.map((s: any) => {
          const windows: ShareWindow[] = (s.windows ?? []).map((w: any) => ({
            weekday: Number(w.weekday),
            start_time: w.start_time,
            end_time: w.end_time,
          }));
          return {
            id: Number(s.id),
            code: s.code,
            communityId: Number(s.community_id),
            originSpotId: body.spot_id,
            locationDesc: s.location_desc,
            nearCharger: s.near_charger,
            chargerPowerKw: s.charger_power_kw != null ? Number(s.charger_power_kw) : null,
            allowVisitor: s.allow_visitor,
            monthlyPriority: s.monthly_priority,
            hourlyRate: Number(s.hourly_rate),
            overnightCap: s.overnight_cap != null ? Number(s.overnight_cap) : null,
            reviewStatus: s.review_status,
            active: s.active,
            windows,
            busyRanges: [],
          };
        });
        const busyAll = await c.query(
          `SELECT spot_id, start_at, end_at FROM reservations
           WHERE status IN ('reserved','admitted','in_garage')
             AND spot_id = ANY($1::bigint[])
             AND start_at < $2 AND $3 < end_at`,
          [candidateSpots.map((x) => x.id), active.end_at, now],
        );
        for (const cs of candidateSpots) {
          cs.busyRanges = busyAll.rows
            .filter((b: any) => Number(b.spot_id) === cs.id)
            .map((b: any) => ({ start: b.start_at, end: b.end_at }));
        }

        const result = findRelocationCandidates(
          candidateSpots,
          {
            isNewEnergy: active.is_new_energy,
            needCharger: !!spot.near_charger && active.is_new_energy,
            isVisitor: active.is_visitor,
            isMonthly: active.is_monthly,
            originHourlyRate: Number(spot.hourly_rate),
            originCode: spot.code,
            originLocationDesc: spot.location_desc,
          },
          { start: now, end: new Date(active.end_at) },
        );
        rejected = result.rejected;

        for (const m of result.feasible) {
          const navigation = buildRelocationNavigation({
            originCode: spot.code,
            targetCode: m.candidate.code,
            targetLocationDesc: m.candidate.locationDesc,
            targetNearCharger: m.candidate.nearCharger,
            distanceM: m.distanceM,
            plate: active.plate,
            communityName: spot.community_name,
          });
          const oi = await c.query(
            `INSERT INTO relocation_offers(code, record_id, reservation_id, spot_id, from_at, to_at,
               distance_m, match_score, fee_compensation, status, navigation)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'offered',$10) RETURNING *`,
            [
              genCode('MV'),
              record.id,
              active.id,
              m.candidate.id,
              now,
              active.end_at,
              m.distanceM,
              m.matchScore,
              RELOCATION.feeCompensation,
              JSON.stringify({ ...navigation, score_reasons: m.scoreReasons }),
            ],
          );
          candidates.push({
            offer_id: oi.rows[0].id,
            offer_code: oi.rows[0].code,
            spot_id: m.candidate.id,
            spot_code: m.candidate.code,
            location_desc: m.candidate.locationDesc,
            near_charger: m.candidate.nearCharger,
            charger_power_kw: m.candidate.chargerPowerKw,
            hourly_rate: m.candidate.hourlyRate,
            overnight_cap: m.candidate.overnightCap,
            distance_m: m.distanceM,
            match_score: m.matchScore,
            score_reasons: m.scoreReasons,
            fee_compensation: RELOCATION.feeCompensation,
            topup_fee_estimate: relocationTopupFee({ start: now, end: new Date(active.end_at) }, m.candidate),
            navigation,
          });
        }
      }

      // 6) 通知在场车主；无受影响预约则业主直接自用，工单/记录直接结案
      if (active) {
        const message = candidates.length
          ? `业主临时回家，平台已为您匹配 ${candidates.length} 个附近替代车位，接受换位可获 ¥${RELOCATION.feeCompensation} 费用补偿与换位导航，${RELOCATION.acceptWindowMinutes} 分钟内有效`
          : '您的共享车位业主临时回家，暂未匹配到替代车位，平台正为您协调；业主可等待、支付违约补偿或申请物业协调';
        await c.query(
          `INSERT INTO move_notices(ticket_id, target_plate, channel, message, delivered_at)
           VALUES ($1,$2,'app_push',$3, now())`,
          [ins.rows[0].id, active.plate, message],
        );
        await c.query(`UPDATE incident_tickets SET status='notified' WHERE id=$1`, [ins.rows[0].id]);
      } else {
        await c.query(
          `UPDATE incident_tickets SET status='resolved', resolution='当前无进行中预约，业主直接自用', resolved_by=$2, resolved_at=$3
           WHERE id=$1`,
          [ins.rows[0].id, user.sub, now],
        );
        await c.query(
          `UPDATE owner_return_records SET resolution='cancelled',
             detail=jsonb_set(COALESCE(detail,'{}'::jsonb), '{outcome}', $2::jsonb) WHERE id=$1`,
          [record.id, JSON.stringify({ outcome: 'no_active_reservation_owner_self_use' })],
        );
      }

      return {
        ok: true,
        ticket: (await c.query(`SELECT * FROM incident_tickets WHERE id=$1`, [ins.rows[0].id])).rows[0],
        record: {
          id: record.id,
          code: record.code,
          risk_level: record.risk_level,
          risk_label: RISK_LABEL[riskLevel as keyof typeof RISK_LABEL],
          early_termination_count: record.early_termination_count,
          early_minutes: record.early_minutes,
          resolution: record.resolution,
        },
        reservation_id: active?.id ?? null,
        assessment: assessment
          ? {
              car_on_site: assessment.carOnSite,
              admitted: assessment.admitted,
              parked: assessment.parked,
              elapsed_minutes: assessment.elapsedMinutes,
              remaining_minutes: assessment.remainingMinutes,
              reserved_window_minutes: assessment.reservedWindowMinutes,
            }
          : null,
        risk: {
          level: riskLevel,
          label: RISK_LABEL[riskLevel],
          history_window_days: RELOCATION.historyWindowDays,
          early_termination_count: historyCountBefore + 1,
        },
        can_replace: candidates.length > 0,
        candidates,
        rejected,
        alternatives: candidates.length
          ? ['driver_accept_relocation']
          : ['owner_wait', 'breach_pay', 'property_coordination'],
      };
    });
  }

  /** 车主：查看发给自己的换位方案 */
  async listMyRelocations(userId: number) {
    const { rows } = await this.db.query(
      `SELECT o.*, rr.code AS record_code, rr.risk_level, rr.resolution AS record_resolution,
              s.code AS spot_code, s.location_desc, c.name AS community_name,
              os.code AS origin_spot_code, r.code AS reservation_code, r.plate,
              nr.id AS new_reservation_id, nr.code AS new_reservation_code, nr.spot_id AS new_spot_id,
              ns.code AS new_spot_code
       FROM relocation_offers o
       JOIN owner_return_records rr ON rr.id=o.record_id
       JOIN reservations r ON r.id=o.reservation_id
       JOIN parking_spots s ON s.id=o.spot_id
       JOIN parking_spots os ON os.id=rr.spot_id
       JOIN communities c ON c.id=s.community_id
       LEFT JOIN reservations nr ON nr.id=o.new_reservation_id
       LEFT JOIN parking_spots ns ON ns.id=nr.spot_id
       WHERE r.driver_id=$1
       ORDER BY o.id DESC LIMIT 50`,
      [userId],
    );
    return rows.map((o) => ({
      ...o,
      navigation: typeof o.navigation === 'string' ? JSON.parse(o.navigation) : o.navigation,
    }));
  }

  /** 车主接受/拒绝换位 */
  async respondRelocation(
    user: { sub: number; role: string },
    offerId: number,
    body: { accept: boolean; relocate_at?: string; reason?: string },
  ) {
    return this.db.withTx(async (c) => {
      const oq = await c.query(
        `SELECT o.*, r.driver_id, r.plate, r.status AS res_status, rr.resolution AS record_resolution,
                rr.ticket_id, rr.owner_id, rr.spot_id AS origin_spot_id
         FROM relocation_offers o
         JOIN reservations r ON r.id=o.reservation_id
         JOIN owner_return_records rr ON rr.id=o.record_id
         WHERE o.id=$1 FOR UPDATE OF o`,
        [offerId],
      );
      const offer = oq.rows[0];
      if (!offer) throw new BadRequestException('换位方案不存在');
      if (offer.driver_id !== user.sub) throw new BadRequestException('该换位方案不属于本人');
      if (offer.status !== 'offered') throw new BadRequestException('该换位方案已失效或已处理');
      if (!['reserved', 'admitted', 'in_garage'].includes(offer.res_status))
        throw new BadRequestException('原预约已结束，不能换位');

      const at = body.relocate_at ? new Date(body.relocate_at) : new Date();

      if (!body.accept) {
        await c.query(`UPDATE relocation_offers SET status='declined', driver_response_at=$2 WHERE id=$1`, [offerId, at]);
        await c.query(
          `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
           VALUES ($1,$2,'relocation_declined',$3,'driver',$4,$5)`,
          [
            offer.reservation_id,
            offer.spot_id,
            user.sub,
            offer.plate,
            JSON.stringify({ offer_id: offerId, reason: body.reason ?? null }),
          ],
        );
        // 该记录全部方案均被拒绝 → 回退给业主三选一
        const left = await c.query(
          `SELECT COUNT(*)::int AS n FROM relocation_offers WHERE record_id=$1 AND status='offered'`,
          [offer.record_id],
        );
        if (Number(left.rows[0].n) === 0) {
          await c.query(
            `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
             VALUES ($1,$2,'relocation_all_declined',$3,'driver',$4,$5)`,
            [offer.reservation_id, offer.origin_spot_id, user.sub, offer.plate, JSON.stringify({ record_id: offer.record_id })],
          );
        }
        return { ok: true, accepted: false };
      }

      const result = await this.executeRelocation(c, offer, at, { id: user.sub, role: 'driver' });
      return { ok: true, accepted: true, ...result };
    });
  }

  /**
   * 执行换位：校验目标车位仍可用 → 创建新预约（附补差券）→
   * 原单按实际可用时长结算（业主付换位费用补偿）→ 记录/工单结案。
   */
  private async executeRelocation(client: any, offer: any, at: Date, actor: { id: number | null; role: string }) {
    const orig = await client.query(
      `SELECT r.*, v.id AS vehicle_id, v.is_new_energy, v.is_visitor, v.is_monthly
       FROM reservations r JOIN vehicles v ON v.id=r.vehicle_id
       WHERE r.id=$1 FOR UPDATE`,
      [offer.reservation_id],
    );
    const origin = orig.rows[0];
    if (!origin) throw new BadRequestException('原预约不存在');
    if (new Date(offer.to_at) <= at) throw new BadRequestException('换位窗口已过，请改约或联系物业');

    // 目标车位仍审核通过、在共享窗口内、无时间冲突
    const ts = await client.query(`SELECT * FROM parking_spots WHERE id=$1 FOR UPDATE`, [offer.spot_id]);
    const target = ts.rows[0];
    if (!target || target.review_status !== 'approved' || !target.active)
      throw new BadRequestException('替代车位已不可用，请选择其他方案或联系物业');
    if (target.near_charger && !origin.is_new_energy)
      throw new BadRequestException('替代车位为充电车位，燃油车辆不可停放');

    const conflict = await client.query(
      `SELECT id FROM reservations
       WHERE spot_id=$1 AND status IN ('reserved','admitted','in_garage')
         AND start_at < $2 AND $3 < end_at`,
      [offer.spot_id, offer.to_at, at],
    );
    if (conflict.rowCount) throw new BadRequestException('替代车位刚被预约，请选择其他方案或联系物业');

    // 1) 原单立即按实际可用时长结算（业主责任 + 换位补偿）
    const oldSettlement = await this.settlement.completeSettlement(client, origin.id, {
      exitAt: at,
      chargeKwh: 0,
      forcedRuling: 'owner_fault',
      relocationCompensation: Number(offer.fee_compensation),
      actorId: actor.id,
      actorRole: actor.role,
    });

    // 2) 创建替代车位新预约（同车主同车辆，入场状态延续，无需再过道闸）
    const fee = estimateFee(at, new Date(offer.to_at), Number(target.hourly_rate), target.overnight_cap ? Number(target.overnight_cap) : null);
    const ni = await client.query(
      `INSERT INTO reservations(code, spot_id, driver_id, vehicle_id, plate, start_at, end_at,
         status, priority, estimated_fee, gate_entry_at, relocated_from_reservation_id, relocation_offer_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'admitted',$8,$9,$10,$11,$12) RETURNING *`,
      [
        genCode('R'),
        target.id,
        origin.driver_id,
        origin.vehicle_id,
        origin.plate,
        at,
        offer.to_at,
        origin.priority,
        fee,
        at,
        origin.id,
        offer.id,
      ],
    );
    const newRes = ni.rows[0];

    // 3) 换位补差券：自动核销到新预约，保证车主不因换位多付停车费
    const topup = relocationTopupFee({ start: at, end: new Date(offer.to_at) }, {
      hourlyRate: Number(target.hourly_rate),
      overnightCap: target.overnight_cap != null ? Number(target.overnight_cap) : null,
    } as any);
    if (topup > 0) {
      const cp = await client.query(
        `INSERT INTO coupons(user_id, code, amount, used_reservation_id, used_at)
         VALUES ($1,$2,$3,$4, now()) RETURNING *`,
        [origin.driver_id, genCode('MVCPN'), topup, newRes.id],
      );
      await client.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
         VALUES ($1,$2,'relocation_topup_coupon',$3,$4,$5,$6)`,
        [
          newRes.id,
          target.id,
          actor.id,
          actor.role,
          origin.plate,
          JSON.stringify({ coupon_id: cp.rows[0].id, amount: topup, from_reservation_id: origin.id, offer_id: offer.id }),
        ],
      );
    }

    // 4) offer / 同批其他方案 / 记录 / 工单 / 协调请求结案
    await client.query(
      `UPDATE relocation_offers SET status='accepted', driver_response_at=$2, new_reservation_id=$3 WHERE id=$1`,
      [offer.id, at, newRes.id],
    );
    await client.query(`UPDATE relocation_offers SET status='expired' WHERE record_id=$1 AND id<>$2 AND status='offered'`, [
      offer.record_id,
      offer.id,
    ]);
    await client.query(
      `UPDATE owner_return_records SET resolution=$2, detail=jsonb_set(COALESCE(detail,'{}'::jsonb), '{outcome}', $3::jsonb)
       WHERE id=$1`,
      [
        offer.record_id,
        actor.role === 'property' ? 'coordinated' : 'relocated',
        JSON.stringify({
          relocated_to: target.code,
          new_reservation_id: newRes.id,
          fee_compensation: Number(offer.fee_compensation),
          topup_coupon: topup,
          by: actor.role,
        }),
      ],
    );
    await client.query(
      `UPDATE incident_tickets SET status='resolved', resolution=$2, resolved_by=$3, resolved_at=$4 WHERE id=$1`,
      [
        offer.ticket_id,
        `车主接受换位导航至 ${target.code}，原单按实际时长结算，费用补偿 ¥${offer.fee_compensation} 随退款发放，补差券 ¥${topup}`,
        actor.id,
        at,
      ],
    );
    await client.query(
      `UPDATE coordination_requests SET status='cancelled', result='车主已通过其他方案换位' WHERE record_id=$1 AND status IN ('pending','coordinating')`,
      [offer.record_id],
    );
    await client.query(
      `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
       VALUES ($1,$2,'relocation_completed',$3,$4,$5,$6)`,
      [
        newRes.id,
        target.id,
        actor.id,
        actor.role,
        origin.plate,
        JSON.stringify({
          origin_spot_id: offer.origin_spot_id,
          origin_reservation_id: origin.id,
          target_spot: target.code,
          new_reservation_id: newRes.id,
          fee_compensation: Number(offer.fee_compensation),
          topup_coupon: topup,
        }),
      ],
    );

    return {
      origin_settlement: oldSettlement,
      new_reservation: newRes,
      topup_coupon: topup,
      navigation: typeof offer.navigation === 'string' ? JSON.parse(offer.navigation) : offer.navigation,
    };
  }

  /** 业主在无法替换（或方案被拒）时三选一：等待 / 支付违约补偿 / 申请物业协调 */
  async ownerDecision(
    user: { sub: number; role: string },
    recordId: number,
    body: { action: 'owner_wait' | 'breach_pay' | 'property_coordination'; note?: string; decided_at?: string },
  ) {
    const at = body.decided_at ? new Date(body.decided_at) : new Date();
    return this.db.withTx(async (c) => {
      const rq = await c.query(`SELECT * FROM owner_return_records WHERE id=$1 FOR UPDATE`, [recordId]);
      const record = rq.rows[0];
      if (!record) throw new BadRequestException('提前结束记录不存在');
      if (record.owner_id !== user.sub) throw new BadRequestException('只能处置本人的提前回家记录');
      if (record.resolution !== 'pending') throw new BadRequestException(`当前记录状态为 ${record.resolution}，不能再选择处置方式`);

      // 待响应换位方案存在时不能直接走兜底选项
      const openOffer = await c.query(
        `SELECT id FROM relocation_offers WHERE record_id=$1 AND status='offered' LIMIT 1`,
        [recordId],
      );
      if (openOffer.rows[0] && body.action !== 'owner_wait')
        throw new BadRequestException('仍有换位方案等待车主响应，请先等待其选择或方案失效');

      if (body.action === 'owner_wait') {
        await c.query(`UPDATE owner_return_records SET resolution='owner_wait' WHERE id=$1`, [recordId]);
        await c.query(
          `UPDATE incident_tickets SET status='resolved', resolution=$2, resolved_by=$3, resolved_at=$4 WHERE id=$1`,
          [record.ticket_id, '业主选择等待，车主继续使用至预约结束，本次不提前收回', user.sub, at],
        );
        await c.query(`UPDATE relocation_offers SET status='expired' WHERE record_id=$1 AND status='offered'`, [recordId]);
        await c.query(
          `UPDATE coordination_requests SET status='cancelled', result='业主选择等待' WHERE record_id=$1 AND status IN ('pending','coordinating')`,
          [recordId],
        );
        await this.recordEvent(c, record, 'owner_return_wait', user.sub, user.role, { note: body.note ?? null });
        return { ok: true, resolution: 'owner_wait' };
      }

      if (body.action === 'breach_pay') {
        if (!record.reservation_id) throw new BadRequestException('当前没有受影响的预约车辆');
        const settlement = await this.settlement.completeSettlement(c, record.reservation_id, {
          exitAt: at,
          chargeKwh: 0,
          forcedRuling: 'owner_fault',
          actorId: user.sub,
          actorRole: user.role,
        });
        await c.query(
          `UPDATE owner_return_records SET resolution='breach_paid',
             detail=jsonb_set(COALESCE(detail,'{}'::jsonb), '{outcome}', $2::jsonb) WHERE id=$1`,
          [recordId, JSON.stringify({ breach_compensation: 20, settlement_code: settlement.code, note: body.note ?? null })],
        );
        await c.query(
          `UPDATE incident_tickets SET status='resolved', resolution=$2, resolved_by=$3, resolved_at=$4 WHERE id=$1`,
          [record.ticket_id, '业主支付违约补偿强制收回车位，补偿随退款发放给车主', user.sub, at],
        );
        await c.query(`UPDATE relocation_offers SET status='expired' WHERE record_id=$1 AND status='offered'`, [recordId]);
        await this.recordEvent(c, record, 'owner_return_breach_paid', user.sub, user.role, { settlement_code: settlement.code });
        return { ok: true, resolution: 'breach_paid', settlement };
      }

      // property_coordination
      const exist = await c.query(
        `SELECT id FROM coordination_requests WHERE record_id=$1 AND status IN ('pending','coordinating')`,
        [recordId],
      );
      if (exist.rows[0]) throw new BadRequestException('已提交物业协调，请等待处置');
      const ci = await c.query(
        `INSERT INTO coordination_requests(code, record_id, spot_id, reservation_id, status, note)
         VALUES ($1,$2,$3,$4,'pending',$5) RETURNING *`,
        [genCode('CO'), recordId, record.spot_id, record.reservation_id, body.note ?? '业主申请物业协调替代车位/临时安置'],
      );
      await c.query(`UPDATE owner_return_records SET resolution='property_coordinating' WHERE id=$1`, [recordId]);
      await c.query(
        `INSERT INTO move_notices(ticket_id, target_plate, channel, message, delivered_at)
       VALUES ($1,$2,'app_push+led',$3, now())`,
        [record.ticket_id, record.car_on_site ? '在场车主' : '预约车主', '业主已申请物业协调，值班员将电话联系您并安排临时车位，请稍候'],
      );
      await this.recordEvent(c, record, 'owner_return_coordination_requested', user.sub, user.role, { coordination_id: ci.rows[0].id });
      return { ok: true, resolution: 'property_coordinating', coordination: ci.rows[0] };
    });
  }

  /** 物业：协调请求队列 */
  async listCoordinations(userId: number | null, status?: string) {
    const params: any[] = [];
    let where = '1=1';
    if (status) {
      params.push(status);
      where += ` AND cr.status=$${params.length}`;
    }
    const { rows } = await this.db.query(
      `SELECT cr.*, rr.code AS record_code, rr.risk_level, rr.early_termination_count,
              s.code AS spot_code, c.name AS community_name, r.code AS reservation_code, r.plate,
              pu.name AS handled_name
       FROM coordination_requests cr
       JOIN owner_return_records rr ON rr.id=cr.record_id
       JOIN parking_spots s ON s.id=cr.spot_id
       JOIN communities c ON c.id=s.community_id
       LEFT JOIN reservations r ON r.id=cr.reservation_id
       LEFT JOIN users pu ON pu.id=cr.handled_by
       WHERE ${where}
       ORDER BY CASE cr.status WHEN 'pending' THEN 0 WHEN 'coordinating' THEN 1 ELSE 2 END, cr.id DESC
       LIMIT 100`,
      params,
    );
    return rows;
  }

  /** 物业处置协调请求：协调到具体车位（代车主确认换位）或协调失败退回业主选择 */
  async handleCoordination(
    user: { sub: number; role: string },
    id: number,
    body: { action: 'relocated' | 'failed'; spot_id?: number; note?: string; relocate_at?: string },
  ) {
    const at = body.relocate_at ? new Date(body.relocate_at) : new Date();
    return this.db.withTx(async (c) => {
      const cq = await c.query(`SELECT * FROM coordination_requests WHERE id=$1 FOR UPDATE`, [id]);
      const coordination = cq.rows[0];
      if (!coordination) throw new BadRequestException('协调请求不存在');
      if (!['pending', 'coordinating'].includes(coordination.status)) throw new BadRequestException('该协调请求已结案');

      if (body.action === 'failed') {
        await c.query(
          `UPDATE coordination_requests SET status='failed', result=$2, handled_by=$3, handled_at=$4 WHERE id=$1`,
          [id, body.note ?? '周边无可用替代车位，协调失败', user.sub, at],
        );
        // 退回业主：可继续等待或支付违约补偿
        await c.query(`UPDATE owner_return_records SET resolution='pending' WHERE id=$1`, [coordination.record_id]);
        await c.query(
          `INSERT INTO service_events(spot_id, type, actor_id, actor_role, detail)
           VALUES ($1,'property_coordination_failed',$2,'property',$3)`,
          [coordination.spot_id, user.sub, JSON.stringify({ coordination_id: id, note: body.note ?? null })],
        );
        return { ok: true, status: 'failed' };
      }

      if (!body.spot_id) throw new BadRequestException('协调成功需指定替代车位 spot_id');
      if (body.spot_id === coordination.spot_id) throw new BadRequestException('替代车位不能是原车位');

      // 若此前已生成过同车位 offer 则复用，否则新建
      let offerId: number;
      const existing = await c.query(
        `SELECT id FROM relocation_offers WHERE record_id=$1 AND spot_id=$2 AND status IN ('offered','accepted')
         ORDER BY id DESC LIMIT 1`,
        [coordination.record_id, body.spot_id],
      );
      if (existing.rows[0]) {
        offerId = existing.rows[0].id;
        if ((await c.query(`SELECT status FROM relocation_offers WHERE id=$1`, [offerId])).rows[0].status !== 'offered')
          throw new BadRequestException('该方案已被处理');
      } else {
        const tq = await c.query(
          `SELECT s.*, c.name AS community_name, os.code AS origin_code, os.location_desc AS origin_loc
           FROM parking_spots s JOIN communities c ON c.id=s.community_id,
                parking_spots os
           WHERE s.id=$1 AND os.id=$2`,
          [body.spot_id, coordination.spot_id],
        );
        const target = tq.rows[0];
        if (!target || target.review_status !== 'approved' || !target.active)
          throw new BadRequestException('替代车位不可用');
        const rr = await c.query(`SELECT * FROM reservations WHERE id=$1`, [coordination.reservation_id]);
        const reservation = rr.rows[0];
        if (!reservation) throw new BadRequestException('预约不存在，无法协调换位');
        const conflict = await c.query(
          `SELECT id FROM reservations WHERE spot_id=$1 AND status IN ('reserved','admitted','in_garage')
             AND start_at < $2 AND $3 < end_at`,
          [body.spot_id, reservation.end_at, at],
        );
        if (conflict.rowCount) throw new BadRequestException('该替代车位在剩余时段内已有预约');
        const nav = buildRelocationNavigation({
          originCode: target.origin_code,
          targetCode: target.code,
          targetLocationDesc: target.location_desc,
          targetNearCharger: target.near_charger,
          distanceM: 120,
          plate: reservation.plate,
          communityName: target.community_name,
        });
        const oi = await c.query(
          `INSERT INTO relocation_offers(code, record_id, reservation_id, spot_id, from_at, to_at,
             distance_m, match_score, fee_compensation, status, navigation)
           VALUES ($1,$2,$3,$4,$5,$6,120,60,$7,'offered',$8) RETURNING id`,
          [
            genCode('MV'),
            coordination.record_id,
            reservation.id,
            body.spot_id,
            at,
            reservation.end_at,
            RELOCATION.feeCompensation,
            JSON.stringify({ ...nav, score_reasons: ['物业线下协调确认'] }),
          ],
        );
        offerId = oi.rows[0].id;
      }

      await c.query(
        `UPDATE coordination_requests SET status='coordinating', relocation_offer_id=$2, handled_by=$3,
           handled_at=$4, note=COALESCE(NULLIF($5,''), note) WHERE id=$1`,
        [id, offerId, user.sub, at, body.note ?? ''],
      );

      // 物业已与车主电话确认：直接代其执行换位
      const offer = (await c.query(`SELECT o.*, r.driver_id, r.plate, r.status AS res_status,
                                            rr.resolution AS record_resolution, rr.ticket_id, rr.owner_id,
                                            rr.spot_id AS origin_spot_id
                                     FROM relocation_offers o
                                     JOIN reservations r ON r.id=o.reservation_id
                                     JOIN owner_return_records rr ON rr.id=o.record_id
                                     WHERE o.id=$1 FOR UPDATE OF o`, [offerId])).rows[0];
      const result = await this.executeRelocation(c, offer, at, { id: user.sub, role: 'property' });
      await c.query(
        `UPDATE coordination_requests SET status='relocated', result=$2, handled_at=$3 WHERE id=$1`,
        [id, body.note ?? `物业协调车主换位至车位 #${body.spot_id}`, at],
      );
      return { ok: true, status: 'relocated', ...result };
    });
  }

  /** 业主：提前结束发布记录与累计次数 */
  async listOwnerRecords(ownerId: number) {
    const records = await this.db.query(
      `SELECT rr.*, s.code AS spot_code, c.name AS community_name,
              r.code AS reservation_code, r.plate
       FROM owner_return_records rr
       JOIN parking_spots s ON s.id=rr.spot_id
       JOIN communities c ON c.id=s.community_id
       LEFT JOIN reservations r ON r.id=rr.reservation_id
       WHERE rr.owner_id=$1
       ORDER BY rr.id DESC LIMIT 50`,
      [ownerId],
    );
    const sum = await this.db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE created_at > now() - interval '${RELOCATION.historyWindowDays} days' AND resolution NOT IN ('cancelled','owner_wait'))::int AS last_90d,
              MAX(created_at) AS last_at
       FROM owner_return_records WHERE owner_id=$1`,
      [ownerId],
    );
    return {
      summary: {
        ...sum.rows[0],
        risk_label: RISK_LABEL[evaluateReturnRisk(Number(sum.rows[0].last_90d ?? 0), 0)],
        history_window_days: RELOCATION.historyWindowDays,
      },
      records: records.rows.map((r) => ({
        ...r,
        detail: r.detail,
      })),
    };
  }

  private async recordEvent(c: any, record: any, type: string, actorId: number, actorRole: string, detail: any) {
    await c.query(
      `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        record.reservation_id,
        record.spot_id,
        type,
        actorId,
        actorRole,
        null,
        JSON.stringify({ record_id: record.id, ...detail }),
      ],
    );
  }
}
