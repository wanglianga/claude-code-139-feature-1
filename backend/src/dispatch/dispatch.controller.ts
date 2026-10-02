import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard';
import { JwtUser } from '../auth/auth.service';
import { DbService } from '../database/db.service';
import { DispatchService } from './dispatch.service';

const INCIDENT_INFO: Record<string, { label: string; noticeTemplate: string }> = {
  owner_return: {
    label: '业主临时回家',
    noticeTemplate: '您的共享车位业主临时回家，平台正为您协调就近车位并按实际时长结算',
  },
  visitor_overstay: {
    label: '访客车辆超时',
    noticeTemplate: '您的预约已到期，请尽快离场；超出 10 分钟宽限后将按 1.5× 计超时费',
  },
  stranger_occupy: {
    label: '陌生车辆占用',
    noticeTemplate: '您预约的车位被陌生车辆占用，物业已到场处理，等待期间不计费，平台兜底补偿',
  },
  recognition_fail: {
    label: '道闸识别失败',
    noticeTemplate: '道闸识别失败，已通知物业人工核验，请准备好预约码',
  },
  weak_signal: {
    label: '地下车库信号差',
    noticeTemplate: '检测到您所在区域信号弱，已下发离线导航码与离线账单',
  },
  ice_occupy_charger: {
    label: '燃油车占用充电位',
    noticeTemplate: '充电车位被燃油车占用，物业已通知挪车，请稍候或改停相邻充电位',
  },
  wrong_parking: {
    label: '车主停错车位',
    noticeTemplate: '系统检测到您未停在预约车位，请立即挪车至预约车位，超时将计入错停违约',
  },
  manual_release: {
    label: '物业人工放行',
    noticeTemplate: '物业已人工放行，入场服务已绑定到您的预约单',
  },
};

@Controller('dispatch')
@UseGuards(AuthGuard)
export class DispatchController {
  constructor(
    private db: DbService,
    private dispatch: DispatchService,
  ) {}

  // 夜间调度看板（物业/管理员/业主）
  @Roles('property', 'admin', 'owner')
  @Get('incidents')
  async list(@CurrentUser() user: JwtUser, @Query('status') status?: string, @Query('night') night?: string) {
    const params: any[] = [];
    let where = '1=1';
    if (status) {
      params.push(status);
      where += ` AND i.status=$${params.length}`;
    }
    if (user.role === 'owner') {
      params.push(user.sub);
      where += ` AND s.owner_id=$${params.length}`;
    }
    const { rows } = await this.db.query(
      `SELECT i.*, s.code AS spot_code, c.name AS community_name, r.code AS reservation_code,
              u.name AS reporter_name
       FROM incident_tickets i
       LEFT JOIN parking_spots s ON s.id=i.spot_id
       LEFT JOIN communities c ON c.id=s.community_id
       LEFT JOIN reservations r ON r.id=i.reservation_id
       LEFT JOIN users u ON u.id=i.resolved_by
       WHERE ${where}
       ORDER BY CASE i.status WHEN 'open' THEN 0 WHEN 'notified' THEN 1 ELSE 2 END, i.created_at DESC
       LIMIT 200`,
      params,
    );
    return rows.map((r) => ({ ...r, label: INCIDENT_INFO[r.type]?.label ?? r.type }));
  }

  // 业主上报"提前回家"：平台评估在场状态/剩余时长/历史次数与风险，匹配附近替代车位并下发换位方案
  @Roles('owner')
  @Post('owner-return')
  ownerReturn(
    @CurrentUser() user: JwtUser,
    @Body() body: { spot_id: number; eta_minutes?: number; note?: string; occurred_at?: string },
  ) {
    return this.dispatch.ownerReturn(user, body);
  }

  // 车主：发给我的换位方案（含换位导航与费用补偿）
  @Roles('driver')
  @Get('my-relocations')
  myRelocations(@CurrentUser() user: JwtUser) {
    return this.dispatch.listMyRelocations(user.sub);
  }

