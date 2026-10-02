/* 端到端冒烟：真实 HTTP + PostgreSQL，覆盖
   发布审核 → 预约(券/月租) → 识别入场 → 导航/信号差 → 停放确认 → 陌生车/错停/业主回家/人工放行
   → 挪车通知 → 申诉证据链裁决 → 离场分账 → 信用 → 同车位多订单时间轴 → 资金流水
   事件时间通过道闸时钟参数（entry_at/parked_at/exit_at/occurred_at）锚定到"今晚"时间线。 */
const BASE = process.env.API_BASE || 'http://127.0.0.1:3000/api';
const RUN = String(Date.now()).slice(-6);

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`, extra ?? '');
  }
}

async function api(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`);
  }
  return json;
}

async function login(username) {
  const r = await api('POST', '/auth/login', null, { username, password: 'Pass1234' });
  return { token: r.accessToken, user: r.user };
}

function ledgerBalanced(entries) {
  const d = entries.filter((e) => e.direction === 'debit').reduce((a, b) => a + Number(b.amount), 0);
  const c = entries.filter((e) => e.direction === 'credit').reduce((a, b) => a + Number(b.amount), 0);
  return Math.abs(d - c) <= 0.02;
}

async function main() {
  // ---- 今晚时间线锚点：T0 = 10 分钟后（整秒），所有现场事件以此为准 ----
  const T0 = new Date(Math.ceil((Date.now() + 10 * 60000) / 60000) * 60000);
  const at = (min) => new Date(T0.getTime() + min * 60000).toISOString();
  const windowStart = at(-30);
  const windowEnd = at(380);

  console.log('== 1. 登录、发券、物业审核队列 ==');
  const owner = await login('owner1');
  const owner2 = await login('owner2');
  const driver1 = await login('driver1');
  const driver2 = await login('driver2');
  const prop = await login('property1');
  const admin = await login('admin1');
  check('四类角色登录成功', !!(owner.token && driver1.token && driver2.token && prop.token && admin.token));

  // 为可重复执行，给 driver1 新发一张 10 元夜间券
  await api('POST', '/coupons/issue', admin.token, { user_id: driver1.user.id, amount: 10, code: `NIGHT${RUN}` });
  const coupons = await api('GET', '/coupons', driver1.token);
  const coupon = coupons.find((c) => !c.used_at && Number(c.amount) === 10);

  // driver2 补录一辆新能源车（用于同车位当晚第二单）
  const ne2 = await api('POST', '/vehicles', driver2.token, {
    plate: `沪E${RUN.slice(0, 5)}`,
    plate_color: '绿牌',
    is_new_energy: true,
  });

  const windows = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_time: '00:00', end_time: '23:59' }));
  const codes = { A: `E${RUN}1`, B: `E${RUN}2`, C: `E${RUN}3`, D: `E${RUN}4` };
  async function publish(code, opts = {}) {
    return api('POST', '/spots', owner.token, {
      community_id: 1,
      code,
      location_desc: `冒烟车位 ${code}`,
      near_charger: opts.charger ?? false,
      charger_power_kw: opts.charger ? 7 : undefined,
      allow_visitor: true,
      monthly_priority: opts.monthly ?? false,
      hourly_rate: 5,
      overnight_cap: 45,
      windows,
    });
  }
  const [spotA, spotB, spotC, spotD] = await Promise.all([
    publish(codes.A, { charger: true, monthly: true }),
    publish(codes.B),
    publish(codes.C),
    publish(codes.D, { charger: true }),
  ]);
  check('业主发布 4 个车位，初始待审核', spotA.review_status === 'pending');
  for (const s of [spotA, spotB, spotC, spotD]) {
    await api('POST', `/spots/${s.id}/review`, prop.token, { pass: true, remark: '产权材料齐全' });
  }
  const approved = await api('GET', `/spots/${spotA.id}`, prop.token);
  check('物业审核通过后车位可预约', approved.review_status === 'approved');
  const openSpots = await api('GET', '/spots?community_id=1&need_charger=true', driver1.token);
  check('车主可按充电桩筛选可预约车位', openSpots.some((s) => s.id === spotA.id));

  const vehicles1 = await api('GET', '/vehicles', driver1.token);
  const neCar = vehicles1.find((v) => v.is_new_energy);
  const vehicles2 = await api('GET', '/vehicles', driver2.token);
  const visitorCar = vehicles2.find((v) => v.is_visitor);
  check('车辆档案：新能源月租车 / 访客车 / 第二辆新能源车就绪', !!neCar && !!visitorCar && !!ne2);

  console.log('== 2. 订单 A：识别入场 → 导航/信号差 → 充电离场，用券分账 ==');
  const reserveA = await api('POST', '/reservations', driver1.token, {
    spot_id: spotA.id,
    vehicle_id: neCar.id,
    start_at: at(0),
    end_at: at(180),
    coupon_id: coupon.id,
  });
  check('预约预估 3 小时费用 15 元', Number(reserveA.estimated_fee) === 15, reserveA.estimated_fee);
  check('10 元券抵扣后预付 5 元', reserveA.prepaid === 5 && reserveA.coupon_discount === 10, reserveA);

  const rec = await api('POST', '/operations/gate/recognize', prop.token, {
    plate: neCar.plate,
    gate: '南门入口',
    confidence: 0.96,
  });
  check('道闸车牌识别命中预约并返回导航引导', rec.admitted === true && !!rec.guidance?.voice, rec);
  const recFail = await api('POST', '/operations/gate/recognize', prop.token, {
    plate: '沪UNKNOWN',
    gate: '南门入口',
    confidence: 0.4,
  });
  check('陌生车牌/低置信度拒绝入场并生成识别失败工单', recFail.admitted === false && !!recFail.ticket_id);

  await api('POST', '/operations/gate/admit', prop.token, {
    reservation_id: reserveA.id,
    plate: neCar.plate,
    gate: '南门入口',
    mode: 'auto',
    entry_at: at(0),
  });
  const sig = await api('POST', `/operations/reservations/${reserveA.id}/report-signal`, driver1.token, {
    area: 'B2 层 E 区',
  });
  check('地下车库信号差：下发离线导航提示', sig.offline_tip.includes('离线'));
  const parkedA = await api('POST', `/operations/reservations/${reserveA.id}/parked`, driver1.token, {
    actual_spot_code: codes.A,
    parked_at: at(0),
  });
  check('正常停放确认无误判', parkedA.wrong_parking === false);

  const stA = await api('POST', `/reservations/${reserveA.id}/exit`, driver1.token, {
    charge_kwh: 20,
    exit_at: at(180),
  });
  check('A 离场生成结算单', stA.code?.startsWith('ST'));
  check('A 充电费 20kWh × 1.2 = 24 元', Number(stA.charging_fee) === 24);
  check('A 券抵扣 10 元落账', Number(stA.coupon_discount) === 10);
  check('A 业主分成按 70% 计提（39 元池 → 27.3）', Number(stA.owner_income) >= 27.2 && Number(stA.owner_income) <= 27.4, stA.owner_income);
  check('A 离场补缴 24 元（充电费），无退款', Number(stA.exit_charge) === 24 && Number(stA.refund) === 0, stA);
  check('A 资金流水借贷平衡', ledgerBalanced(stA.ledger));

  console.log('== 3. 订单 A2：同一充电位当晚第二单（第二位车主、另一辆新能源车）==');
  const reserveA2 = await api('POST', '/reservations', driver2.token, {
    spot_id: spotA.id,
    vehicle_id: ne2.id,
    start_at: at(190),
    end_at: at(300),
  });
  await api('POST', '/operations/gate/admit', prop.token, {
    reservation_id: reserveA2.id,
    plate: ne2.plate,
    gate: '南门入口',
    mode: 'auto',
    entry_at: at(190),
  });
  await api('POST', `/operations/reservations/${reserveA2.id}/parked`, driver2.token, {
    actual_spot_code: codes.A,
    parked_at: at(195),
  });
  const stA2 = await api('POST', `/reservations/${reserveA2.id}/exit`, driver2.token, { exit_at: at(300) });
  check('A2 离场结算完成', stA2.code?.startsWith('ST'));

  const tlA = await api('GET', `/spots/${spotA.id}/timeline?start=${encodeURIComponent(windowStart)}&end=${encodeURIComponent(windowEnd)}`, driver1.token);
  check('时间轴覆盖当晚两笔订单', tlA.orders.length === 2, tlA.orders.map((o) => o.code));
  const driverSegs = tlA.segments.filter((s) => s.occupantKind === 'driver');
  check(
    '时间轴解释两段使用分别由两位车主使用、各自付费',
    new Set(driverSegs.map((s) => s.reservationId)).size === 2 &&
      driverSegs.every((s) => s.payer.includes('计费')),
    driverSegs.map((s) => `${s.occupant}#${s.reservationId}/${s.payer}`),
  );

  console.log('== 4. 订单 B：人工放行 → 停错车位 → 挪车通知 → 证据链裁决车主责任 → 违约金分账 ==');
  const reserveB = await api('POST', '/reservations', driver2.token, {
    spot_id: spotB.id,
    vehicle_id: visitorCar.id,
    start_at: at(0),
    end_at: at(120),
  });
  await api('POST', '/operations/gate/admit', prop.token, {
    reservation_id: reserveB.id,
    plate: visitorCar.plate,
    gate: '北门入口',
    mode: 'manual',
    note: '车主报识别失败，核对预约码后人工放行',
    entry_at: at(0),
  });
  const parkedB = await api('POST', `/operations/reservations/${reserveB.id}/parked`, driver2.token, {
    actual_spot_code: `E${RUN}9`,
    note: '跟着其他车辆下到 B1',
    parked_at: at(10),
  });
  check('停放核验识别出错停并自动开工单', parkedB.wrong_parking === true);

  const openInc = await api('GET', '/dispatch/incidents?status=open', prop.token);
  const wrongTicket = openInc.find((t) => t.type === 'wrong_parking' && t.reservation_id === reserveB.id);
  check('夜间调度看板收到错停工单', !!wrongTicket, openInc.map((t) => `${t.type}:${t.reservation_id}`));
  await api('POST', `/dispatch/incidents/${wrongTicket.id}/notify`, prop.token, {
    message: '请 10 分钟内挪车至预约车位',
  });
  const notices = await api('GET', `/dispatch/incidents/${wrongTicket.id}/notices`, prop.token);
  check('挪车通知已送达', notices.length >= 1 && !!notices[0].delivered_at);

  const appealB = await api('POST', '/appeals', driver2.token, {
    reservation_id: reserveB.id,
    reason: '现场指示不清导致停错，申请免除违约金',
    evidence: [
      {
        source: 'photo',
        title: '现场照片',
        content: '地面箭头磨损',
        captured_at: at(12),
        stance: 'support',
      },
    ],
  });
  check('申诉自动汇聚车牌识别/道闸/预约证据并给出建议', !!appealB.adjudication.ruling, appealB.adjudication);
  check('自动裁决建议为车主责任', appealB.adjudication.ruling === 'driver_fault', appealB.adjudication.ruling);
  await api('POST', `/appeals/${appealB.appeal.id}/rule`, prop.token, {
    ruling: 'driver_fault',
    note: '车牌识别与停放核验均证明停错车位，证据充分',
  });
  const stB = await api('POST', `/reservations/${reserveB.id}/exit`, driver2.token, { exit_at: at(120) });
  check('B 错停违约金 50 元', Number(stB.wrong_park_fine) === 50);
  check('B 其中 30 元补偿业主', Number(stB.owner_compensation) === 30);
  check('B 车主信用 -10', Number(stB.credit_delta) === -10 && stB.credit_target === 'driver');
  check('B 流水含业主错停补偿', stB.ledger.some((l) => l.account.startsWith('owner') && l.memo.includes('错停补偿')));
  check('B 流水借贷平衡', ledgerBalanced(stB.ledger));
  const me2 = await api('GET', '/auth/me', driver2.token);
  check('B 车主信用分落库（本段 -10）', me2.credit_score === driver2.user.creditScore - 10, `${driver2.user.creditScore}->${me2.credit_score}`);

  console.log('== 5. 订单 C：业主临时回家 → 挪车协调 → 判业主责任 → 业主补偿车主并扣信用 ==');
  const reserveC = await api('POST', '/reservations', driver1.token, {
    spot_id: spotC.id,
    vehicle_id: neCar.id,
    start_at: at(0),
    end_at: at(240),
  });
  await api('POST', '/operations/gate/admit', prop.token, {
    reservation_id: reserveC.id,
    plate: neCar.plate,
    gate: '南门入口',
    mode: 'manual',
    entry_at: at(0),
  });
  await api('POST', `/operations/reservations/${reserveC.id}/parked`, driver1.token, {
    actual_spot_code: codes.C,
    parked_at: at(5),
  });
  const ownerReturn = await api('POST', '/dispatch/owner-return', owner.token, {
    spot_id: spotC.id,
    eta_minutes: 20,
    note: '临时有客人要送回家',
    occurred_at: at(90),
  });
  check('业主回家自动通知在场车主并开工单', !!ownerReturn.ticket && ownerReturn.ticket.status === 'notified');
  await api('POST', `/dispatch/incidents/${ownerReturn.ticket.id}/resolve`, prop.token, {
    resolution: '车主已配合挪车至临时车位，业主自用',
    resolved_at: at(100),
  });
  const appealC = await api('POST', '/appeals', driver1.token, {
    reservation_id: reserveC.id,
    reason: '业主突然回家要求挪车，服务中断',
  });
  check('系统依据业主回家时间证据自动建议业主责任', appealC.adjudication.ruling === 'owner_fault', appealC.adjudication);
  await api('POST', `/appeals/${appealC.appeal.id}/rule`, prop.token, {
    ruling: 'owner_fault',
    note: '共享时段内业主回家违约成立',
  });
  const stC = await api('POST', `/reservations/${reserveC.id}/exit`, driver1.token, { exit_at: at(100) });
  check('C 按实际可用时长计费（85 分钟）', stC.duration_minutes === 85, stC.duration_minutes);
  check('C 业主现金补偿车主 20 元并随退款发放', Number(stC.abnormal_compensation) === 20 && Number(stC.refund) > 20, stC);
  check('C 流水借贷平衡', ledgerBalanced(stC.ledger));
  const reC = await api('POST', `/appeals/${appealC.appeal.id}/resettle`, prop.token);
  check('终裁后可重算分账且借贷仍平衡', reC.code?.startsWith('ST') && ledgerBalanced(reC.ledger));
  const meOwner = await api('GET', '/auth/me', owner.token);
  check('业主信用分落库（本段 -5）', meOwner.credit_score === owner.user.creditScore - 5, `${owner.user.creditScore}->${meOwner.credit_score}`);

  console.log('== 6. 订单 D：陌生车占用充电位 → 巡查/挪车通知 → 时间轴归责 → 平台兜底赔付与追缴 ==');
  const reserveD = await api('POST', '/reservations', driver1.token, {
    spot_id: spotD.id,
    vehicle_id: neCar.id,
    start_at: at(0),
    end_at: at(120),
  });
  const patrol = await api('POST', '/operations/patrol', prop.token, {
    spot_id: spotD.id,
    plate: '沪X99999',
    finding: 'stranger',
    note: '夜间巡查发现陌生车辆占用已预约充电位',
    media_url: `evidence/patrol-${RUN}.jpg`,
    patrolled_at: at(0),
  });
  await api('POST', `/dispatch/incidents/${patrol.ticket_id}/notify`, prop.token);
  const tlD = await api(
    'GET',
    `/spots/${spotD.id}/timeline?start=${encodeURIComponent(at(-30))}&end=${encodeURIComponent(at(130))}`,
    prop.token,
  );
  const strangerSeg = tlD.segments.find((s) => s.occupantKind === 'stranger');
  check(
    '时间轴明确标出陌生车占用段：预约车主不计费、平台兜底、向陌生车主追缴',
    !!strangerSeg && strangerSeg.plate === '沪X99999' && strangerSeg.payer.includes('平台兜底') && strangerSeg.liability.includes('陌生车主'),
    strangerSeg,
  );
  await api('POST', `/dispatch/incidents/${patrol.ticket_id}/resolve`, prop.token, {
    resolution: '联系到陌生车主，已驶离',
    resolved_at: at(30),
  });
  const appealD = await api('POST', '/appeals', driver1.token, {
    reservation_id: reserveD.id,
    reason: '到场发现车位被陌生车占用，无法停车',
  });
  check('巡查+车牌证据自动建议陌生车责任', appealD.adjudication.ruling === 'stranger', appealD.adjudication);
  await api('POST', `/appeals/${appealD.appeal.id}/rule`, prop.token, {
    ruling: 'stranger',
    note: '巡查照片+车牌识别确认陌生车占用',
  });
  const stD = await api('POST', `/reservations/${reserveD.id}/exit`, driver1.token, { exit_at: at(120) });
  check('D 判陌生车责任：服务费全免', Number(stD.base_fee) === 0);
  check('D 平台先行赔付业主 30 元', Number(stD.owner_compensation) === 30);
  check('D 现金补偿车主 20 元并退还预付', Number(stD.abnormal_compensation) === 20 && Number(stD.refund) >= 20);
  check('D 不影响预约车主信用', stD.credit_delta === 0 || stD.credit_target === 'none', stD);
  check('D 流水含平台先行赔付（追缴）记录', stD.ledger.some((l) => l.memo.includes('先行赔付')));
  check('D 流水借贷平衡', ledgerBalanced(stD.ledger));

  console.log('== 7. 业主提前回家抢占处理：评估 → 换位 / 物业协调 / 违约补偿 → 发布记录与时段审核 ==');
  // 5 个新车位：R1/R2 换位场景，R3/R4 拒绝+物业协调场景，R5 充电位（制造无法替换场景）
  const rcodes = { R1: `F${RUN}1`, R2: `F${RUN}2`, R3: `F${RUN}3`, R4: `F${RUN}4`, R5: `F${RUN}5`, R6: `F${RUN}6` };
  const publishedR = {};
  for (const [k, code] of Object.entries(rcodes)) {
    publishedR[k] = await publish(code, { charger: k === 'R5' });
    await api('POST', `/spots/${publishedR[k].id}/review`, prop.token, { pass: true, remark: '产权材料齐全' });
  }

  // --- 7.1 可替换：车主已入场，业主提前回家，平台匹配替代车位，车主接受换位 ---
  const reserveR1 = await api('POST', '/reservations', driver1.token, {
    spot_id: publishedR.R1.id, vehicle_id: neCar.id, start_at: at(0), end_at: at(120),
  });
  await api('POST', '/operations/gate/admit', prop.token, {
    reservation_id: reserveR1.id, plate: neCar.plate, gate: '南门入口', mode: 'auto', entry_at: at(0),
  });
  await api('POST', `/operations/reservations/${reserveR1.id}/parked`, driver1.token, {
    actual_spot_code: rcodes.R1, parked_at: at(5),
  });
  const retR1 = await api('POST', '/dispatch/owner-return', owner.token, {
    spot_id: publishedR.R1.id, eta_minutes: 10, occurred_at: at(60),
  });
  check('抢占评估：预约车辆已入场并给出剩余时长（约60分钟）', retR1.assessment.car_on_site === true && retR1.assessment.remaining_minutes === 60, retR1.assessment);
  check('抢占评估：历史提前结束次数计入（含订单C后为第2次）且升为中风险', retR1.record.early_termination_count === 2 && retR1.risk.level === 'medium', retR1.risk);
  check('抢占评估：匹配到附近可替代车位', retR1.can_replace === true && retR1.candidates.length >= 1, retR1);
  const offerR2 = retR1.candidates.find((c) => Number(c.spot_id) === Number(publishedR.R2.id));
  check('替代车位含换位导航与¥15费用补偿', !!offerR2 && Number(offerR2.fee_compensation) === 15 && offerR2.navigation?.voice.includes(rcodes.R2), offerR2);

  const accept = await api('POST', `/dispatch/relocations/${offerR2.offer_id}/respond`, driver1.token, {
    accept: true, relocate_at: at(62),
  });
  check('接受换位：原单按业主上报时点截止实际可用时长（停放5分→上报60分=55分钟）', accept.origin_settlement.duration_minutes === 55, accept.origin_settlement.duration_minutes);
  check('接受换位：业主支付¥15换位费用补偿（低于违约¥20）', Number(accept.origin_settlement.abnormal_compensation) === 15, accept.origin_settlement);
  check('接受换位：原单资金流水借贷平衡', ledgerBalanced(accept.origin_settlement.ledger));
  check('接受换位：生成替代车位新预约且入场状态延续', Number(accept.new_reservation.spot_id) === Number(publishedR.R2.id) && accept.new_reservation.status === 'admitted', accept.new_reservation);
  check('接受换位：发放换位补差券（新车位剩余窗口约¥4.83）', Number(accept.topup_coupon) > 4.7 && Number(accept.topup_coupon) < 5, accept.topup_coupon);
  const myOffers = await api('GET', '/dispatch/my-relocations', driver1.token);
  check('车主可查到换位方案且状态为已接受、绑定新预约', myOffers.some((o) => o.id === offerR2.offer_id && o.status === 'accepted' && !!o.new_reservation_id));
  const recordsAfterR1 = await api('GET', '/dispatch/owner-records', owner.token);
  check('提前结束已写入业主发布记录（标记已换位）', recordsAfterR1.records.some((r) => r.spot_code === rcodes.R1 && r.resolution === 'relocated' && r.detail?.outcome?.relocated_to === rcodes.R2));

  // --- 7.2 车主拒绝全部方案 → 业主申请物业协调 → 物业协调到 R4 并代确认 ---
  const reserveR3 = await api('POST', '/reservations', driver1.token, {
    spot_id: publishedR.R3.id, vehicle_id: neCar.id, start_at: at(0), end_at: at(120),
  });
  await api('POST', '/operations/gate/admit', prop.token, {
    reservation_id: reserveR3.id, plate: neCar.plate, gate: '南门入口', mode: 'auto', entry_at: at(0),
  });
  await api('POST', `/operations/reservations/${reserveR3.id}/parked`, driver1.token, {
    actual_spot_code: rcodes.R3, parked_at: at(5),
  });
  const retR3 = await api('POST', '/dispatch/owner-return', owner.token, {
    spot_id: publishedR.R3.id, eta_minutes: 10, occurred_at: at(70),
  });
  check('第二次抢占：历史次数=3、风险升级为中风险', retR3.record.early_termination_count === 3 && retR3.risk.level === 'medium', retR3.risk);
  for (const c of retR3.candidates) {
    await api('POST', `/dispatch/relocations/${c.offer_id}/respond`, driver1.token, { accept: false, reason: '不想挪车' });
  }
  const dec3 = await api('POST', `/dispatch/owner-records/${retR3.record.id}/decision`, owner.token, {
    action: 'property_coordination', note: '请物业帮忙协调',
  });
  check('业主提交物业协调请求', dec3.resolution === 'property_coordinating' && !!dec3.coordination?.id);
  const pendingCoord = await api('GET', '/dispatch/coordinations?status=pending', prop.token);
  const coord = pendingCoord.find((x) => x.record_code === retR3.record.code);
  check('物业协调队列收到请求并带风险/历史次数', !!coord && coord.early_termination_count === 3, pendingCoord.map((x) => x.record_code));
  const handled = await api('POST', `/dispatch/coordinations/${coord.id}/handle`, prop.token, {
    action: 'relocated', spot_id: publishedR.R4.id, note: '电话确认后引导至 F 系列空位', relocate_at: at(72),
  });
  check('物业协调成功：代车主确认换位至新车位', handled.status === 'relocated' && Number(handled.new_reservation.spot_id) === Number(publishedR.R4.id), handled);
  check('物业协调换位：原单¥15补偿且流水平衡', Number(handled.origin_settlement.abnormal_compensation) === 15 && ledgerBalanced(handled.origin_settlement.ledger));
  const recordsAfterR3 = await api('GET', '/dispatch/owner-records', owner.token);
  check('发布记录标记为物业协调换位（coordinated）', recordsAfterR3.records.some((r) => r.spot_code === rcodes.R3 && r.resolution === 'coordinated'));

  // --- 7.3 无法替换：充电位车主，占用全部其他充电位，业主只能等待/违约/协调 ---
  // 用第二位车主把其余三个充电位（种子 B2-108、冒烟 A、D）在该窗口全部占住
  const chargerSpots = await api('GET', '/spots?community_id=1&need_charger=true', driver1.token);
  const otherChargers = chargerSpots.filter((s) => s.id !== publishedR.R5.id);
  check('场内至少存在 2 个其他充电位可用于制造占满', otherChargers.length >= 2, otherChargers.map((s) => s.code));
  for (const s of otherChargers) {
    // 用与换位匹配完全相同的窗口 [80,120] 占位：能约上则该位恰好变忙；
    // 若因共享时段不覆盖而约不上，该窗口同样不可能通过候选校验，保证 can_replace 确定性
    try {
      await api('POST', '/reservations', driver2.token, {
        spot_id: s.id, vehicle_id: ne2.id, start_at: at(80), end_at: at(120),
      });
    } catch { /* 该充电位在换位窗口不开放，不可能成为替代候选 */ }
  }
  const reserveR5 = await api('POST', '/reservations', driver1.token, {
    spot_id: publishedR.R5.id, vehicle_id: neCar.id, start_at: at(0), end_at: at(120),
  });
  await api('POST', '/operations/gate/admit', prop.token, {
    reservation_id: reserveR5.id, plate: neCar.plate, gate: '南门入口', mode: 'auto', entry_at: at(0),
  });
  await api('POST', `/operations/reservations/${reserveR5.id}/parked`, driver1.token, {
    actual_spot_code: rcodes.R5, parked_at: at(5),
  });
  const retR5 = await api('POST', '/dispatch/owner-return', owner.token, {
    spot_id: publishedR.R5.id, eta_minutes: 10, occurred_at: at(80),
  });
  check('其他充电位占满时无可替代车位（can_replace=false）', retR5.can_replace === false, retR5.candidates?.map((c) => c.spot_code));
  check('无法替换时向业主给出等待/违约补偿/物业协调三选项', JSON.stringify(retR5.alternatives) === JSON.stringify(['owner_wait', 'breach_pay', 'property_coordination']));
  const breach = await api('POST', `/dispatch/owner-records/${retR5.record.id}/decision`, owner.token, {
    action: 'breach_pay', decided_at: at(82),
  });
  check('业主支付违约补偿：原单按实际时长（停放5分→上报80分=75分钟）结算并补偿¥20', Number(breach.settlement.abnormal_compensation) === 20 && breach.settlement.duration_minutes === 75, breach.settlement);
  check('违约补偿单流水借贷平衡', ledgerBalanced(breach.settlement.ledger));
  const recordsFinal = await api('GET', '/dispatch/owner-records', owner.token);
  check('业主发布记录累计 4 次抢占（含订单C）且最近一次为 breach_paid', recordsFinal.summary.last_90d >= 4 && recordsFinal.records.some((r) => r.spot_code === rcodes.R5 && r.resolution === 'breach_paid'), recordsFinal.summary);

  // --- 7.4 后续开放时段审核：高风险业主转人工，物业可限制缩短；零记录业主自动通过 ---
  const applyRisky = await api('POST', `/spots/${publishedR.R5.id}/share-windows`, owner.token, {
    windows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_time: '00:00', end_time: '23:59' })),
    reason: '希望全天开放',
  });
  check('高风险业主追加开放时段进入人工审核队列（不自动生效）', applyRisky.status === 'pending' && applyRisky.risk_level === 'high', applyRisky);
  const pendingWin = await api('GET', '/spots/share-windows/pending', prop.token);
  const wr = pendingWin.find((w) => w.spot_code === rcodes.R5);
  check('物业审核队列展示风险等级与提前结束次数', !!wr && wr.early_termination_count >= 4, pendingWin.map((w) => w.spot_code));
  await api('POST', `/spots/share-windows/${wr.id}/handle`, prop.token, {
    decision: 'restricted',
    windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_time: '19:00', end_time: '22:00' })),
    note: '提前结束频繁，先限缩为工作日夜间 3 小时观察',
  });
  const spotR5After = await api('GET', `/spots/${publishedR.R5.id}`, prop.token);
  check('限制通过后时段按物业裁剪生效（仅工作日 19:00-22:00）',
    spotR5After.windows.length === 5 && spotR5After.windows.every((w) => String(w.start_time).slice(0, 5) === '19:00' && String(w.end_time).slice(0, 5) === '22:00'),
    spotR5After.windows);
  const owner2Spots = await api('GET', '/spots/mine', owner2.token);
  const owner2Spot = owner2Spots.find((s) => s.review_status === 'approved');
  const applyOwner2 = await api('POST', `/spots/${owner2Spot.id}/share-windows`, owner2.token, {
    windows: [{ weekday: 6, start_time: '09:00', end_time: '22:00' }],
  });
  check('零提前结束记录业主调整时段系统自动通过', applyOwner2.status === 'auto_approved', applyOwner2);

  // --- 7.5 业主选择等待：共享实际未中断，车主停满原窗口全额计费、无补偿、不记提前结束次数 ---
  const reserveR6 = await api('POST', '/reservations', driver1.token, {
    spot_id: publishedR.R6.id, vehicle_id: neCar.id, start_at: at(0), end_at: at(120),
  });
  await api('POST', '/operations/gate/admit', prop.token, {
    reservation_id: reserveR6.id, plate: neCar.plate, gate: '南门入口', mode: 'auto', entry_at: at(0),
  });
  await api('POST', `/operations/reservations/${reserveR6.id}/parked`, driver1.token, {
    actual_spot_code: rcodes.R6, parked_at: at(5),
  });
  const retR6 = await api('POST', '/dispatch/owner-return', owner.token, {
    spot_id: publishedR.R6.id, eta_minutes: 20, occurred_at: at(40),
  });
  check('等待场景：平台同样给出在场评估与候选方案', retR6.assessment.car_on_site === true && retR6.can_replace === true);
  await api('POST', `/dispatch/owner-records/${retR6.record.id}/decision`, owner.token, { action: 'owner_wait' });
  const stR6 = await api('POST', `/reservations/${reserveR6.id}/exit`, driver1.token, { exit_at: at(120) });
  check('业主等待：车主停满原窗口（停放5分→120分=115分钟）全额计费', stR6.duration_minutes === 115 && Number(stR6.basefee ?? stR6.base_fee) >= 9, stR6);
  check('业主等待：无任何违约/换位补偿、不扣信用', Number(stR6.abnormal_compensation) === 0 && stR6.credit_delta === 0, stR6);
  check('业主等待：流水借贷平衡', ledgerBalanced(stR6.ledger));
  const recordsAfterWait = await api('GET', '/dispatch/owner-records', owner.token);
  check('选择等待计入发布记录但不计入90天提前结束风控次数（仍为4次）',
    recordsAfterWait.summary.total === 5 && recordsAfterWait.summary.last_90d === 4, recordsAfterWait.summary);

  console.log('== 8. 共同追溯：分账流水、调度总览、单订单全链路事件、巡查档案 ==');
  const ledger = await api('GET', '/ledger', prop.token);
  check(
    '分账流水覆盖车主/业主/物业/平台/券池/托管账户',
    ['escrow', 'property', 'platform', 'coupon_pool'].every((a) => ledger.some((l) => l.account === a || l.account.startsWith(a))),
  );
  check('业主流水包含补偿与分成收款', ledger.some((l) => l.account.startsWith('owner:') && l.direction === 'credit'));
  check('券池流水记录优惠券出资', ledger.some((l) => l.account === 'coupon_pool' && l.direction === 'debit'));

  const overview = await api('GET', '/dispatch/overview', prop.token);
  check('调度总览统计异常工单', Array.isArray(overview.incidents_24h) && overview.incidents_24h.length > 0);

  const detailA = await api('GET', `/reservations/${reserveA.id}`, driver1.token);
  check(
    '单订单全链路可追溯：预约/入场/信号/停放/结算事件齐全',
    ['reservation_created', 'gate_entry', 'weak_signal_report', 'parking_confirmed', 'settlement_completed'].every(
      (t) => detailA.events.some((e) => e.type === t),
    ),
    detailA.events.map((e) => e.type),
  );
  const appealDetail = await api('GET', `/appeals/${appealB.appeal.id}`, prop.token);
  check(
    '错停申诉档案含六类证据来源中的车牌识别/道闸/预约/陈述/照片',
    ['plate_recognition', 'gate_log', 'reservation', 'appeal_statement', 'photo'].every((src) =>
      appealDetail.evidence.concat(
        appealDetail.adjudication.evidenceTimeline.map((e) => ({ source: e.source })),
      ).some((e) => e.source === src),
    ),
    appealDetail.evidence.map((e) => e.source),
  );
  const patrolLogs = await api('GET', '/operations/patrol?spot_id=' + spotD.id, prop.token);
  check('物业巡查记录可查并关联现场照片', patrolLogs.some((p) => p.note.includes('陌生车辆') && p.media_url));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('SMOKE_OK');
}

main().catch((e) => {
  console.error('SMOKE_FATAL', e);
  process.exit(1);
});
