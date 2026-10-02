import { assessPreemption, PREEMPTION } from '../src/domain/preemption';
import { settlePrice } from '../src/domain/pricing';

const T = (iso: string) => new Date(iso);

describe('assessPreemption：业主提前回家抢占评估', () => {
  const reservation = {
    id: 101,
    status: 'in_garage',
    start_at: T('2026-10-01T19:00:00Z'),
    end_at: T('2026-10-01T23:00:00Z'), // 共享到 23:00
    gate_entry_at: T('2026-10-01T19:05:00Z'),
    parking_confirmed_at: T('2026-10-01T19:10:00Z'),
  };
  const alt = { id: 9, code: 'B2-109', hourly_rate: 4, overnight_cap: 35, near_charger: false, location_desc: 'B 区标准位' };

  test('无在途预约：直接收回，无需抢占', () => {
    const a = assessPreemption({ now: T('2026-10-01T22:00:00Z'), reservation: null, alternatives: [], ownerHistoryCount: 0 });
    expect(a.hasActiveReservation).toBe(false);
    expect(a.recommendedAction).toBe('direct_reclaim');
    expect(a.replaceable).toBe(false);
  });

  test('22:00 回家时：车辆已入场、剩余 60 分钟、有替代车位 -> 建议换位', () => {
    const a = assessPreemption({ now: T('2026-10-01T22:00:00Z'), reservation, alternatives: [alt], ownerHistoryCount: 0 });
    expect(a.vehicleEntered).toBe(true);
    expect(a.remainingMinutes).toBe(60);
    expect(a.replaceable).toBe(true);
    expect(a.recommendedAction).toBe('relocate');
    expect(a.reasons.join('')).toContain('可替代车位');
  });

  test('车辆未入场（reserved）也按未入场评估', () => {
    const a = assessPreemption({
      now: T('2026-10-01T22:00:00Z'),
      reservation: { ...reservation, status: 'reserved', gate_entry_at: null, parking_confirmed_at: null },
      alternatives: [alt],
      ownerHistoryCount: 0,
    });
    expect(a.vehicleEntered).toBe(false);
    expect(a.recommendedAction).toBe('relocate');
  });

  test('无替代车位且剩余不足 30 分钟 -> 建议等待', () => {
    const a = assessPreemption({ now: T('2026-10-01T22:45:00Z'), reservation, alternatives: [], ownerHistoryCount: 0 });
    expect(a.remainingMinutes).toBe(15);
    expect(a.replaceable).toBe(false);
    expect(a.recommendedAction).toBe('wait');
  });

  test('无替代车位且剩余较长、历史提前结束少 -> 建议违约补偿收回', () => {
    const a = assessPreemption({ now: T('2026-10-01T22:00:00Z'), reservation, alternatives: [], ownerHistoryCount: 1 });
    expect(a.recommendedAction).toBe('breach_compensation');
    expect(a.reviewCaution).toBe(false);
  });

  test('历史提前结束次数达到阈值：建议物业协调，且后续审核更谨慎', () => {
    const a = assessPreemption({ now: T('2026-10-01T22:00:00Z'), reservation, alternatives: [], ownerHistoryCount: PREEMPTION.historyCoordinationThreshold });
    expect(a.recommendedAction).toBe('property_coordination');
    expect(a.reviewCaution).toBe(true);
    expect(a.reasons.join('')).toContain('更谨慎');
  });

  test('历史 2 次即触发审核谨慎提示', () => {
    const a = assessPreemption({ now: T('2026-10-01T22:00:00Z'), reservation, alternatives: [alt], ownerHistoryCount: 2 });
    expect(a.reviewCaution).toBe(true);
  });
});

describe('settlePrice：换位场景分账', () => {
  const base = {
    reservedStart: T('2026-10-01T19:00:00Z'),
    reservedEnd: T('2026-10-01T23:00:00Z'),
    actualEntry: T('2026-10-01T19:00:00Z'),
    actualExit: T('2026-10-01T23:00:00Z'),
    usableFrom: T('2026-10-01T19:00:00Z'),
    hourlyRate: 6, // 替代车位更贵：6 元/时
    overnightCap: 60,
    isNewEnergy: false,
    chargeKwh: 0,
    incidents: [],
    ruling: null,
    couponAmount: 0,
    prepaid: 20, // 预约时按原车位 5 元/时 × 4h 预付
  };

  test('换位后计费锚定原车位价格，车主不承担价差', () => {
    const r = settlePrice({
      ...base,
      relocation: { cashCompensation: 10, originalHourlyRate: 5, originalOvernightCap: 45 },
    });
    // 4 小时 × 原价 5 元 = 20，而非替代车位 6 元 × 4 = 24
    expect(r.baseFee).toBe(20);
    expect(r.notes.join('')).toContain('换位');
  });

  test('换位现金补偿计入异常补偿并由业主分成承担，借贷平衡', () => {
    const r = settlePrice({
      ...base,
      relocation: { cashCompensation: 10, originalHourlyRate: 5, originalOvernightCap: 45 },
    });
    expect(r.abnormalCompensation).toBe(10);
    // 服务费 20：业主分成 14 - 换位补偿 10 = 4
    expect(r.ownerIncome).toBe(4);
    // 车主：账单 20 - 补偿 10 = 应付 10；预付 20 -> 退款 10
    expect(r.refund).toBe(10);
    expect(r.exitCharge).toBe(0);
    const debit = r.ledger.filter((l) => l.direction === 'debit').reduce((a, b) => a + b.amount, 0);
    const credit = r.ledger.filter((l) => l.direction === 'credit').reduce((a, b) => a + b.amount, 0);
    expect(Math.abs(debit - credit)).toBeLessThanOrEqual(0.02);
  });

  test('换位补偿超过业主分成时平台垫付（业主收益为 0，借贷仍平衡）', () => {
    const r = settlePrice({
      ...base,
      reservedEnd: T('2026-10-01T20:00:00Z'),
      actualExit: T('2026-10-01T20:00:00Z'),
      prepaid: 5,
      relocation: { cashCompensation: 10, originalHourlyRate: 5, originalOvernightCap: null },
    });
    // 1 小时 × 5 = 5 元服务费，业主分成 3.5 < 补偿 10 -> 业主收益 0，平台垫付缺口
    expect(r.ownerIncome).toBe(0);
    expect(r.abnormalCompensation).toBe(10);
    const debit = r.ledger.filter((l) => l.direction === 'debit').reduce((a, b) => a + b.amount, 0);
    const credit = r.ledger.filter((l) => l.direction === 'credit').reduce((a, b) => a + b.amount, 0);
    expect(Math.abs(debit - credit)).toBeLessThanOrEqual(0.02);
    expect(r.ledger.some((l) => l.memo.includes('垫付') || l.memo.includes('兜底'))).toBe(true);
  });

  test('换位场景不按业主回家截断计费（服务未中断）', () => {
    const r = settlePrice({
      ...base,
      incidents: [{ type: 'owner_preempt', started_at: T('2026-10-01T22:00:00Z') }],
      relocation: { cashCompensation: 10, originalHourlyRate: 5, originalOvernightCap: 45 },
    });
    expect(r.durationMinutes).toBe(240); // 完整 4 小时
    expect(r.creditDelta).toBe(0); // 妥善换位不扣业主信用
  });
});
