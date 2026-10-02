// 业主提前回家抢占处理（纯函数领域引擎）
// 流程：评估在场状态与剩余时长 → 统计历史提前结束次数与风险 →
//       匹配附近可替代车位 → 给出换位方案（导航 + 费用补偿）或业主三选一（等待/违约补偿/物业协调）。

import { intervalsOverlap, isIntervalCovered, ShareWindow } from './availability';

export const RELOCATION = {
  feeCompensation: 15, // 成功换位时业主向车主支付的费用补偿（现金，随原单退款发放）
  breachCompensation: 20, // 无法替换且业主选择违约时的补偿（与 pricing.ownerReturnCompensation 一致）
  maxCandidates: 3, // 最多下发候选车位数
  acceptWindowMinutes: 15, // 车主确认换位的有效窗口
  historyWindowDays: 90, // 历史提前结束次数统计窗口
};

export type RiskLevel = 'low' | 'medium' | 'high';
export type ReturnResolution =
  | 'pending'
  | 'relocated' // 平台直接匹配替代车位，车主已接受
  | 'owner_wait' // 业主选择等待，放弃本次提前收回
  | 'breach_paid' // 业主支付违约补偿强制收回
  | 'property_coordinating' // 业主申请物业协调中
  | 'coordinated' // 物业协调出替代车位
  | 'cancelled';

export interface ActiveReservationLike {
  id: number;
  code: string;
  spotId: number;
  plate: string;
  status: string;
  startAt: Date;
  endAt: Date;
  gateEntryAt?: Date | null;
  parkingConfirmedAt?: Date | null;
  isNewEnergy: boolean;
  isVisitor: boolean;
  isMonthly: boolean;
}

export interface CandidateSpot {
  id: number;
  code: string;
  communityId: number;
  originSpotId: number;
  locationDesc: string | null;
  nearCharger: boolean;
  chargerPowerKw: number | null;
  allowVisitor: boolean;
  monthlyPriority: boolean;
  hourlyRate: number;
  overnightCap: number | null;
  reviewStatus: string;
  active: boolean;
  windows: ShareWindow[];
  busyRanges: Array<{ start: Date; end: Date }>;
}

export interface ReservationAssessment {
  carOnSite: boolean; // 当前预约车辆是否已入场（道闸入场或停放确认）
  admitted: boolean;
  parked: boolean;
  elapsedMinutes: number; // 已使用时长（自入场起）
  remainingMinutes: number; // 剩余停车时长（到预约结束）
  reservedWindowMinutes: number;
}

