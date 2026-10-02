import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard';
import { JwtUser } from '../auth/auth.service';
import { DbService } from '../database/db.service';
import { evaluateReturnRisk, RELOCATION, RISK_LABEL, RiskLevel } from '../domain/ownerReturn';

class ShareWindowDto {
  weekday: number;
  start_time: string; // HH:MM
  end_time: string;
}

class PublishSpotDto {
  community_id: number;
  code: string;
  location_desc?: string;
  near_charger: boolean;
  charger_power_kw?: number;
  allow_visitor: boolean;
  monthly_priority: boolean;
  hourly_rate: number;
  overnight_cap?: number;
  windows: ShareWindowDto[];
}

class ReviewDto {
  pass: boolean;
  remark?: string;
}

@Controller('spots')
@UseGuards(AuthGuard)
export class SpotsController {
  constructor(private db: DbService) {}

  @Get('communities')
  communities() {
    return this.db.query(`SELECT * FROM communities ORDER BY id`).then((r) => r.rows);
  }

  // 业主发布闲置车位：登记产权、共享时段、充电桩、访客、月租优先
  @Roles('owner')
  @Post()
  async publish(@CurrentUser() user: JwtUser, @Body() dto: PublishSpotDto) {
    return this.db.withTx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO parking_spots(community_id, code, owner_id, location_desc, near_charger,
           charger_power_kw, allow_visitor, monthly_priority, hourly_rate, overnight_cap)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          dto.community_id,
          dto.code,
          user.sub,
          dto.location_desc ?? null,
          dto.near_charger,
          dto.charger_power_kw ?? null,
          dto.allow_visitor,
          dto.monthly_priority,
          dto.hourly_rate,
          dto.overnight_cap ?? null,
        ],
      );
      const spot = rows[0];
      for (const w of dto.windows ?? []) {
        await c.query(
          `INSERT INTO spot_share_windows(spot_id, weekday, start_time, end_time)
           VALUES ($1,$2,$3::time,$4::time)`,
          [spot.id, w.weekday, w.start_time, w.end_time],
        );
      }
      await c.query(
        `INSERT INTO service_events(spot_id, type, actor_id, actor_role, detail)
         VALUES ($1,'spot_published',$2,'owner',$3)`,
        [spot.id, user.sub, JSON.stringify({ windows: dto.windows })],
      );
      return this.getDetail(c, spot.id);
    });
  }

  // 车主查询可预约车位（仅物业审核通过、在共享时段内）
  @Get()
  async list(
    @Query('community_id') communityId?: string,
    @Query('need_charger') needCharger?: string,
    @Query('visitor') visitor?: string,
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    const params: any[] = [];
    let sql = `
      SELECT s.*, c.name AS community_name, u.name AS owner_name,
        (SELECT json_agg(json_build_object('weekday',weekday,'start_time',start_time::text,'end_time',end_time::text))
           FROM spot_share_windows w WHERE w.spot_id=s.id) AS windows
      FROM parking_spots s
      JOIN communities c ON c.id=s.community_id
      JOIN users u ON u.id=s.owner_id
      WHERE s.active AND s.review_status='approved'`;
    if (communityId) {
      params.push(Number(communityId));
      sql += ` AND s.community_id=$${params.length}`;
    }
    if (needCharger === 'true') sql += ` AND s.near_charger=true`;
    if (visitor === 'true') sql += ` AND s.allow_visitor=true`;
    sql += ` ORDER BY s.monthly_priority DESC, s.hourly_rate ASC`;
    const { rows } = await this.db.query(sql, params);
    return rows;
  }

  @Get('mine')
  mine(@CurrentUser() user: JwtUser) {
    return this.db
      .query(
        `SELECT s.*, c.name AS community_name,
          (SELECT json_agg(json_build_object('weekday',weekday,'start_time',start_time::text,'end_time',end_time::text))
             FROM spot_share_windows w WHERE w.spot_id=s.id) AS windows
         FROM parking_spots s JOIN communities c ON c.id=s.community_id
         WHERE s.owner_id=$1 ORDER BY s.id DESC`,
        [user.sub],
      )
      .then((r) => r.rows);
  }

  // 物业审核车位
  @Roles('property', 'admin')
  @Post(':id/review')
  async review(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: ReviewDto) {
    await this.db.withTx(async (c) => {
      const { rows } = await c.query(`SELECT * FROM parking_spots WHERE id=$1 FOR UPDATE`, [id]);
      if (!rows[0]) throw new Error('车位不存在');
      await c.query(
        `UPDATE parking_spots SET review_status=$1, review_remark=$2, reviewed_by=$3, reviewed_at=now() WHERE id=$4`,
        [dto.pass ? 'approved' : 'rejected', dto.remark ?? null, user.sub, id],
      );
      await c.query(
        `INSERT INTO service_events(spot_id, type, actor_id, actor_role, detail)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          id,
          dto.pass ? 'spot_review_approved' : 'spot_review_rejected',
          user.sub,
          user.role,
          JSON.stringify({ remark: dto.remark ?? null }),
        ],
      );
    });
    return this.getDetail(this.db, id);
  }

  // 物业审核队列
  @Roles('property', 'admin')
  @Get('review/pending')
  pendingReview() {
    return this.db
      .query(
        `SELECT s.*, c.name AS community_name, u.name AS owner_name, u.phone AS owner_phone
         FROM parking_spots s
         JOIN communities c ON c.id=s.community_id
         JOIN users u ON u.id=s.owner_id
         WHERE s.review_status='pending' ORDER BY s.created_at`,
      )
      .then((r) => r.rows);
  }

  // ---- 开放时段风控：有提前结束记录的业主追加/延长共享时段需谨慎审核 ----

  // 业主提交新的开放时段周计划（低风险自动生效，中/高风险转物业审核）
  @Roles('owner')
  @Post(':id/share-windows')
  async applyShareWindows(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: { windows: ShareWindowDto[]; reason?: string },
  ) {
    if (!Array.isArray(dto.windows) || dto.windows.length === 0)
      throw new BadRequestException('请至少提交一个开放时段');
    return this.db.withTx(async (c) => {
      const sq = await c.query(`SELECT * FROM parking_spots WHERE id=$1 AND owner_id=$2 FOR UPDATE`, [id, user.sub]);
      const spot = sq.rows[0];
      if (!spot) throw new BadRequestException('车位不存在或不属于本人');
      if (spot.review_status !== 'approved') throw new BadRequestException('车位尚未通过物业审核，暂不能调整开放时段');

      const hq = await c.query(
        `SELECT COUNT(*)::int AS n FROM owner_return_records
         WHERE owner_id=$1 AND created_at > now() - interval '${RELOCATION.historyWindowDays} days'
           AND resolution NOT IN ('cancelled','owner_wait')`,
        [user.sub],
      );
      const earlyCount = Number(hq.rows[0].n);
      const risk: RiskLevel = evaluateReturnRisk(earlyCount, 0);
      const reviewCode = 'WR' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000).toString(36).toUpperCase();

      // 低风险：自动生效，全量替换周计划
      if (risk === 'low') {
        await c.query(`DELETE FROM spot_share_windows WHERE spot_id=$1`, [id]);
        for (const w of dto.windows) {
          await c.query(
            `INSERT INTO spot_share_windows(spot_id, weekday, start_time, end_time)
             VALUES ($1,$2,$3::time,$4::time)`,
            [id, w.weekday, w.start_time, w.end_time],
          );
        }
        const rv = await c.query(
          `INSERT INTO share_window_reviews(code, spot_id, owner_id, windows, reason, risk_level,
             early_termination_count, status, handled_by, handled_at, review_note)
           VALUES ($1,$2,$3,$4,$5,'low',$6,'auto_approved',$7,now(),$8) RETURNING *`,
          [
            reviewCode, id, user.sub,
            JSON.stringify(dto.windows), dto.reason ?? null,
            earlyCount, user.sub, '低风险业主：系统自动通过',
          ],
        );
        await c.query(
          `INSERT INTO service_events(spot_id, type, actor_id, actor_role, detail)
           VALUES ($1,'share_window_auto_approved',$2,'owner',$3)`,
          [id, user.sub, JSON.stringify({ windows: dto.windows, early_termination_count: earlyCount })],
        );
        return { status: 'auto_approved', risk_level: 'low', risk_label: RISK_LABEL.low, review: rv.rows[0] };
      }

      // 中/高风险：进入物业谨慎审核队列，时段暂不生效
      const rv = await c.query(
        `INSERT INTO share_window_reviews(code, spot_id, owner_id, windows, reason, risk_level,
           early_termination_count, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING *`,
        [reviewCode, id, user.sub, JSON.stringify(dto.windows), dto.reason ?? null, risk, earlyCount],
      );
      await c.query(
        `INSERT INTO service_events(spot_id, type, actor_id, actor_role, detail)
         VALUES ($1,'share_window_submitted',$2,'owner',$3)`,
        [id, user.sub, JSON.stringify({ review_id: rv.rows[0].id, risk_level: risk, early_termination_count: earlyCount })],
      );
      return {
        status: 'pending',
        risk_level: risk,
        risk_label: RISK_LABEL[risk],
        review: rv.rows[0],
        message: `近 ${RELOCATION.historyWindowDays} 天内已有 ${earlyCount} 次提前结束共享记录，新开放时段需物业人工审核`,
      };
    });
  }

  // 业主查看自己的开放时段审核记录
  @Roles('owner')
  @Get('share-windows/mine')
  myShareWindowReviews(@CurrentUser() user: JwtUser) {
    return this.db
      .query(
        `SELECT w.*, s.code AS spot_code, c.name AS community_name
         FROM share_window_reviews w
         JOIN parking_spots s ON s.id=w.spot_id
         JOIN communities c ON c.id=s.community_id
         WHERE w.owner_id=$1 ORDER BY w.id DESC LIMIT 50`,
        [user.sub],
      )
      .then((r) => r.rows);
  }

  // 物业：开放时段审核队列（按风险从高到低）
  @Roles('property', 'admin')
  @Get('share-windows/pending')
  pendingShareWindowReviews() {
    return this.db
      .query(
        `SELECT w.*, s.code AS spot_code, c.name AS community_name, u.name AS owner_name, u.phone AS owner_phone,
                u.credit_score AS owner_credit_score
         FROM share_window_reviews w
         JOIN parking_spots s ON s.id=w.spot_id
         JOIN communities c ON c.id=s.community_id
         JOIN users u ON u.id=w.owner_id
         WHERE w.status='pending'
         ORDER BY CASE w.risk_level WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, w.id ASC`,
      )
      .then((r) => r.rows);
  }

  // 物业处置：通过（按申请生效）/ 限制（缩短时段后生效）/ 驳回（不生效）
  @Roles('property', 'admin')
  @Post('share-windows/:id/handle')
  async handleShareWindowReview(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: { decision: 'approved' | 'restricted' | 'rejected'; note?: string; windows?: ShareWindowDto[] },
  ) {
    return this.db.withTx(async (c) => {
      const rq = await c.query(`SELECT * FROM share_window_reviews WHERE id=$1 FOR UPDATE`, [id]);
      const review = rq.rows[0];
      if (!review) throw new BadRequestException('审核单不存在');
      if (review.status !== 'pending') throw new BadRequestException('该审核单已处置');

      const status = dto.decision === 'approved' ? 'approved' : dto.decision;
      await c.query(
        `UPDATE share_window_reviews SET status=$2, review_note=$3, handled_by=$4, handled_at=now() WHERE id=$1`,
        [id, status, dto.note ?? null, user.sub],
      );

      if (dto.decision === 'rejected') {
        await c.query(
          `INSERT INTO service_events(spot_id, type, actor_id, actor_role, detail)
           VALUES ($1,'share_window_rejected',$2,'property',$3)`,
          [review.spot_id, user.sub, JSON.stringify({ review_id: id, note: dto.note ?? null })],
        );
        return { ok: true, status: 'rejected' };
      }

      // approved 按申请时段生效；restricted 按物业裁剪后的时段生效
      const windows: ShareWindowDto[] = dto.decision === 'restricted' && dto.windows?.length ? dto.windows : review.windows;
      await c.query(`DELETE FROM spot_share_windows WHERE spot_id=$1`, [review.spot_id]);
      for (const w of windows) {
        await c.query(
          `INSERT INTO spot_share_windows(spot_id, weekday, start_time, end_time)
           VALUES ($1,$2,$3::time,$4::time)`,
          [review.spot_id, w.weekday, w.start_time, w.end_time],
        );
      }
      await c.query(
        `INSERT INTO service_events(spot_id, type, actor_id, actor_role, detail)
         VALUES ($1,$2,$3,'property',$4)`,
        [
          review.spot_id,
          dto.decision === 'restricted' ? 'share_window_restricted' : 'share_window_approved',
          user.sub,
          JSON.stringify({ review_id: id, windows, risk_level: review.risk_level, note: dto.note ?? null }),
        ],
      );
      return { ok: true, status, windows };
    });
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.getDetail(this.db, id);
  }

  private async getDetail(client: any, id: string | number) {
    const { rows } = await client.query(
      `SELECT s.*, c.name AS community_name, u.name AS owner_name, u.phone AS owner_phone,
        (SELECT json_agg(json_build_object('weekday',weekday,'start_time',start_time::text,'end_time',end_time::text))
           FROM spot_share_windows w WHERE w.spot_id=s.id) AS windows
       FROM parking_spots s
       JOIN communities c ON c.id=s.community_id
       JOIN users u ON u.id=s.owner_id
       WHERE s.id=$1`,
      [id],
    );
    return rows[0];
  }
}
