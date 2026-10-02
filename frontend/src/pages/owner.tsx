import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLoader } from '../hooks';
import { WorkspaceShell } from '../App';
import { dt, money, Tag, RISK_TAG } from '../ui';
import { AppealDetailModal, ReservationDetailModal } from './shared';
import { TimelineView } from '../components';

type Session = any;
const NAV = [
  { key: 'spots', label: '我的车位', icon: '🅿️' },
  { key: 'orders', label: '预约与收益', icon: '🧾' },
  { key: 'dispatch', label: '夜间调度', icon: '🌙' },
  { key: 'records', label: '提前结束与时段审核', icon: '📋' },
  { key: 'appeals', label: '车位申诉', icon: '⚖️' },
];

export function OwnerWorkspace({ session }: { session: Session }) {
  const [tab, setTab] = useState('spots');
  return (
    <WorkspaceShell session={session} nav={NAV} active={tab} onNav={setTab}>
      {tab === 'spots' && <SpotsTab session={session} />}
      {tab === 'orders' && <OrdersTab />}
      {tab === 'dispatch' && <DispatchTab session={session} />}
      {tab === 'records' && <ReturnRecordsTab />}
      {tab === 'appeals' && <AppealsTab />}
    </WorkspaceShell>
  );
}

function PageHead({ title, desc, right }: any) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1><div className="desc">{desc}</div></div>
      {right}
    </div>
  );
}

