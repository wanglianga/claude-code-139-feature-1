-- 社区共享停车平台：完整库表结构
-- 覆盖：车位发布 -> 预约 -> 入场 -> 异常 -> 离场 -> 分账 全链路

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','driver','property','admin')),
  phone TEXT,
  credit_score INT NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS communities (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT
);

CREATE TABLE IF NOT EXISTS parking_spots (
  id BIGSERIAL PRIMARY KEY,
  community_id BIGINT NOT NULL REFERENCES communities(id),
  code TEXT NOT NULL,
  owner_id BIGINT NOT NULL REFERENCES users(id),
  location_desc TEXT,
  near_charger BOOLEAN NOT NULL DEFAULT false,
  charger_power_kw NUMERIC(6,1),
  allow_visitor BOOLEAN NOT NULL DEFAULT true,
  monthly_priority BOOLEAN NOT NULL DEFAULT false,
  hourly_rate NUMERIC(10,2) NOT NULL,
  overnight_cap NUMERIC(10,2),
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending','approved','rejected','revoked')),
  review_remark TEXT,
  reviewed_by BIGINT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(community_id, code)
);

-- 可共享时段：weekday 0=周日 ... 6=周六；end_time <= start_time 表示跨天（如 19:00->08:00）
CREATE TABLE IF NOT EXISTS spot_share_windows (
  id BIGSERIAL PRIMARY KEY,
  spot_id BIGINT NOT NULL REFERENCES parking_spots(id) ON DELETE CASCADE,
  weekday INT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  UNIQUE(spot_id, weekday)
);

CREATE TABLE IF NOT EXISTS vehicles (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plate TEXT NOT NULL,
  plate_color TEXT NOT NULL DEFAULT '蓝牌',
  is_new_energy BOOLEAN NOT NULL DEFAULT false,
  is_monthly BOOLEAN NOT NULL DEFAULT false,
  is_visitor BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, plate)
);

CREATE TABLE IF NOT EXISTS reservations (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  spot_id BIGINT NOT NULL REFERENCES parking_spots(id),
  driver_id BIGINT NOT NULL REFERENCES users(id),
  vehicle_id BIGINT NOT NULL REFERENCES vehicles(id),
  plate TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN (
    'reserved','admitted','in_garage','completed','cancelled','noshow'
  )),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','monthly')),
  estimated_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  gate_entry_at TIMESTAMPTZ,
  parking_confirmed_at TIMESTAMPTZ,
  gate_exit_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  settlement_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reservations_spot_time ON reservations(spot_id, start_at, end_at);

