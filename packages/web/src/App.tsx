import { useEffect, useState, type ReactNode } from 'react';

import { api } from './api.ts';
import { Header } from './components/Header.tsx';
import { LedgerView } from './views/LedgerView.tsx';
import { MonthView } from './views/MonthView.tsx';
import { TodayView } from './views/TodayView.tsx';
import { ConversationsView } from './views/ConversationsView.tsx';
import { LogsView } from './views/LogsView.tsx';
import { dayOf, monthRange, shiftMonth } from './format.ts';
import { navigate, useRoute, type Params } from './router.ts';
import type {
  ConversationFilter,
  LogFilter,
  Selection,
  Theme,
  Unit,
  View
} from './state.ts';
import type {
  AggregatePayload,
  CalendarPayload,
  DevicesPayload,
  ConversationDetail,
  ConversationsPayload,
  DayPayload,
  DoctorPayload,
  LogsPayload,
  MatrixPayload,
  TotalPayload
} from './types.ts';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

function todayDate(): string {
  return dayOf(Date.now());
}

function currentMonth(): string {
  return todayDate().slice(0, 7);
}

/** 路径 → 顶部导航的视图 id。 */
function viewOf(path: string): View {
  if (path === '/today' || path.startsWith('/today/')) return 'today';
  if (path === '/month' || path.startsWith('/month/')) return 'month';
  if (path === '/conversations') return 'conv';
  if (path === '/logs') return 'log';
  return 'home';
}

/** 会话页的参数。 */
function convParams(f: ConversationFilter, q: string, id: string | null): Params {
  return [
    ['dir', f.dir],
    ['agent', f.agent],
    ['model', f.model],
    ['vendor', f.vendor],
    ['q', q],
    ['id', id]
  ];
}

/** 日志页的参数。和默认值相同的项不写进 URL。 */
function logParams(f: LogFilter): Params {
  return [
    ['batch', f.batch === null ? null : String(f.batch)],
    ['level', f.lvl === 'all' ? null : f.lvl],
    ['source', f.src === 'all' ? null : f.src],
    ['q', f.q || null]
  ];
}