// ---------- 车位发布与管理 ----------
function SpotsTab({ session }: { session: Session }) {
  const { data: spots, reload } = useLoader<any[]>('/spots/mine');
  const { data: communities } = useLoader<any[]>('/spots/communities');
  const [publishing, setPublishing] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [timelineSpot, setTimelineSpot] = useState<any>(null);

  const [form, setForm] = useState<any>({
    community_id: 1,
    code: '',
    location_desc: '',
    near_charger: true,
    charger_power_kw: 7,
    allow_visitor: true,
    monthly_priority: false,
    hourly_rate: 5,
    overnight_cap: 45,
    windows: [
      { weekday: 1, start_time: '19:00', end_time: '08:00' },
      { weekday: 2, start_time: '19:00', end_time: '08:00' },
      { weekday: 3, start_time: '19:00', end_time: '08:00' },
      { weekday: 4, start_time: '19:00', end_time: '08:00' },
      { weekday: 5, start_time: '20:00', end_time: '09:00' },
      { weekday: 6, start_time: '00:00', end_time: '23:59' },
      { weekday: 0, start_time: '00:00', end_time: '23:59' },
    ],
  });
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  const setWin = (weekday: number, patch: any) =>
    setForm((f: any) => ({
      ...f,
      windows: f.windows.map((w: any) => (w.weekday === weekday ? { ...w, ...patch } : w)),
    }));
  const winEnabled = (weekday: number) => form.windows.some((w: any) => w.weekday === weekday);
  const toggleWin = (weekday: number) =>
    setForm((f: any) =>
      winEnabled(weekday)
        ? { ...f, windows: f.windows.filter((w: any) => w.weekday !== weekday) }
        : { ...f, windows: [...f.windows, { weekday, start_time: '19:00', end_time: '08:00' }] },
    );

  const submit = async () => {
    setErr(''); setMsg(''); setPublishing(true);
    try {
      await api('POST', '/spots', form);
      setMsg('车位已提交，等待物业审核产权材料');
      set('code', '');
      reload();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setPublishing(false);
    }
  };

  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  return (
    <div>
      <PageHead title="我的车位" desc="登记产权车位的共享时段、充电桩、访客与月租车优先规则，提交物业审核后上架" />
      {msg && <div className="alert ok">{msg}</div>}
      {err && <div className="alert error">{err}</div>}
      <div className="grid grid-2">
        <div className="card">
          <h3>发布闲置车位</h3>
          <div className="form-row">
            <div className="field">
              <label>所属小区</label>
              <select value={form.community_id} onChange={(e) => set('community_id', Number(e.target.value))}>
                {(communities ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>车位编号</label>
              <input placeholder="如 B2-108" value={form.code} onChange={(e) => set('code', e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>位置描述（导航引导用）</label>
            <input placeholder="如 地下二层 B 区，靠 3 号充电桩" value={form.location_desc} onChange={(e) => set('location_desc', e.target.value)} />
          </div>
          <div className="form-row">
            <div className="field">
              <label>每小时单价（元）</label>
              <input type="number" step="0.5" value={form.hourly_rate} onChange={(e) => set('hourly_rate', Number(e.target.value))} />
            </div>
            <div className="field">
              <label>夜间封顶价（元）</label>
              <input type="number" step="1" value={form.overnight_cap ?? ''} onChange={(e) => set('overnight_cap', e.target.value ? Number(e.target.value) : null)} />
            </div>
          </div>
          <div className="form-row">
            <div className="field checkbox">
              <input id="c1" type="checkbox" checked={form.near_charger} onChange={(e) => set('near_charger', e.target.checked)} />
              <label htmlFor="c1" style={{ margin: 0 }}>靠近充电桩（仅新能源车可约）</label>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>充电桩功率（kW）</label>
              <input type="number" step="0.5" disabled={!form.near_charger} value={form.charger_power_kw ?? ''} onChange={(e) => set('charger_power_kw', e.target.value ? Number(e.target.value) : null)} />
            </div>
          </div>
          <div className="form-row">
            <div className="field checkbox">
              <input id="c2" type="checkbox" checked={form.allow_visitor} onChange={(e) => set('allow_visitor', e.target.checked)} />
              <label htmlFor="c2" style={{ margin: 0 }}>允许访客车辆预约</label>
            </div>
            <div className="field checkbox">
              <input id="c3" type="checkbox" checked={form.monthly_priority} onChange={(e) => set('monthly_priority', e.target.checked)} />
              <label htmlFor="c3" style={{ margin: 0 }}>月租车优先排期</label>
            </div>
          </div>

          <div className="field" style={{ marginTop: 6 }}>
            <label>可共享时段（跨天如 19:00→次日 08:00）</label>
            <div className="grid" style={{ gap: 6 }}>
              {WEEK.map((w, i) => {
                const win = form.windows.find((x: any) => x.weekday === i);
                return (
                  <div key={i} className="btn-row" style={{ alignItems: 'center' }}>
                    <label className="checkbox" style={{ width: 70 }}>
                      <input type="checkbox" checked={winEnabled(i)} onChange={() => toggleWin(i)} />
                      周{w}
                    </label>
                    <input type="time" style={{ width: 110 }} disabled={!win} value={win?.start_time ?? ''} onChange={(e) => setWin(i, { start_time: e.target.value })} />
                    <span className="muted">至</span>
                    <input type="time" style={{ width: 110 }} disabled={!win} value={win?.end_time ?? ''} onChange={(e) => setWin(i, { end_time: e.target.value })} />
                  </div>
                );
              })}
            </div>
          </div>
          <button className="btn" disabled={publishing || !form.code} onClick={submit}>{publishing ? '提交中…' : '提交物业审核'}</button>
        </div>

        <div>
          <div className="card">
            <h3>已登记车位 <span className="hint">{spots?.length ?? 0} 个</span></h3>
            {(spots ?? []).map((s) => (
              <div className="spot-card" key={s.id} style={{ marginBottom: 10 }}>
                <div className="btn-row" style={{ justifyContent: 'space-between' }}>
                  <span className="code">{s.code}</span>
                  <Tag status={s.review_status} />
                </div>
                <div className="loc">{s.location_desc}</div>
                <div className="spot-tags">
                  {s.near_charger && <Tag cls="green" label={`⚡ 充电桩 ${s.charger_power_kw ?? ''}kW`} />}
                  {s.allow_visitor ? <Tag cls="blue" label="允许访客" /> : <Tag cls="gray" label="禁访客" />}
                  {s.monthly_priority && <Tag cls="purple" label="月租优先" />}
                  <Tag cls="gray" label={`${s.hourly_rate} 元/时`} />
                  {s.overnight_cap && <Tag cls="amber" label={`封顶 ${s.overnight_cap}`} />}
                </div>
                <div className="small muted" style={{ marginBottom: 8 }}>
                  共享：{(s.windows ?? []).map((w: any) => `周${'日一二三四五六'[w.weekday]} ${String(w.start_time).slice(0, 5)}-${String(w.end_time).slice(0, 5)}`).join('，')}
                </div>
                {s.review_remark && <div className="small" style={{ marginBottom: 8 }}>审核备注：{s.review_remark}</div>}
                <button className="btn sm ghost" onClick={() => setTimelineSpot(s)}>查看一晚时间轴与占用解释</button>
              </div>
            ))}
          </div>
        </div>
      </div>
      {timelineSpot && <SpotTimelineModal spot={timelineSpot} onClose={() => setTimelineSpot(null)} />}
    </div>
  );
}

function SpotTimelineModal({ spot, onClose }: { spot: any; onClose: () => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const load = async (d: string) => {
    setLoading(true);
    const r = await api('GET', `/spots/${spot.id}/timeline?date=${d}`);
    setData(r);
    setLoading(false);
  };
  useEffect(() => {
    load(date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <div className="modal-head">
          <h3>车位 {spot.code} 整晚占用时间轴</h3>
          <button className="close-x" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="filter-bar">
            <label className="small muted">审计日期（18:00 ~ 次日 09:00）</label>
            <input type="date" value={date} onChange={(e) => { setDate(e.target.value); load(e.target.value); }} />
            {loading && <span className="small muted">加载中…</span>}
          </div>
          {data && <TimelineView data={data} />}
        </div>
      </div>
    </div>
  );
}

// ---------- 预约与收益 ----------
function OrdersTab() {
  const { data: orders } = useLoader<any[]>('/reservations');
  const { data: ledger } = useLoader<any[]>('/ledger');
  const [detail, setDetail] = useState<number | null>(null);
  const income = (ledger ?? []).filter((l) => l.account.startsWith('owner:') && l.direction === 'credit').reduce((a, b) => a + Number(b.amount), 0);
  return (
    <div>
      <PageHead title="预约与收益" desc="查看自家车位的全部预约服务单、分账明细与资金流水" />
      <div className="grid grid-3" style={{ marginBottom: 18 }}>
        <div className="stat"><div className="label">累计预约单</div><div className="value">{orders?.length ?? 0}</div></div>
        <div className="stat"><div className="label">业主账户累计入账</div><div className="value text-green">{money(income)}</div><div className="sub">服务分成 70% + 错停/占用补偿</div></div>
        <div className="stat"><div className="label">流水笔数</div><div className="value">{ledger?.length ?? 0}</div></div>
      </div>
      <div className="card">
        <h3>预约服务单</h3>
        <OrderTable orders={orders ?? []} onOpen={(id) => setDetail(id)} />
      </div>
      <div className="card">
        <h3>业主收益流水</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>时间</th><th>结算单</th><th>方向</th><th>金额</th><th>摘要</th></tr></thead>
            <tbody>
              {(ledger ?? []).map((l) => (
                <tr key={l.id}>
                  <td className="small">{dt(l.created_at)}</td>
                  <td className="small mono">{l.settlement_code}</td>
                  <td><Tag cls={l.direction === 'credit' ? 'green' : 'amber'} label={l.direction === 'credit' ? '入账' : '出账'} /></td>
                  <td className="money">{money(l.amount)}</td>
                  <td className="small">{l.memo}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {detail && <ReservationDetailModal id={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

export function OrderTable({ orders, onOpen }: { orders: any[]; onOpen: (id: number) => void }) {
  if (!orders.length) return <div className="empty">暂无预约单</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>单号</th><th>车位</th><th>车主/车牌</th><th>预约时段</th><th>状态</th><th>预付</th><th>实付</th><th></th></tr>
        </thead>
        <tbody>
          {orders.map((r) => (
            <tr key={r.id} className="row-clickable" onClick={() => onOpen(r.id)}>
              <td className="mono small">{r.code}</td>
              <td>{r.spot_code}</td>
              <td>{r.driver_name}<div className="small muted mono">{r.plate}</div></td>
              <td className="small">{dt(r.start_at)}<br />~ {dt(r.end_at)}</td>
              <td><Tag status={r.status} />{r.priority === 'monthly' && <div style={{ marginTop: 4 }}><Tag cls="purple" label="月租" /></div>}</td>
              <td className="money small">{money(r.estimated_fee)}</td>
              <td className="money">{r.status === 'completed' ? money(r.estimated_fee) : '—'}</td>
              <td><button className="btn sm gray" onClick={(e) => { e.stopPropagation(); onOpen(r.id); }}>追溯</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- 夜间调度（业主视角：提前回家抢占处理）----------
function DispatchTab({ session }: { session: Session }) {
  const { data: spots } = useLoader<any[]>('/spots/mine');
  const { data: tickets, reload } = useLoader<any[]>('/dispatch/incidents');
  const [assessment, setAssessment] = useState<any | null>(null);
  const [err, setErr] = useState('');
  const [busySpot, setBusySpot] = useState<number | null>(null);

  const reportReturn = async (spotId: number) => {
    setErr('');
    const eta = prompt('预计多少分钟后到家？', '30');
    if (eta === null) return;
    setBusySpot(spotId);
    try {
      const r = await api('POST', '/dispatch/owner-return', {
        spot_id: spotId,
        eta_minutes: Number(eta),
        note: '业主临时回家，提前收回共享车位',
      });
      setAssessment(r);
      reload();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusySpot(null);
    }
  };

  return (
    <div>
      <PageHead title="夜间调度 · 提前回家抢占处理" desc="临时回家时平台先核查预约车辆是否已入场、剩余停车时长与附近可替代车位，并参考你的历史提前结束次数给出风控结论" />
      {err && <div className="alert error">{err}</div>}
      <div className="card">
        <h3>我要提前回家（收回共享车位）</h3>
        <div className="btn-row">
          {(spots ?? []).filter((s) => s.review_status === 'approved').map((s) => (
            <button key={s.id} className="btn ghost" disabled={busySpot === s.id} onClick={() => reportReturn(s.id)}>
              🏠 {busySpot === s.id ? '评估中…' : `${s.code} 业主回家`}
            </button>
          ))}
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>
          处理流程：平台评估在场状态与剩余时长 → 匹配附近替代车位（车主收到换位导航 + ¥15 费用补偿）→
          无法替换时你可选择等待 / 支付 ¥20 违约补偿 / 申请物业协调；每次提前结束都会记入发布记录，影响后续开放时段审核。
        </div>
      </div>

      {assessment && <ReturnAssessmentModal data={assessment} onClose={() => { setAssessment(null); reload(); }} />}

      <div className="card">
        <h3>我车位上的异常工单</h3>
        {(tickets ?? []).length === 0 && <div className="empty">暂无异常</div>}
        {(tickets ?? []).map((t) => (
          <div key={t.id} className={`ticket-card ${t.status}`}>
            <div className="ticket-head">
              <span className="ticket-title">{t.label}</span>
              <span className="btn-row"><span className="mono small muted">{t.spot_code}</span><Tag status={t.status} /></span>
            </div>
            <div className="ticket-desc">{t.description}</div>
            {t.resolution && <div className="small">处置：{t.resolution}</div>}
            <div className="small muted">{dt(t.created_at)}{t.reservation_code ? ` · 关联订单 ${t.reservation_code}` : ''}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// 业主回家后的平台评估结果：可替换（等待车主响应）/ 无法替换（三选一）
function ReturnAssessmentModal({ data, onClose }: { data: any; onClose: () => void }) {
  const [done, setDone] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const record = data.record;

  const decide = async (action: 'owner_wait' | 'breach_pay' | 'property_coordination') => {
    setErr('');
    const note = action === 'property_coordination' ? prompt('给物业的协调说明（可留空）', '请帮忙协调附近临时车位') : undefined;
    if (note === null) return;
    setBusy(action);
    try {
      const r = await api('POST', `/dispatch/owner-records/${record.id}/decision`, { action, note: note || undefined });
      setDone(r);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const a = data.assessment;
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <div className="modal-head">
          <h3>提前回家抢占评估 · 工单 {data.ticket.code}</h3>
          <button className="close-x" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {err && <div className="alert error">{err}</div>}

          {!a && (
            <div className="alert info">当前该车位暂无进行中的预约车辆，你可以直接回家自用；本次提前结束已记入发布记录。</div>
          )}

          {a && (
            <>
              <div className="grid grid-4" style={{ marginBottom: 12 }}>
                <div className="stat"><div className="label">预约车辆</div><div className="value" style={{ fontSize: 18 }}>{a.car_on_site ? '已入场' : '尚未入场'}</div><div className="sub">{a.parked ? '已停放确认' : a.admitted ? '已过道闸' : '未过道闸'}</div></div>
                <div className="stat"><div className="label">已使用时长</div><div className="value" style={{ fontSize: 18 }}>{a.elapsed_minutes} 分</div></div>
                <div className="stat"><div className="label">剩余停车时长</div><div className="value" style={{ fontSize: 18 }}>{a.remaining_minutes} 分</div><div className="sub">预约共 {a.reserved_window_minutes} 分</div></div>
                <div className="stat"><div className="label">提前收回</div><div className="value" style={{ fontSize: 18 }}>{record.early_minutes} 分</div></div>
              </div>

              <div className="card" style={{ marginTop: 0 }}>
                <h3>业主发布记录与风控</h3>
                <div className="btn-row">
                  <Tag cls={data.risk.level === 'low' ? 'green' : data.risk.level === 'medium' ? 'amber' : 'red'}
                    label={`风险：${data.risk.label}`} />
                  <span className="small muted">
                    近 {data.risk.history_window_days} 天第 {data.risk.early_termination_count} 次提前结束（记录 {record.code}）
                  </span>
                </div>
                <div className="small muted" style={{ marginTop: 6 }}>
                  本次提前结束已写入你的发布记录；后续追加/延长开放共享时段时，{data.risk.level === 'low' ? '仍可系统自动通过' : '物业将人工谨慎审核'}。
                </div>
              </div>

              {data.can_replace ? (
                <div className="card" style={{ marginTop: 12 }}>
                  <h3>✅ 平台已匹配 {data.candidates.length} 个附近可替代车位</h3>
                  <div className="small muted" style={{ marginBottom: 8 }}>
                    换位通知与导航已推送给在场车主；车主接受后原单按实际时长结算，你支付 <b className="money">{money(15)}</b> 换位费用补偿，补差券由平台随新预约发放。
                  </div>
                  {data.candidates.map((c: any) => (
                    <div key={c.offer_id} className="ticket-card notified" style={{ marginBottom: 8 }}>
                      <div className="ticket-head">
                        <span className="ticket-title">替代车位 {c.spot_code} · 距原位 {c.distance_m}m</span>
                        <Tag cls="blue" label={`匹配度 ${c.match_score}`} />
                      </div>
                      <div className="ticket-desc">{c.community_name ?? ''} {c.location_desc ?? ''} · {c.hourly_rate} 元/时{c.near_charger ? ' · ⚡充电桩' : ''}</div>
                      <div className="small">{c.score_reasons.join('；')}</div>
                    </div>
                  ))}
                  <div className="alert info" style={{ marginTop: 8 }}>
                    请等待车主在 15 分钟内响应。若车主拒绝全部方案，你仍可选择等待、支付违约补偿或申请物业协调。
                  </div>
                  <div className="btn-row" style={{ marginTop: 10 }}>
                    <button className="btn gray" disabled={busy === 'owner_wait'} onClick={() => decide('owner_wait')}>
                      {busy === 'owner_wait' ? '提交中…' : '我再等等，让车主停到预约结束'}
                    </button>
                    <button className="btn ghost" disabled={busy === 'property_coordination'} onClick={() => decide('property_coordination')}>
                      {busy === 'property_coordination' ? '提交中…' : '申请物业协调'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="card" style={{ marginTop: 12 }}>
                  <h3>⚠️ 附近暂无可替代车位</h3>
                  {data.rejected?.length > 0 && (
                    <details className="small muted" style={{ marginBottom: 8 }}>
                      <summary>为什么这些车位不可替换（{data.rejected.length}）</summary>
                      <ul>{data.rejected.map((r: any, i: number) => <li key={i}>{r.code}：{r.reason}</li>)}</ul>
                    </details>
                  )}
                  <div className="grid grid-3" style={{ gap: 10 }}>
                    <button className="btn" disabled={!!busy} onClick={() => decide('owner_wait')}>
                      ⏳ 选择等待<div className="small muted" style={{ marginTop: 4 }}>不提前收回，车主继续停到 23:00，无违约成本</div>
                    </button>
                    <button className="btn ghost" disabled={!!busy} onClick={() => decide('breach_pay')}>
                      💴 支付违约补偿<div className="small muted" style={{ marginTop: 4 }}>立即收回，向车主支付 ¥20 补偿（随退款发放），订单按实际时长结算</div>
                    </button>
                    <button className="btn gray" disabled={!!busy} onClick={() => decide('property_coordination')}>
                      📞 申请物业协调<div className="small muted" style={{ marginTop: 4 }}>值班员线下协调临时车位/访客安置，结果将通知双方</div>
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {done && (
            <div className="alert ok" style={{ marginTop: 12 }}>
              {done.resolution === 'owner_wait' && '已登记：你选择等待，车主可继续使用至预约结束，本次不提前收回。'}
              {done.resolution === 'breach_paid' && <>违约补偿已处理：订单已按实际可用时长结算，¥20 补偿随退款发放车主。清算单号 {done.settlement?.code}</>}
              {done.resolution === 'property_coordinating' && `已提交物业协调（${done.coordination?.code}），值班员处置后会通知你和车主。`}
              <div style={{ marginTop: 8 }}><button className="btn sm" onClick={onClose}>完成</button></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- 提前结束记录与开放时段审核 ----------
function ReturnRecordsTab() {
  const { data, reload } = useLoader<any>('/dispatch/owner-records');
  const { data: reviews, reload: reloadReviews } = useLoader<any[]>('/spots/share-windows/mine');
  const { data: spots } = useLoader<any[]>('/spots/mine');
  const [applySpot, setApplySpot] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busyRec, setBusyRec] = useState<number | null>(null);

  // 对仍在处理中的提前结束记录做决策（车主拒绝全部方案 / 物业协调失败后回到此页继续选择）
  const decideRecord = async (recId: number, action: 'owner_wait' | 'breach_pay' | 'property_coordination') => {
    setErr('');
    const note = action === 'property_coordination' ? prompt('给物业的协调说明（可留空）', '请帮忙协调附近临时车位') : undefined;
    if (note === null) return;
    setBusyRec(recId);
    try {
      const r = await api('POST', `/dispatch/owner-records/${recId}/decision`, { action, note: note || undefined });
      setMsg(
        r.resolution === 'owner_wait' ? '已登记：你选择等待，车主可继续使用至预约结束'
        : r.resolution === 'breach_paid' ? '违约补偿已处理，补偿随退款发放车主'
        : '已提交物业协调，请等待值班员处置',
      );
      reload();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusyRec(null);
    }
  };

  return (
    <div>
      <PageHead title="提前结束记录与开放时段审核" desc="每次提前回家都会写入发布记录；记录越多，后续开放共享时段的审核越谨慎" right={
        <button className="btn" disabled={(spots ?? []).filter((s) => s.review_status === 'approved').length === 0}
          onClick={() => setApplySpot((spots ?? []).find((s) => s.review_status === 'approved') ?? null)}>追加/调整开放时段</button>
      } />
      {msg && <div className="alert ok">{msg}</div>}
      {err && <div className="alert error">{err}</div>}
      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="stat"><div className="label">累计提前结束</div><div className="value">{data?.summary?.total ?? 0} 次</div></div>
        <div className="stat"><div className="label">近 90 天提前结束</div><div className={data?.summary?.last_90d >= 2 ? 'value text-red' : 'value'}>{data?.summary?.last_90d ?? 0} 次</div><div className="sub">{data?.summary?.risk_label}</div></div>
        <div className="stat"><div className="label">最近一次</div><div className="value" style={{ fontSize: 16 }}>{data?.summary?.last_at ? dt(data.summary.last_at) : '—'}</div></div>
      </div>

      <div className="card">
        <h3>提前结束发布记录</h3>
        {!(data?.records?.length) && <div className="empty">暂无提前结束记录</div>}
        <div className="table-wrap">
          <table>
            <thead><tr><th>记录</th><th>车位/订单</th><th>上报时间</th><th>提前(分)</th><th>车辆在场</th><th>剩余(分)</th><th>风险</th><th>处置结果</th></tr></thead>
            <tbody>
              {(data?.records ?? []).map((r: any) => (
                <tr key={r.id}>
                  <td className="mono small">{r.code}</td>
                  <td>{r.spot_code}{r.reservation_code && <div className="small muted mono">{r.reservation_code} · {r.plate ?? ''}</div>}</td>
                  <td className="small">{dt(r.reported_at)}</td>
                  <td>{r.early_minutes}</td>
                  <td>{r.car_on_site ? '已入场' : '未入场'}</td>
                  <td>{r.remaining_minutes}</td>
                  <td><Tag cls={r.risk_level === 'low' ? 'green' : r.risk_level === 'medium' ? 'amber' : 'red'} label={r.risk_level} /></td>
                  <td><Tag status={r.resolution} />{r.detail?.outcome?.relocated_to && <div className="small muted">换位至 {r.detail.outcome.relocated_to}</div>}
                    {r.resolution === 'pending' && (
                      <div className="btn-row" style={{ marginTop: 4 }}>
                        <button className="btn sm gray" disabled={busyRec === r.id} onClick={() => decideRecord(r.id, 'owner_wait')}>等待</button>
                        <button className="btn sm ghost" disabled={busyRec === r.id} onClick={() => decideRecord(r.id, 'breach_pay')}>付违约补偿</button>
                        <button className="btn sm" disabled={busyRec === r.id} onClick={() => decideRecord(r.id, 'property_coordination')}>物业协调</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>开放时段审核记录</h3>
        {!(reviews?.length) && <div className="empty">暂无开放时段调整申请</div>}
        {(reviews ?? []).map((w: any) => (
          <div key={w.id} className={`ticket-card ${w.status === 'pending' ? 'open' : 'resolved'}`}>
            <div className="ticket-head">
              <span className="ticket-title">{w.spot_code} · 周计划调整</span>
              <span className="btn-row"><Tag cls={w.risk_level === 'low' ? 'green' : w.risk_level === 'medium' ? 'amber' : 'red'} label={`${w.risk_level}风险 · ${w.early_termination_count}次`} /><Tag status={w.status} /></span>
            </div>
            <div className="small">
              {(w.windows ?? []).map((x: any, i: number) =>
                <Tag key={i} cls="gray" label={`周${'日一二三四五六'[x.weekday]} ${String(x.start_time).slice(0, 5)}-${String(x.end_time).slice(0, 5)}`} />)}
            </div>
            {w.review_note && <div className="small" style={{ marginTop: 4 }}>审核备注：{w.review_note}</div>}
          </div>
        ))}
      </div>

      {applySpot && (
        <ShareWindowApplyModal
          spots={spots ?? []}
          initial={applySpot}
          onClose={() => setApplySpot(null)}
          onDone={() => { setApplySpot(null); setMsg('开放时段申请已提交'); reloadReviews(); }}
        />
      )}
      {msg && <div className="alert ok">{msg}</div>}
    </div>
  );
}

function ShareWindowApplyModal({ spots, initial, onClose, onDone }: any) {
  const [spotId, setSpotId] = useState(initial.id);
  const current = spots.find((s: any) => s.id === spotId) ?? initial;
  const [windows, setWindows] = useState<any[]>(
    (current.windows ?? []).map((w: any) => ({ weekday: w.weekday, start_time: String(w.start_time).slice(0, 5), end_time: String(w.end_time).slice(0, 5) })),
  );
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  const pickSpot = (id: number) => {
    setSpotId(id);
    const s = spots.find((x: any) => x.id === id);
    setWindows((s?.windows ?? []).map((w: any) => ({ weekday: w.weekday, start_time: String(w.start_time).slice(0, 5), end_time: String(w.end_time).slice(0, 5) })));
  };
  const has = (wd: number) => windows.some((w) => w.weekday === wd);
  const toggle = (wd: number) =>
    setWindows(has(wd) ? windows.filter((w) => w.weekday !== wd) : [...windows, { weekday: wd, start_time: '19:00', end_time: '08:00' }]);
  const patch = (wd: number, k: string, v: string) =>
    setWindows(windows.map((w) => (w.weekday === wd ? { ...w, [k]: v } : w)));

  const submit = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await api('POST', `/spots/${spotId}/share-windows`, { windows, reason: reason || undefined });
      if (r.status === 'pending') alert(r.message);
      onDone();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <div className="modal-head"><h3>追加 / 调整开放共享时段</h3><button className="close-x" onClick={onClose}>×</button></div>
        <div className="modal-body">
          {err && <div className="alert error">{err}</div>}
          <div className="field">
            <label>选择车位</label>
            <select value={spotId} onChange={(e) => pickSpot(Number(e.target.value))}>
              {spots.filter((s: any) => s.review_status === 'approved').map((s: any) => <option key={s.id} value={s.id}>{s.code}</option>)}
            </select>
          </div>
          <div className="field">
            <label>每周开放时段（跨天如 19:00→次日 08:00）</label>
            <div className="grid" style={{ gap: 6 }}>
              {WEEK.map((w, i) => {
                const win = windows.find((x) => x.weekday === i);
                return (
                  <div key={i} className="btn-row" style={{ alignItems: 'center' }}>
                    <label className="checkbox" style={{ width: 70 }}><input type="checkbox" checked={!!win} onChange={() => toggle(i)} />周{w}</label>
                    <input type="time" style={{ width: 110 }} disabled={!win} value={win?.start_time ?? ''} onChange={(e) => patch(i, 'start_time', e.target.value)} />
                    <span className="muted">至</span>
                    <input type="time" style={{ width: 110 }} disabled={!win} value={win?.end_time ?? ''} onChange={(e) => patch(i, 'end_time', e.target.value)} />
                  </div>
                );
              })}
            </div>
          </div>
          <div className="field"><label>调整说明（如近期回家时间变化）</label><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：最近加班减少，工作日延长到 23:30" /></div>
          <div className="alert info">低风险记录时系统自动通过；近 90 天有 2 次及以上提前结束时，需物业人工谨慎审核后才生效。</div>
        </div>
        <div className="modal-foot">
          <button className="btn gray" onClick={onClose}>取消</button>
          <button className="btn" disabled={busy || windows.length === 0} onClick={submit}>{busy ? '提交中…' : '提交开放时段'}</button>
        </div>
      </div>
    </div>
  );
}


// ---------- 申诉（业主查看）----------
function AppealsTab() {
  const { data: appeals } = useLoader<any[]>('/appeals');
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div>
      <PageHead title="车位申诉" desc="车主对自家车位订单发起的错停申诉，可查看证据链与物业终裁结果" />
      <div className="card">
        {(appeals ?? []).length === 0 && <div className="empty">暂无申诉</div>}
        <div className="table-wrap">
          <table>
            <thead><tr><th>申诉单</th><th>订单/车位</th><th>事由</th><th>裁决</th><th></th></tr></thead>
            <tbody>
              {(appeals ?? []).map((a) => (
                <tr key={a.id}>
                  <td className="mono small">{a.code}<div className="small muted">{dt(a.created_at)}</div></td>
                  <td>{a.spot_code}<div className="small muted mono">{a.reservation_code} · {a.plate}</div></td>
                  <td className="small">{a.reason}</td>
                  <td><Tag status={a.status} /></td>
                  <td><button className="btn sm gray" onClick={() => setOpen(a.id)}>查看证据与裁决</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {open && <AppealDetailModal id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