-- 同一笔停车服务的全链路事件：入场道闸/车牌识别/导航引导/计费/离场结算
CREATE TABLE IF NOT EXISTS service_events (
  id BIGSERIAL PRIMARY KEY,
  reservation_id BIGINT REFERENCES reservations(id),
  spot_id BIGINT REFERENCES parking_spots(id),
  type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id BIGINT REFERENCES users(id),
  actor_role TEXT,
  plate TEXT,
  gate TEXT,
  confidence NUMERIC(5,2),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_events_reservation ON service_events(reservation_id);
CREATE INDEX IF NOT EXISTS idx_events_spot_time ON service_events(spot_id, occurred_at);

-- 夜间调度异常工单
CREATE TABLE IF NOT EXISTS incident_tickets (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  spot_id BIGINT REFERENCES parking_spots(id),
  reservation_id BIGINT REFERENCES reservations(id),
  type TEXT NOT NULL CHECK (type IN (
    'owner_return','visitor_overstay','stranger_occupy','recognition_fail',
    'weak_signal','ice_occupy_charger','wrong_parking','manual_release'
  )),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','notified','resolved','closed','cancelled')),
  plate TEXT,
  reporter_role TEXT,
  description TEXT,
  resolution TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved_by BIGINT REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS move_notices (
  id BIGSERIAL PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES incident_tickets(id) ON DELETE CASCADE,
  target_plate TEXT NOT NULL,
  channel TEXT NOT NULL,
  message TEXT,
  delivered_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS appeals (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  reservation_id BIGINT NOT NULL REFERENCES reservations(id),
  spot_id BIGINT NOT NULL REFERENCES parking_spots(id),
  appellant_id BIGINT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','investigating','upheld','rejected','closed')),
  ruling TEXT CHECK (ruling IN (
    'driver_fault','owner_fault','platform_fault','property_fault','stranger','mixed','no_fault'
  )),
  ruling_note TEXT,
  ruled_by BIGINT REFERENCES users(id),
  ruled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS appeal_evidence (
  id BIGSERIAL PRIMARY KEY,
  appeal_id BIGINT NOT NULL REFERENCES appeals(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN (
    'plate_recognition','reservation','photo','gate_log','owner_home','patrol','appeal_statement','signal'
  )),
  title TEXT NOT NULL,
  content TEXT,
  media_url TEXT,
  captured_at TIMESTAMPTZ,
  uploaded_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coupons (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  used_reservation_id BIGINT REFERENCES reservations(id),
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 结算单：业主收益/物业服务费/平台抽成/优惠券/退款/异常补偿合并清算
CREATE TABLE IF NOT EXISTS settlements (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  reservation_id BIGINT UNIQUE NOT NULL REFERENCES reservations(id),
  spot_id BIGINT NOT NULL REFERENCES parking_spots(id),
  actual_entry_at TIMESTAMPTZ,
  actual_exit_at TIMESTAMPTZ,
  usable_from TIMESTAMPTZ,
  duration_minutes INT NOT NULL DEFAULT 0,
  base_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  charging_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  overtime_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  wrong_park_fine NUMERIC(10,2) NOT NULL DEFAULT 0,
  coupon_discount NUMERIC(10,2) NOT NULL DEFAULT 0,
  abnormal_compensation NUMERIC(10,2) NOT NULL DEFAULT 0,
  coupon_compensation NUMERIC(10,2) NOT NULL DEFAULT 0,
  owner_compensation NUMERIC(10,2) NOT NULL DEFAULT 0,
  prepaid NUMERIC(10,2) NOT NULL DEFAULT 0,
  refund NUMERIC(10,2) NOT NULL DEFAULT 0,
  exit_charge NUMERIC(10,2) NOT NULL DEFAULT 0,
  payable NUMERIC(10,2) NOT NULL DEFAULT 0,
  owner_income NUMERIC(10,2) NOT NULL DEFAULT 0,
  property_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  platform_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  owner_share NUMERIC(5,4) NOT NULL,
  property_share NUMERIC(5,4) NOT NULL,
  platform_share NUMERIC(5,4) NOT NULL,
  credit_target TEXT NOT NULL DEFAULT 'driver',
  credit_delta INT NOT NULL DEFAULT 0,
  appeal_id BIGINT REFERENCES appeals(id),
  ruling TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 资金流水（业主/车主/物业/平台/券池共同追溯）
CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  settlement_id BIGINT NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  account TEXT NOT NULL,           -- driver / owner:<uid> / property / platform / coupon_pool
  direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount NUMERIC(10,2) NOT NULL,
  memo TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_settlement ON ledger_entries(settlement_id);

CREATE TABLE IF NOT EXISTS patrol_logs (
  id BIGSERIAL PRIMARY KEY,
  spot_id BIGINT REFERENCES parking_spots(id),
  guard_id BIGINT REFERENCES users(id),
  plate TEXT,
  note TEXT,
  media_url TEXT,
  patrolled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 幂等迁移：为旧版本库补充后续新增列
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS coupon_compensation NUMERIC(10,2) NOT NULL DEFAULT 0;

-- ========== 业主提前回家抢占处理（feature-1） ==========

-- 业主提前结束记录：每次"提前回家"都写入业主发布记录，作为后续开放时段审核风控依据
CREATE TABLE IF NOT EXISTS owner_return_records (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id),
  spot_id BIGINT NOT NULL REFERENCES parking_spots(id),
  reservation_id BIGINT REFERENCES reservations(id),
  ticket_id BIGINT REFERENCES incident_tickets(id),
  code TEXT UNIQUE NOT NULL,
  shared_end_at TIMESTAMPTZ NOT NULL,          -- 原共享结束时间（承诺时点，如 23:00）
  reported_at TIMESTAMPTZ NOT NULL,            -- 业主上报回家时间（如 22:00）
  early_minutes INT NOT NULL DEFAULT 0,        -- 提前分钟数
  car_on_site BOOLEAN NOT NULL DEFAULT false,  -- 预约车辆是否已入场
  remaining_minutes INT NOT NULL DEFAULT 0,    -- 车主剩余停车时长（分钟）
  early_termination_count INT NOT NULL DEFAULT 0, -- 业主历史（90 天内）提前结束次数（含本次）
  risk_level TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low','medium','high')),
  resolution TEXT NOT NULL DEFAULT 'pending'
    CHECK (resolution IN (
      'pending','relocated','owner_wait','breach_paid','property_coordinating','coordinated','cancelled'
    )),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_return_records_owner ON owner_return_records(owner_id, created_at);

-- 换位方案：平台为受影响车主匹配的附近可替代车位（可同时下发多个候选）
CREATE TABLE IF NOT EXISTS relocation_offers (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  record_id BIGINT NOT NULL REFERENCES owner_return_records(id) ON DELETE CASCADE,
  reservation_id BIGINT NOT NULL REFERENCES reservations(id),
  spot_id BIGINT NOT NULL REFERENCES parking_spots(id),
  from_at TIMESTAMPTZ NOT NULL,
  to_at TIMESTAMPTZ NOT NULL,
  distance_m INT NOT NULL DEFAULT 0,
  match_score INT NOT NULL DEFAULT 0,
  fee_compensation NUMERIC(10,2) NOT NULL DEFAULT 0,   -- 接受换位的费用补偿（现金，随结算退款）
  status TEXT NOT NULL DEFAULT 'offered'
    CHECK (status IN ('offered','accepted','declined','expired')),
  driver_response_at TIMESTAMPTZ,
  new_reservation_id BIGINT REFERENCES reservations(id),
  navigation JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_relocation_reservation ON relocation_offers(reservation_id);

-- 无法替换时：业主申请物业协调
CREATE TABLE IF NOT EXISTS coordination_requests (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  record_id BIGINT NOT NULL REFERENCES owner_return_records(id) ON DELETE CASCADE,
  spot_id BIGINT NOT NULL REFERENCES parking_spots(id),
  reservation_id BIGINT REFERENCES reservations(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','coordinating','relocated','failed','cancelled')),
  note TEXT,
  result TEXT,
  relocation_offer_id BIGINT REFERENCES relocation_offers(id),
  handled_by BIGINT REFERENCES users(id),
  handled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 开放时段审核：提前结束次数多的业主，追加/延长共享时段需物业谨慎审核
CREATE TABLE IF NOT EXISTS share_window_reviews (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  spot_id BIGINT NOT NULL REFERENCES parking_spots(id),
  owner_id BIGINT NOT NULL REFERENCES users(id),
  windows JSONB NOT NULL,                  -- 申请的时段 [{weekday,start_time,end_time}]
  reason TEXT,
  risk_level TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low','medium','high')),
  early_termination_count INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','restricted','rejected','auto_approved')),
  handled_by BIGINT REFERENCES users(id),
  handled_at TIMESTAMPTZ,
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_window_reviews_status ON share_window_reviews(status, created_at);

-- 预约迁移留痕（原单 -> 换位新单）
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS relocated_from_reservation_id BIGINT REFERENCES reservations(id);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS relocation_offer_id BIGINT REFERENCES relocation_offers(id);