/** 日期加减一天。 */
function shiftDay(date: string, delta: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + delta * 86400000;
  const nd = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${nd.getUTCFullYear()}-${p(nd.getUTCMonth() + 1)}-${p(nd.getUTCDate())}`;
}

const searchParams = new URLSearchParams(location.search);

/** 旧版 URL 只转换一次。模块级标记，StrictMode 下重复执行也不会重定向。 */
let legacyRedirected = false;

function initialUnit(): Unit {
  const u = searchParams.get('unit');
  return u === 'abbr' || u === 'full' ? u : 'zh';
}

function initialTheme(): Theme {
  const fromUrl = searchParams.get('theme');
  if (fromUrl === 'dark' || fromUrl === 'light') return fromUrl;
  try {
    const saved = localStorage.getItem('atracker-mode');
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    // localStorage 不可用时退回默认值
  }
  return 'light';
}

/** 占位只替换正文，页头和导航一直在，避免整张小票闪一下。 */
function LoadingScreen() {
  return (
    <div className="placeholder" style={{ padding: 40 }}>
      正在读取本机数据…
    </div>
  );
}

/**
 * 还没有任何数据时的占位。桌面版启动时会自动扫一次，命令行版可能还需要手动跑
 * `npm run scan`，所以这里给一个「立即扫描」按钮，两种场景都能用。
 */
function FirstRun() {
  return (
    <>
      <div className="placeholder" style={{ margin: '18px 0', lineHeight: 2 }}>
        本机还没有采集到用量。扫描已经开始，数据到了这一页会自动刷新。
        <br />
        扫描器只读各 agent 的本地日志，不加钩子、不改 agent 行为。
      </div>
      <div className="placeholder">
        <button className="ghost" onClick={() => api.scan()}>重新扫描</button>
        <div style={{ marginTop: 10 }}>
          各来源是否可读：<b>node packages/cli/src/index.ts doctor</b>
        </div>
      </div>
    </>
  );
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="placeholder" style={{ margin: 20 }}>
      读取失败：{message}
    </div>
  );
}

export function App() {
  const route = useRoute();
  const view = viewOf(route.path);

  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [unit, setUnit] = useState<Unit>(initialUnit);

  // 月度页：月份在路径里（#/month/2026-09 或 ?month=），选区在查询参数里。
  const monthMatch = route.path.match(/^\/month\/([^/]+)$/);
  const monthParam = monthMatch && MONTH_RE.test(monthMatch[1]) ? monthMatch[1] : route.params.get('month');
  const month = monthParam && MONTH_RE.test(monthParam) ? monthParam : currentMonth();
  const from = route.params.get('from');
  const to = route.params.get('to');
  const sel: Selection | null = from ? { a: from, b: to ?? from } : null;
  // 月度页的查询区间：有选区用选区，没有就是整月。
  const monthRangeOf = monthRange(month);
  const range = sel ? { from: sel.a, to: sel.b } : monthRangeOf;

  // 今日的日期在路径里。#/today 永远指今天。
  const dayMatch = route.path.match(/^\/today\/(.+)$/);
  const dayDate = dayMatch && DAY_RE.test(dayMatch[1]) ? dayMatch[1] : todayDate();

  // 会话页的状态。
  const convFilter: ConversationFilter = {
    dir: route.params.get('dir'),
    agent: route.params.get('agent'),
    model: route.params.get('model'),
    vendor: route.params.get('vendor')
  };
  const convQ = route.params.get('q') ?? '';
  const convId = route.params.get('id');

  // 日志页的状态。
  const batchParam = route.params.get('batch');
  const logFilter: LogFilter = {
    batch: batchParam ? Number(batchParam) : null,
    lvl: route.params.get('level') ?? 'all',
    src: route.params.get('source') ?? 'all',
    q: route.params.get('q') ?? ''
  };

  const [total, setTotal] = useState<TotalPayload | null>(null);
  const [cal, setCal] = useState<CalendarPayload | null>(null);
  const [agg, setAgg] = useState<AggregatePayload | null>(null);
  const [matrix, setMatrix] = useState<MatrixPayload | null>(null);
  const [conv, setConv] = useState<ConversationsPayload | null>(null);
  const [convDetail, setConvDetail] = useState<ConversationDetail | null>(null);
  const [logs, setLogs] = useState<LogsPayload | null>(null);
  const [doctor, setDoctor] = useState<DoctorPayload | null>(null);
  const [devices, setDevices] = useState<DevicesPayload | null>(null);
  const [day, setDay] = useState<DayPayload | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    document.documentElement.dataset.mode = theme;
    try {
      localStorage.setItem('atracker-mode', theme);
    } catch {
      // 无痕模式等场景允许失败
    }
  }, [theme]);

  // 旧版 URL 转成新路由，免得存过的链接失效。只跑一次。
  useEffect(() => {
    if (legacyRedirected) return;
    legacyRedirected = true;
    const q = new URLSearchParams(location.search);
    const v = q.get('view');
    const legacyFrom = q.get('from');
    const legacyTo = q.get('to') ?? legacyFrom;
    if (legacyFrom && DAY_RE.test(legacyFrom) && (!v || v === 'home')) {
      navigate('/month/' + legacyFrom.slice(0, 7), [['from', legacyFrom], ['to', legacyTo]], { replace: true });
      return;
    }
    if (!v) return;
    if (v === 'today') navigate('/today/' + (q.get('date') ?? todayDate()), [], { replace: true });
    else if (v === 'month') navigate('/month', [], { replace: true });
    else if (v === 'conv') {
      navigate('/conversations', [
        ['dir', q.get('dir')],
        ['agent', q.get('agent')],
        ['model', q.get('model')],
        ['vendor', q.get('vendor')]
      ], { replace: true });
    } else if (v === 'log') navigate('/logs', [], { replace: true });
    else navigate('/', [], { replace: true });
  }, []);

  // 累计总量。只有扫描完成时才会变，不跟着选区或日期重复取。
  useEffect(() => {
    let alive = true;
    api.total()
      .then(t => {
        if (!alive) return;
        setTotal(t);
        setError(null);
      })
      .catch(err => {
        if (alive) setError((err as Error).message);
      });
    return () => { alive = false; };
  }, [refreshToken]);

  // 总账：全期累计、四桶、来源 × 模型。没有日历，也没有范围切换。
  useEffect(() => {
    if (view !== 'home') return;
    let alive = true;
    Promise.all([api.aggregateAll(), api.matrixAll()])
      .then(([a, m]) => {
        if (!alive) return;
        setAgg(a);
        setMatrix(m);
        setError(null);
      })
      .catch(err => {
        if (alive) setError((err as Error).message);
      });
    return () => { alive = false; };
  }, [view, refreshToken]);

  // 月度：日历只跟月份走。改选区时不用重新取日历。
  useEffect(() => {
    if (view !== 'month') return;
    let alive = true;
    api.calendar(month)
      .then(c => {
        if (!alive) return;
        setCal(c);
        setError(null);
      })
      .catch(err => {
        if (alive) setError((err as Error).message);
      });
    return () => { alive = false; };
  }, [view, month, refreshToken]);

  // 月度：区间汇总和交叉表跟着选区走。
  useEffect(() => {
    if (view !== 'month') return;
    let alive = true;
    Promise.all([api.aggregate(range.from, range.to), api.matrix(range.from, range.to)])
      .then(([a, m]) => {
        if (!alive) return;
        setAgg(a);
        setMatrix(m);
        setError(null);
      })
      .catch(err => {
        if (alive) setError((err as Error).message);
      });
    return () => { alive = false; };
  }, [view, range.from, range.to, refreshToken]);

  // 会话列表。目录不进请求参数：一级菜单要列出所有目录，
  // 选哪个目录是前端的二级菜单状态。
  useEffect(() => {
    if (view !== 'conv') return;
    let alive = true;
    api.conversations({
      agent: convFilter.agent,
      model: convFilter.model,
      vendor: convFilter.vendor,
      q: convQ
    })
      .then(data => {
        if (!alive) return;
        setConv(data);
        setError(null);
      })
      .catch(err => {
        if (alive) setError((err as Error).message);
      });
    return () => { alive = false; };
  }, [view, convFilter.agent, convFilter.model, convFilter.vendor, convQ, refreshToken]);

  // 选中的目录和会话必须在这一批结果里，不在就改成默认值写回 URL。
  useEffect(() => {
    if (view !== 'conv' || !conv) return;
    const groups = conv.groups;
    if (convFilter.dir && !groups.some(g => g.dir.path === convFilter.dir)) {
      navigate('/conversations', convParams({ ...convFilter, dir: null }, convQ, convId), { replace: true });
      return;
    }
    const list = convFilter.dir
      ? (groups.find(g => g.dir.path === convFilter.dir)?.list ?? [])
      : groups.flatMap(g => g.list);
    if (list.length === 0) return;
    if (!list.some(c => c.id === convId)) {
      navigate('/conversations', convParams(convFilter, convQ, list[0].id), { replace: true });
    }
  }, [view, conv, convFilter.dir, convFilter.agent, convFilter.model, convFilter.vendor, convQ, convId]);

  // 单个会话详情
  useEffect(() => {
    if (view !== 'conv' || !convId) {
      setConvDetail(null);
      return;
    }
    let alive = true;
    api.conversation(convId)
      .then(data => {
        if (!alive) return;
        setConvDetail(data);
        setError(null);
      })
      .catch(err => {
        if (alive) setError((err as Error).message);
      });
    return () => { alive = false; };
  }, [view, convId, refreshToken]);

  // 日志与来源状态
  useEffect(() => {
    if (view !== 'log') return;
    let alive = true;
    Promise.all([
      api.logs({ batch: logFilter.batch, level: logFilter.lvl, source: logFilter.src, q: logFilter.q }),
      api.doctor(),
      api.devices()
    ])
      .then(([l, d, dv]) => {
        if (!alive) return;
        setLogs(l);
        setDoctor(d);
        setDevices(dv);
        setError(null);
      })
      .catch(err => {
        if (alive) setError((err as Error).message);
      });
    return () => { alive = false; };
  }, [view, logFilter.batch, logFilter.lvl, logFilter.src, logFilter.q, refreshToken]);

  // 当日详情
  useEffect(() => {
    if (view !== 'today') return;
    let alive = true;
    api.day(dayDate)
      .then(data => {
        if (!alive) return;
        setDay(data);
        setError(null);
      })
      .catch(err => {
        if (alive) setError((err as Error).message);
      });
    return () => { alive = false; };
  }, [view, dayDate, refreshToken]);

  // 扫描完成后刷新所有数据
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = () => setRefreshToken(n => n + 1);
    return () => es.close();
  }, []);

  /* ---------- 导航 ---------- */

  /** 点顶部导航。每个按钮都回到自己的默认状态。 */
  function handleNav(next: View) {
    if (next === 'home') navigate('/');
    else if (next === 'month') navigate('/month');
    else if (next === 'today') navigate('/today');
    else if (next === 'conv') navigate('/conversations');
    else navigate('/logs');
  }

  /* ---------- 月度 ---------- */

  /** 改月度的 URL。同一页里改条件用 replace，避免后退要点很多次。 */
  function goMonth(next: { month?: string; sel?: Selection | null }): void {
    const m = next.month ?? month;
    const s = next.sel === undefined ? sel : next.sel;
    const path = m === currentMonth() ? '/month' : `/month/${m}`;
    navigate(path, [['from', s?.a], ['to', s?.b]], { replace: true });
  }

  function selectDay(dayKey: string) {
    let next: Selection | null;
    if (sel === null) next = { a: dayKey, b: dayKey };
    else if (sel.a === sel.b) {
      if (dayKey === sel.a) next = null;
      else next = dayKey < sel.a ? { a: dayKey, b: sel.b } : { a: sel.a, b: dayKey };
    } else next = { a: dayKey, b: dayKey };
    goMonth({ sel: next });
  }

  function prevMonth() {
    goMonth({ month: shiftMonth(month, -1), sel: null });
  }

  function nextMonth() {
    goMonth({ month: shiftMonth(month, 1), sel: null });
  }

  function thisMonth() {
    goMonth({ month: currentMonth(), sel: null });
  }

  function clearSelection() {
    goMonth({ sel: null });
  }

  /* ---------- 今日 ---------- */

  function gotoDay(date: string) {
    navigate('/today/' + date);
  }

  function prevDay() {
    navigate('/today/' + shiftDay(dayDate, -1));
  }

  function nextDay() {
    navigate('/today/' + shiftDay(dayDate, 1));
  }

  function backToToday() {
    navigate('/today');
  }

  /* ---------- 会话 ---------- */

  function selectDir(path: string | null) {
    navigate('/conversations', convParams({ ...convFilter, dir: path }, convQ, convId), { replace: true });
  }

  function selectConversation(id: string) {
    navigate('/conversations', convParams(convFilter, convQ, id), { replace: true });
  }

  function searchConversations(q: string) {
    navigate('/conversations', convParams(convFilter, q, convId), { replace: true });
  }

  function clearConversation() {
    navigate('/conversations', [], { replace: true });
  }

  /** 「在日历中查看这天」：回到月度页并选中这天。 */
  function openDayInCalendar(date: string) {
    navigate(`/month/${date.slice(0, 7)}`, [['from', date], ['to', date]]);
  }

  /* ---------- 日志 ---------- */

  function filterLogs(patch: Partial<LogFilter>) {
    navigate('/logs', logParams({ ...logFilter, ...patch }), { replace: true });
  }

  function clearLog() {
    navigate('/logs', [], { replace: true });
  }

  // 数据在换月、换日、改选区时会短暂落后于 URL。这时不清屏，只把正文变淡，
  // 顶部走一条进度条；只有这个页面第一次加载才显示骨架。
  let refreshing = false;

  let body: ReactNode;
  if (error) {
    body = <ErrorScreen message={error} />;
  } else if (view === 'home') {
    // 全期汇总的起止要和 total 报的对上，避免刚从月度页切过来时用月度数字画一帧。
    const stale = !agg || !matrix || (total !== null && total.firstDay !== null && agg.from !== total.firstDay);
    if (!total || !agg || !matrix) {
      body = <LoadingScreen />;
    } else if (total.total === 0) {
      body = <FirstRun />;
    } else {
      refreshing = stale;
      body = (
      <LedgerView
        total={total}
        agg={agg}
        matrix={matrix}
        unit={unit}
        onOpenDir={dir => navigate('/conversations', [['dir', dir]])}
        onOpenCell={(agent, model, vendor) =>
          navigate('/conversations', [['agent', agent], ['model', model], ['vendor', vendor]])}
      />
      );
    }
  } else if (view === 'month') {
    const stale = !cal || !agg || !matrix || cal.month !== month || agg.from !== range.from || agg.to !== range.to;
    if (!agg || !matrix) {
      body = <LoadingScreen />;
    } else if (total && total.total === 0) {
      body = <FirstRun />;
    } else {
      refreshing = stale;
      body = (
      <MonthView
        cal={cal}
        agg={agg}
        matrix={matrix}
        month={month}
        sel={sel}
        unit={unit}
        stale={refreshing}
        onPrevMonth={prevMonth}
        onNextMonth={nextMonth}
        onThisMonth={thisMonth}
        onSelectDay={selectDay}
        onClearSelection={clearSelection}
        onOpenDay={gotoDay}
        onOpenDir={dir => navigate('/conversations', [['dir', dir]])}
        onOpenCell={(agent, model, vendor) =>
          navigate('/conversations', [['agent', agent], ['model', model], ['vendor', vendor]])}
      />
      );
    }
  } else if (view === 'today') {
    if (!day) {
      body = <LoadingScreen />;
    } else {
      refreshing = day.date !== dayDate;
      body = (
      <TodayView
        day={day}
        unit={unit}
        onPrevDay={prevDay}
        onNextDay={nextDay}
        onToday={backToToday}
        onOpenCell={(agent, model, vendor) =>
          navigate('/conversations', [['agent', agent], ['model', model], ['vendor', vendor]])}
        onOpenDir={dir => navigate('/conversations', [['dir', dir]])}
      />
      );
    }
  } else if (view === 'conv') {
    body = conv ? (
      <ConversationsView
        conv={conv}
        detail={convDetail}
        convId={convId}
        filter={convFilter}
        q={convQ}
        unit={unit}
        dirPath={convFilter.dir}
        onSelectDir={selectDir}
        onSelect={selectConversation}
        onSearch={searchConversations}
        onClear={clearConversation}
        onGoDay={openDayInCalendar}
      />
    ) : <LoadingScreen />;
  } else {
    body = logs ? (
      <LogsView
        logs={logs}
        doctor={doctor}
        devices={devices}
        filter={logFilter}
        onFilter={patch => filterLogs(patch)}
        onClear={clearLog}
        onRescan={api.scan}
      />
    ) : <LoadingScreen />;
  }

  return (
    <div className="receipt">
      <Header
        view={view}
        theme={theme}
        unit={unit}
        onNav={handleNav}
        onUnit={setUnit}
        onToggleTheme={() => setTheme(t => (t === 'light' ? 'dark' : 'light'))}
      />
      <div className="loadtrack">{refreshing && <i />}</div>
      <div className={refreshing ? 'body is-refreshing' : 'body'}>{body}</div>
    </div>
  );
}
