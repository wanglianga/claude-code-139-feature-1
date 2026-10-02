// 业主提前回家抢占处理：评估引擎（纯函数，便于单元测试）
// 平台在业主上报"提前回家"时，先查看：
//   1) 当前预约车辆是否已入场
//   2) 剩余停车时长
//   3) 附近可替代车位
//   4) 业主历史提前结束次数
// 再给出处置建议：可替换 -> 换位导航+费用补偿；不可替换 -> 等待 / 违约补偿收回 / 申请物业协调。

export const PREEMPTION = {
  waitAdvisedRemainingMinutes: 30, // 剩余时长不超过该值时建议业主等待
  historyCautionThreshold: 2, // 历史提前结束次数达到该值，后续开放时段审核更谨慎
  historyCoordinationThreshold: 3, // 历史提前结束次数达到该值，优先建议物业协调而非直接违约收回
  relocationCashCompensation: 10, // 换位现金补偿（业主承担，结算时从其分成扣减）
  relocationCouponCompensation: 5, // 换位平台补偿券（非现金，下次抵扣）
};

export interface PreemptionReservation {
  id: number;
  status: string; // reserved / admitted / in_garage
  start_at: Date;
  end_at: Date;
  gate_entry_at?: Date | null;
  parking_confirmed_at?: Date | null;
}

export interface AlternativeSpot {
  id: number;
  code: string;
  hourly_rate: number;
  overnight_cap?: number | null;
  near_charger: boolean;
  location_desc?: string | null;
}

export type PreemptionAction = 'relocate' | 'wait' | 'breach_compensation' | 'property_coordination';

export interface PreemptionAssessment {
  hasActiveReservation: boolean; // 是否有进行中的预约
  vehicleEntered: boolean; // 预约车辆是否已入场（道闸放行/停放确认）
  remainingMinutes: number; // 上报时点剩余停车时长
  alternatives: AlternativeSpot[]; // 附近可替代车位
  ownerHistoryCount: number; // 业主历史提前结束次数（不含本次）
  replaceable: boolean; // 是否可替换（有替代车位）
  recommendedAction: PreemptionAction | 'direct_reclaim' | null;
  reviewCaution: boolean; // 后续开放时段审核是否应更谨慎
  reasons: string[]; // 评估理由（面向三方可解释）
}

export function assessPreemption(input: {
  now: Date;
  reservation: PreemptionReservation | null;
  alternatives: AlternativeSpot[];
  ownerHistoryCount: number;
}): PreemptionAssessment {
  const { now, reservation, alternatives, ownerHistoryCount } = input;
  const reasons: string[] = [];

  const vehicleEntered = !!reservation && ['admitted', 'in_garage'].includes(reservation.status);
  const remainingMinutes = reservation
    ? Math.max(0, Math.round((new Date(reservation.end_at).getTime() - now.getTime()) / 60000))
    : 0;
  const replaceable = !!reservation && alternatives.length > 0;
  const reviewCaution = ownerHistoryCount >= PREEMPTION.historyCautionThreshold;

  // ---- 评估理由 ----
  if (!reservation) {
    reasons.push('当前车位没有在途预约，业主可直接收回车位自用，无需抢占处理');
  } else {
    reasons.push(
      vehicleEntered
        ? '当前预约车辆已入场停放，提前收回将中断本次停车服务'
        : '当前预约车辆尚未入场，可低成本调整至替代车位',
    );
    reasons.push(`距离预约结束还剩 ${remainingMinutes} 分钟`);
    if (alternatives.length > 0) {
      reasons.push(
        `附近找到 ${alternatives.length} 个可替代车位（${alternatives
          .map((a) => a.code)
          .join('、')}），可安排车主换位并发放费用补偿`,
      );
    } else {
      reasons.push('附近没有可覆盖剩余时段的替代车位，无法安排换位');
    }
  }
  if (ownerHistoryCount > 0) {
    reasons.push(`业主历史提前结束 ${ownerHistoryCount} 次，该记录已写入发布档案`);
  }
  if (reviewCaution) {
    reasons.push('提前结束次数偏多：后续发布的开放时段将进入更谨慎的审核流程');
  }

  // ---- 推荐动作 ----
  let recommendedAction: PreemptionAssessment['recommendedAction'] = null;
  if (!reservation) {
    recommendedAction = 'direct_reclaim';
  } else if (replaceable) {
    recommendedAction = 'relocate';
    reasons.push('建议：为车主安排换位导航并发放费用补偿，业主即可收回车位');
  } else if (remainingMinutes <= PREEMPTION.waitAdvisedRemainingMinutes) {
    recommendedAction = 'wait';
    reasons.push(`建议：剩余时长不足 ${PREEMPTION.waitAdvisedRemainingMinutes + 1} 分钟，等待车主离场成本最低`);
  } else if (ownerHistoryCount >= PREEMPTION.historyCoordinationThreshold) {
    recommendedAction = 'property_coordination';
    reasons.push('建议：提前结束次数较多，优先申请物业现场协调，避免再次直接违约');
  } else {
    recommendedAction = 'breach_compensation';
    reasons.push('建议：支付违约补偿立即收回车位，或申请物业协调/等待车主离场');
  }

  return {
    hasActiveReservation: !!reservation,
    vehicleEntered,
    remainingMinutes,
    alternatives,
    ownerHistoryCount,
    replaceable,
    recommendedAction,
    reviewCaution,
    reasons,
  };
}