  // 车主：接受/拒绝换位
  @Roles('driver')
  @Post('relocations/:id/respond')
  respondRelocation(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() body: { accept: boolean; relocate_at?: string; reason?: string },
  ) {
    return this.dispatch.respondRelocation(user, Number(id), body);
  }

  // 业主：无法替换/方案被拒时三选一（等待 / 支付违约补偿 / 申请物业协调）
  @Roles('owner')
  @Post('owner-records/:id/decision')
  ownerDecision(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() body: { action: 'owner_wait' | 'breach_pay' | 'property_coordination'; note?: string; decided_at?: string },
  ) {
    return this.dispatch.ownerDecision(user, Number(id), body);
  }

  // 业主：提前结束发布记录（后续开放时段审核依据）
  @Roles('owner')
  @Get('owner-records')
  ownerRecords(@CurrentUser() user: JwtUser) {
    return this.dispatch.listOwnerRecords(user.sub);
  }

  // 物业：业主协调请求队列
  @Roles('property', 'admin')
  @Get('coordinations')
  coordinations(@Query('status') status?: string) {
    return this.dispatch.listCoordinations(null, status);
  }

  // 物业：处置协调请求（协调到具体车位 / 协调失败退回业主）
  @Roles('property', 'admin')
  @Post('coordinations/:id/handle')
  handleCoordination(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() body: { action: 'relocated' | 'failed'; spot_id?: number; note?: string; relocate_at?: string },
  ) {
    return this.dispatch.handleCoordination(user, Number(id), body);
  }

  // 上报访客超时（系统定时任务或物业触发）
  @Roles('property', 'admin')
  @Post('overstay')
  async overstay(@CurrentUser() user: JwtUser, @Body() body: { reservation_id: number }) {
    const r = await this.db.query(`SELECT * FROM reservations WHERE id=$1`, [body.reservation_id]);
    const res = r.rows[0];
    if (!res) throw new Error('预约不存在');
    const exist = await this.db.query(
      `SELECT id FROM incident_tickets
       WHERE type='visitor_overstay' AND status IN ('open','notified') AND reservation_id=$1`,
      [res.id],
    );
    let ticketId: number;
    if (exist.rows[0]) {
      ticketId = exist.rows[0].id;
    } else {
      const t = await this.db.query(
        `INSERT INTO incident_tickets(code, spot_id, reservation_id, type, status, plate, reporter_role, description, detail)
         VALUES ($1,$2,$3,'visitor_overstay','open',$4,$5,$6,$7) RETURNING id`,
        [
          'T' + Date.now().toString(36).toUpperCase(),
          res.spot_id,
          res.id,
          res.plate,
          user.role,
          '访客车辆超出预约结束时间仍未离场',
          JSON.stringify({ reserved_end: res.end_at }),
        ],
      );
      ticketId = t.rows[0].id;
    }
    await this.db.query(
      `INSERT INTO move_notices(ticket_id, target_plate, channel, message, delivered_at)
       VALUES ($1,$2,'app_push',$3, now())
       ON CONFLICT DO NOTHING`,
      [ticketId, res.plate, INCIDENT_INFO.visitor_overstay.noticeTemplate],
    );
    await this.db.query(
      `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
       VALUES ($1,$2,'overstay_warning',$3,$4,$5,$6)`,
      [res.id, res.spot_id, user.sub, user.role, res.plate, JSON.stringify({ reserved_end: res.end_at })],
    );
    await this.db.query(`UPDATE incident_tickets SET status='notified' WHERE id=$1 AND status='open'`, [ticketId]);
    return { ok: true, ticket_id: ticketId };
  }

