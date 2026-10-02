import {
  RELOCATION,
  assessReservation,
  buildRelocationNavigation,
  estimateDistance,
  evaluateReturnRisk,
  findRelocationCandidates,
  relocationTopupFee,
  CandidateSpot,
} from '../src/domain/ownerReturn';
import { ShareWindow } from '../src/domain/availability';

const ALL_DAY: ShareWindow[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  start_time: '00:00',
  end_time: '23:59',
}));

function spot(p: Partial<CandidateSpot> & { id: number; code: string }): CandidateSpot {
  return {
    communityId: 1,
    originSpotId: 1,
    locationDesc: '地下二层 B 区',
    nearCharger: false,
    chargerPowerKw: null,
    allowVisitor: true,
    monthlyPriority: false,
    hourlyRate: 5,
    overnightCap: 45,
    reviewStatus: 'approved',
    active: true,
    windows: ALL_DAY,
    busyRanges: [],
    ...p,
  };
}

describe('assessReservation', () => {
  const base = {
    id: 1,
    code: 'R1',
    spotId: 1,
    plate: '沪A1',
    status: 'in_garage',
    startAt: new Date('2026-10-02T20:00:00Z'),
    endAt: new Date('2026-10-02T23:00:00Z'),
    gateEntryAt: new Date('2026-10-02T20:00:00Z'),
    parkingConfirmedAt: new Date('2026-10-02T20:10:00Z'),
    isNewEnergy: true,
    isVisitor: false,
    isMonthly: false,
  };
  test('车主已停放：判定在场并给出已用/剩余时长', () => {
    const a = assessReservation(base, new Date('2026-10-02T22:00:00Z'));
    expect(a.carOnSite).toBe(true);
    expect(a.parked).toBe(true);
    expect(a.elapsedMinutes).toBe(110); // 从停放确认 20:10 起
    expect(a.remainingMinutes).toBe(60); // 22:00 -> 23:00
    expect(a.reservedWindowMinutes).toBe(180);
  });
  test('车辆尚未入场：carOnSite=false，剩余时长为整个预约窗口', () => {
    const a = assessReservation(
      { ...base, status: 'reserved', gateEntryAt: null, parkingConfirmedAt: null },
      new Date('2026-10-02T22:00:00Z'),
    );
    expect(a.carOnSite).toBe(false);
    expect(a.admitted).toBe(false);
    expect(a.remainingMinutes).toBe(60);
  });
});

describe('evaluateReturnRisk', () => {
  test('无历史为低风险；2 次中风险；4 次高风险', () => {
    expect(evaluateReturnRisk(0, 60)).toBe('low');
    expect(evaluateReturnRisk(2, 60)).toBe('medium');
    expect(evaluateReturnRisk(4, 0)).toBe('high');
  });
  test('仅 1 次但提前 3 小时以上收回升为中风险', () => {
    expect(evaluateReturnRisk(1, 179)).toBe('low');
    expect(evaluateReturnRisk(1, 180)).toBe('medium');
  });
});

describe('estimateDistance', () => {
  test('同层相邻车位距离近，跨层距离远', () => {
    expect(estimateDistance('B2-108', null, 'B2-109', null)).toBeLessThan(
      estimateDistance('B2-108', null, 'B1-021', null),
    );
  });
});

