import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard';
import { JwtUser } from '../auth/auth.service';
import { DbService } from '../database/db.service';

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

  // 业主历史提前结束次数（写入发布记录：抢占处理单 + 未关联抢占的历史回家工单）
  private static readonly OWNER_EARLY_RETURNS_SQL = `
    (SELECT count(*) FROM preemption_cases p WHERE p.owner_id=s.owner_id AND p.status<>'cancelled')
    +
    (SELECT count(*) FROM incident_tickets i JOIN parking_spots s2 ON s2.id=i.spot_id
      WHERE s2.owner_id=s.owner_id AND i.type='owner_return' AND NOT (i.detail ? 'preemption_case_id'))`;

  // 单车位提前结束次数
  private static readonly SPOT_EARLY_RETURNS_SQL = `
    (SELECT count(*) FROM preemption_cases p WHERE p.spot_id=s.id AND p.status<>'cancelled')
    +
    (SELECT count(*) FROM incident_tickets i WHERE i.spot_id=s.id AND i.type='owner_return' AND NOT (i.detail ? 'preemption_case_id'))`;

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
             FROM spot_share_windows w WHERE w.spot_id=s.id) AS windows,
          (${SpotsController.SPOT_EARLY_RETURNS_SQL})::int AS early_return_count
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

  // 物业审核队列（含业主提前结束记录：次数偏多时提示更谨慎审核开放时段）
  @Roles('property', 'admin')
  @Get('review/pending')
  pendingReview() {
    return this.db
      .query(
        `SELECT s.*, c.name AS community_name, u.name AS owner_name, u.phone AS owner_phone,
           (${SpotsController.OWNER_EARLY_RETURNS_SQL})::int AS owner_early_return_count
         FROM parking_spots s
         JOIN communities c ON c.id=s.community_id
         JOIN users u ON u.id=s.owner_id
         WHERE s.review_status='pending' ORDER BY s.created_at`,
      )
      .then((r) =>
        r.rows.map((s) => ({
          ...s,
          review_caution: s.owner_early_return_count >= 2,
          review_hint:
            s.owner_early_return_count >= 2
              ? `该业主已有 ${s.owner_early_return_count} 次提前结束共享记录，请谨慎审核其开放时段（可要求缩短共享窗口或补充说明）`
              : s.owner_early_return_count === 1
                ? '该业主有 1 次提前结束共享记录，审核开放时段时请关注'
                : null,
        })),
      );
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.getDetail(this.db, id);
  }

  private async getDetail(client: any, id: string | number) {
    const { rows } = await client.query(
      `SELECT s.*, c.name AS community_name, u.name AS owner_name, u.phone AS owner_phone,
        (SELECT json_agg(json_build_object('weekday',weekday,'start_time',start_time::text,'end_time',end_time::text))
           FROM spot_share_windows w WHERE w.spot_id=s.id) AS windows,
        (${SpotsController.SPOT_EARLY_RETURNS_SQL})::int AS early_return_count,
        (${SpotsController.OWNER_EARLY_RETURNS_SQL})::int AS owner_early_return_count
       FROM parking_spots s
       JOIN communities c ON c.id=s.community_id
       JOIN users u ON u.id=s.owner_id
       WHERE s.id=$1`,
      [id],
    );
    const spot = rows[0];
    if (spot) {
      // 提前结束记录偏多：发布与审核环节都给出谨慎提示
      spot.review_caution = spot.owner_early_return_count >= 2;
      spot.publish_hint = spot.review_caution
        ? `您已有 ${spot.owner_early_return_count} 次提前结束共享记录，本次及后续开放时段的审核将更谨慎`
        : null;
    }
    return spot;
  }
}