  // 平台/物业派发挪车通知（陌生车/燃油车/错停）
  @Roles('property', 'admin')
  @Post('incidents/:id/notify')
  async notify(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() body?: { channel?: string; message?: string }) {
    const { rows } = await this.db.query(`SELECT * FROM incident_tickets WHERE id=$1 FOR UPDATE`, [id]);
    const t = rows[0];
    if (!t) throw new Error('工单不存在');
    const info = INCIDENT_INFO[t.type];
    await this.db.query(
      `INSERT INTO move_notices(ticket_id, target_plate, channel, message, delivered_at)
       VALUES ($1,$2,$3,$4, now())`,
      [id, t.plate ?? '未知车牌', body?.channel ?? 'app_push+led', body?.message ?? info?.noticeTemplate ?? '请立即挪车'],
    );
    await this.db.query(`UPDATE incident_tickets SET status='notified' WHERE id=$1`, [id]);
    await this.db.query(
      `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
       VALUES ($1,$2,'move_notice_sent',$3,$4,$5,$6)`,
      [t.reservation_id, t.spot_id, user.sub, user.role, t.plate, JSON.stringify({ channel: body?.channel ?? 'app_push+led' })],
    );
    return { ok: true };
  }

  // 工单处置完成（业主已回家自用/陌生车已驶离/车辆已挪位等）
  @Roles('property', 'admin', 'owner')
  @Post('incidents/:id/resolve')
  async resolve(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() body: { resolution: string; waive_overtime?: boolean; resolved_at?: string },
  ) {
    const { rows } = await this.db.query(`SELECT * FROM incident_tickets WHERE id=$1 FOR UPDATE`, [id]);
    const t = rows[0];
    if (!t) throw new Error('工单不存在');
    await this.db.query(
      `UPDATE incident_tickets SET status='resolved', resolution=$1, resolved_by=$2,
         resolved_at=COALESCE($5::timestamptz, now()),
         detail=jsonb_set(COALESCE(detail,'{}'::jsonb), '{waive_overtime}', $3::jsonb)
       WHERE id=$4`,
      [body.resolution, user.sub, JSON.stringify(!!body.waive_overtime), id, body.resolved_at ?? null],
    );
    // 兼容既有业主回家流程：工单结案时同步把仍在处理中的提前结束记录标记为已协调，
    // 并失效尚未被车主响应的换位方案
    if (t.type === 'owner_return') {
      const rr = await this.db.query(
        `UPDATE owner_return_records SET resolution='coordinated'
         WHERE ticket_id=$1 AND resolution IN ('pending','property_coordinating')
         RETURNING id`,
        [id],
      );
      for (const row of rr.rows) {
        await this.db.query(
          `UPDATE relocation_offers SET status='expired' WHERE record_id=$1 AND status='offered'`,
          [row.id],
        );
      }
    }
    await this.db.query(
      `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
       VALUES ($1,$2,'incident_resolved',$3,$4,$5,$6)`,
      [
        t.reservation_id,
        t.spot_id,
        user.sub,
        user.role,
        t.plate,
        JSON.stringify({ type: t.type, resolution: body.resolution, waive_overtime: body.waive_overtime }),
      ],
    );
    return { ok: true };
  }

  @Get('incidents/:id/notices')
  async notices(@Param('id') id: string) {
    return this.db
      .query(`SELECT * FROM move_notices WHERE ticket_id=$1 ORDER BY id`, [id])
      .then((r) => r.rows);
  }

  // 调度看板所需汇总数据
  @Roles('property', 'admin')
  @Get('overview')
  async overview() {
    const byType = await this.db.query(
      `SELECT type, status, count(*)::int AS n FROM incident_tickets
       WHERE created_at > now() - interval '24 hours'
       GROUP BY type, status ORDER BY type, status`,
    );
    const activeReservations = await this.db.query(
      `SELECT count(*)::int AS n FROM reservations WHERE status IN ('reserved','admitted','in_garage')
        AND start_at > now() - interval '12 hours'`,
    );
    const pendingCoordinations = await this.db.query(
      `SELECT count(*)::int AS n FROM coordination_requests WHERE status IN ('pending','coordinating')`,
    );
    return {
      incidents_24h: byType.rows,
      active_reservations: activeReservations.rows[0].n,
      pending_coordinations: pendingCoordinations.rows[0].n,
    };
  }
}