describe('findRelocationCandidates', () => {
  const need = {
    isNewEnergy: true,
    needCharger: true,
    isVisitor: false,
    isMonthly: false,
    originHourlyRate: 5,
    originCode: 'B2-108',
    originLocationDesc: '地下二层 B 区，靠 3 号充电桩',
  };
  const window = { start: new Date('2026-10-02T22:00:00Z'), end: new Date('2026-10-02T23:00:00Z') };

  test('充电需求只能匹配带充电桩的同小区空闲车位，并按评分排序', () => {
    const candidates = [
      spot({ id: 2, code: 'B2-110', nearCharger: false }),
      spot({ id: 3, code: 'B2-112', nearCharger: true, chargerPowerKw: 7, hourlyRate: 5 }),
      spot({ id: 4, code: 'B1-030', nearCharger: true, chargerPowerKw: 7, hourlyRate: 8 }),
    ];
    const { feasible, rejected } = findRelocationCandidates(candidates, need, window);
    expect(feasible.map((m) => m.candidate.id)).toEqual([3, 4]);
    expect(rejected.some((r) => r.code === 'B2-110' && r.reason.includes('充电'))).toBe(true);
    // 同层且不涨价的 B2-112 评分高于跨层涨价的 B1-030
    expect(feasible[0].matchScore).toBeGreaterThan(feasible[1].matchScore);
  });

  test('未审核/已停共享/时段冲突/窗口不覆盖的车位均不可替换', () => {
    const candidates = [
      spot({ id: 2, code: 'B2-110', reviewStatus: 'pending' }),
      spot({ id: 3, code: 'B2-111', active: false }),
      spot({
        id: 4,
        code: 'B2-112',
        busyRanges: [{ start: new Date('2026-10-02T21:00:00Z'), end: new Date('2026-10-02T23:30:00Z') }],
      }),
      spot({
        id: 5,
        code: 'B2-113',
        windows: [{ weekday: 0, start_time: '08:00', end_time: '18:00' }],
      }),
    ];
    const { feasible, rejected } = findRelocationCandidates(
      candidates,
      { ...need, needCharger: false },
      window,
    );
    expect(feasible).toHaveLength(0);
    expect(rejected).toHaveLength(4);
  });

  test('访客车不能换到禁访客车位', () => {
    const candidates = [
      spot({ id: 2, code: 'B2-120', allowVisitor: false }),
      spot({ id: 3, code: 'B2-121', allowVisitor: true }),
    ];
    const { feasible } = findRelocationCandidates(
      candidates,
      { ...need, needCharger: false, isVisitor: true },
      window,
    );
    expect(feasible.map((m) => m.candidate.code)).toEqual(['B2-121']);
  });

  test('燃油车不能换到充电车位（即使车主本身无充电需求）', () => {
    const candidates = [
      spot({ id: 2, code: 'B2-130', nearCharger: true, chargerPowerKw: 7 }),
      spot({ id: 3, code: 'B2-131', nearCharger: false }),
    ];
    const { feasible, rejected } = findRelocationCandidates(
      candidates,
      { ...need, isNewEnergy: false, needCharger: false },
      window,
    );
    expect(feasible.map((m) => m.candidate.code)).toEqual(['B2-131']);
    expect(rejected[0].reason).toContain('充电');
  });

  test('最多返回 3 个候选', () => {
    const candidates = Array.from({ length: 6 }, (_, i) => spot({ id: 10 + i, code: `B2-2${i}0` }));
    const { feasible } = findRelocationCandidates(candidates, { ...need, needCharger: false }, window);
    expect(feasible.length).toBe(RELOCATION.maxCandidates);
  });
});

describe('buildRelocationNavigation', () => {
  test('生成含原/新车位、距离、时限与离线码的换位导航', () => {
    const nav = buildRelocationNavigation({
      originCode: 'B2-108',
      targetCode: 'B2-112',
      targetLocationDesc: '地下二层 B 区 12 号充电桩旁',
      targetNearCharger: true,
      distanceM: 57,
      plate: '沪AD88899',
      communityName: '阳光花园',
    });
    expect(nav.type).toBe('relocation');
    expect(nav.target_spot).toBe('B2-112');
    expect(nav.voice).toContain('B2-112');
    expect(nav.steps.length).toBeGreaterThanOrEqual(4);
    expect(nav.offline_code).toContain('B2-108');
    expect(nav.steps.join('')).toContain(`${RELOCATION.acceptWindowMinutes} 分钟`);
  });
});

describe('relocationTopupFee', () => {
  test('按新车位剩余窗口估价并应用夜间封顶', () => {
    const win = { start: new Date('2026-10-02T22:00:00Z'), end: new Date('2026-10-03T08:00:00Z') }; // 10 小时 × 5 = 50
    expect(relocationTopupFee(win, spot({ id: 9, code: 'X', overnightCap: 45 }))).toBe(45);
    expect(
      relocationTopupFee(
        { start: new Date('2026-10-02T22:00:00Z'), end: new Date('2026-10-02T23:00:00Z') },
        spot({ id: 9, code: 'X', overnightCap: 45 }),
      ),
    ).toBe(5);
  });
});