export interface RelocationMatch {
  candidate: CandidateSpot;
  distanceM: number;
  matchScore: number; // 0~100，仅用于排序与解释
  scoreReasons: string[];
  compatible: boolean;
  rejectReason?: string;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const minuteMs = 60000;

/** 评估预约车辆的在场状态、已用/剩余停车时长 */
export function assessReservation(r: ActiveReservationLike, now: Date): ReservationAssessment {
  const admitted = !!r.gateEntryAt || ['admitted', 'in_garage'].includes(r.status);
  const parked = !!r.parkingConfirmedAt || r.status === 'in_garage';
  const usageStart = r.parkingConfirmedAt ?? r.gateEntryAt ?? r.startAt;
  return {
    carOnSite: admitted,
    admitted,
    parked,
    elapsedMinutes: Math.round(Math.max(0, (now.getTime() - new Date(usageStart).getTime()) / minuteMs)),
    remainingMinutes: Math.round(Math.max(0, (new Date(r.endAt).getTime() - now.getTime()) / minuteMs)),
    reservedWindowMinutes: Math.round((new Date(r.endAt).getTime() - new Date(r.startAt).getTime()) / minuteMs),
  };
}

/**
 * 风险分级：90 天内历史提前结束次数越多越谨慎；
 * 偶发一次但提前 3 小时以上收回同样升为中风险。
 */
export function evaluateReturnRisk(historyCount: number, earlyMinutes: number): RiskLevel {
  if (historyCount >= 4) return 'high';
  if (historyCount >= 2) return 'medium';
  if (historyCount >= 1 && earlyMinutes >= 180) return 'medium';
  return 'low';
}

export const RISK_LABEL: Record<RiskLevel, string> = {
  low: '低风险（审核从宽）',
  medium: '中风险（开放时段需人工复核）',
  high: '高风险（开放时段从严，可能临时限缩共享窗口）',
};

/** 从车位编号/位置描述估算两车位步行距离（米），纯启发式用于"附近"排序 */
export function estimateDistance(originCode: string, originLoc: string | null, otherCode: string, otherLoc: string | null): number {
  const floorOf = (code: string) => {
    const m = /^([A-Za-z]?\d+)/.exec(code.trim());
    return m ? m[1].toUpperCase() : code.toUpperCase();
  };
  const numOf = (code: string) => {
    const m = /(\d+)\s*$/.exec(code.replace(/[^\d]/g, ' ').trim());
    return m ? Number(m[1]) : NaN;
  };
  const f1 = floorOf(originCode);
  const f2 = floorOf(otherCode);
  const n1 = numOf(originCode);
  const n2 = numOf(otherCode);
  let dist = 30;
  if (f1 === f2) {
    if (!Number.isNaN(n1) && !Number.isNaN(n2)) dist = 25 + Math.abs(n1 - n2) * 8;
  } else {
    // 不同楼层/区域：至少跨层绕行
    dist = 160 + (Number.isNaN(n1) || Number.isNaN(n2) ? 0 : Math.abs(n1 - n2) * 6);
  }
  // 位置描述中的分区信息（如"地下二层 B 区"）一致则拉近
  const zoneOf = (loc: string | null) => (loc ? /([A-Z])\s*区/.exec(loc)?.[1] ?? null : null);
  if (zoneOf(originLoc) && zoneOf(originLoc) === zoneOf(otherLoc)) dist = Math.max(20, dist - 25);
  return dist;
}

/** 单个候选车位的兼容性判定与评分（不可行时 compatible=false 并给出原因） */
export function scoreCandidate(
  candidate: CandidateSpot,
  need: { isNewEnergy: boolean; needCharger: boolean; isVisitor: boolean; isMonthly: boolean; originHourlyRate: number },
  window: { start: Date; end: Date },
  distanceM: number,
): RelocationMatch {
  const reasons: string[] = [];
  if (candidate.id === candidate.originSpotId)
    return { candidate, distanceM, matchScore: 0, scoreReasons: [], compatible: false, rejectReason: '原车位' };
  if (candidate.reviewStatus !== 'approved' || !candidate.active)
    return { candidate, distanceM, matchScore: 0, scoreReasons: [], compatible: false, rejectReason: '车位未审核通过或已停共享' };
  if (need.needCharger && !candidate.nearCharger)
    return { candidate, distanceM, matchScore: 0, scoreReasons: [], compatible: false, rejectReason: '车主有充电需求，候选位无充电桩' };
  if (candidate.nearCharger && !need.isNewEnergy)
    return { candidate, distanceM, matchScore: 0, scoreReasons: [], compatible: false, rejectReason: '候选为充电车位，燃油车辆不可停放' };
  if (need.isVisitor && !candidate.allowVisitor)
    return { candidate, distanceM, matchScore: 0, scoreReasons: [], compatible: false, rejectReason: '候选车位不接待访客车' };
  if (!isIntervalCovered(window.start, window.end, candidate.windows))
    return { candidate, distanceM, matchScore: 0, scoreReasons: [], compatible: false, rejectReason: '剩余停车时段不落在候选车位共享窗口内' };
  if (candidate.busyRanges.some((b) => intervalsOverlap(b.start, b.end, window.start, window.end)))
    return { candidate, distanceM, matchScore: 0, scoreReasons: [], compatible: false, rejectReason: '候选车位在该时段已有预约' };

  let score = 0;
  if (distanceM <= 100) { score += 40; reasons.push(`距离仅约 ${distanceM} 米（+40）`); }
  else if (distanceM <= 250) { score += 30; reasons.push(`距离约 ${distanceM} 米（+30）`); }
  else if (distanceM <= 500) { score += 20; reasons.push(`距离约 ${distanceM} 米（+20）`); }
  else { score += 10; reasons.push(`距离约 ${distanceM} 米（+10）`); }

  if (candidate.hourlyRate <= need.originHourlyRate) { score += 25; reasons.push('费率不高于原车位（+25）'); }
  else if (candidate.hourlyRate <= need.originHourlyRate * 1.2) { score += 15; reasons.push('费率上浮不超过 20%（+15）'); }
  else { score += 5; reasons.push('费率高于原车位 20% 以上（+5）'); }

  if (need.needCharger) {
    score += candidate.nearCharger ? 10 : 0;
    if (candidate.nearCharger) reasons.push(`带充电桩 ${candidate.chargerPowerKw ?? ''}kW（+10）`);
  } else {
    score += 8;
    reasons.push('普通车位即满足需求（+8）');
  }
  if (need.isMonthly && candidate.monthlyPriority) { score += 5; reasons.push('支持月租车优先（+5）'); }
  if (candidate.overnightCap != null) reasons.push(`夜间封顶 ¥${candidate.overnightCap}`);

  return { candidate, distanceM, matchScore: score, scoreReasons: reasons, compatible: true };
}

/** 在同小区候选车位中筛出可替代车位并按匹配度排序，取前 N 个 */
export function findRelocationCandidates(
  candidates: CandidateSpot[],
  need: { isNewEnergy: boolean; needCharger: boolean; isVisitor: boolean; isMonthly: boolean; originHourlyRate: number; originCode: string; originLocationDesc: string | null },
  window: { start: Date; end: Date },
): { feasible: RelocationMatch[]; rejected: Array<{ code: string; reason: string }> } {
  const matches = candidates.map((c) =>
    scoreCandidate(
      c,
      need,
      window,
      estimateDistance(need.originCode, need.originLocationDesc, c.code, c.locationDesc),
    ),
  );
  const feasible = matches
    .filter((m) => m.compatible)
    .sort((a, b) => b.matchScore - a.matchScore || a.distanceM - b.distanceM)
    .slice(0, RELOCATION.maxCandidates);
  const rejected = matches
    .filter((m) => !m.compatible)
    .map((m) => ({ code: m.candidate.code, reason: m.rejectReason ?? '不可用' }));
  return { feasible, rejected };
}

/** 换位导航引导（原车位 → 新车位，含挪车时限） */
export function buildRelocationNavigation(opts: {
  originCode: string;
  targetCode: string;
  targetLocationDesc: string | null;
  targetNearCharger: boolean;
  distanceM: number;
  plate: string;
  communityName?: string;
}) {
  const expireTips = `请在 ${RELOCATION.acceptWindowMinutes} 分钟内完成挪车`;
  return {
    type: 'relocation' as const,
    community: opts.communityName ?? null,
    plate: opts.plate,
    origin_spot: opts.originCode,
    target_spot: opts.targetCode,
    distance_m: opts.distanceM,
    voice: `业主临时回家，已为您协调到替代车位 ${opts.targetCode}，距原车位约 ${opts.distanceM} 米，${expireTips}，跟随蓝色换位箭头行驶`,
    steps: [
      `${expireTips}：驶离原车位 ${opts.originCode}，出库后沿通道靠左行驶`,
      `跟随地面蓝色"换位引导"箭头行驶约 ${opts.distanceM} 米`,
      opts.targetLocationDesc ? `按标识到达新车位：${opts.targetLocationDesc}（车位号 ${opts.targetCode}）` : `按标识到达新车位 ${opts.targetCode}`,
      opts.targetNearCharger
        ? '新车位同样靠近充电桩，如需继续充电请重新连接充电枪'
        : '新车位为标准车位，减速倒车入位',
      '停好后在 App 点击"我已停到换位车位"，系统自动绑定新预约并发放费用补偿',
    ],
    offline_code: `MV-${opts.originCode}-${opts.targetCode}`.replace(/[^A-Za-z0-9-]/g, ''),
  };
}

/** 换位补差券金额：新车位剩余窗口的正常估价（夜间封顶），让车主不因换位多付停车费 */
export function relocationTopupFee(window: { start: Date; end: Date }, candidate: CandidateSpot): number {
  const hours = Math.max(0, (window.end.getTime() - window.start.getTime()) / 3600000);
  let fee = round2(hours * candidate.hourlyRate);
  if (candidate.overnightCap != null && fee > candidate.overnightCap) fee = candidate.overnightCap;
  return fee;
}
