import { useEffect, useState, type ReactNode } from 'react';

import { api } from './api.ts';
import { Header } from './components/Header.tsx';
import { HomeView } from './views/HomeView.tsx';
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
  ConversationDetail,
  ConversationsPayload,
  DayPayload,
  DoctorPayload,
  LogsPayload,
  MatrixPayload,
  TotalPayload
} from './types.ts';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayDate(): string {
  return dayOf(Date.now());
}

function currentMonth(): string {
  return todayDate().slice(0, 7);
}

/** 路径 → 顶部导航的视图 id。 */
function viewOf(path: string): View {
  if (path === '/today' || path.startsWith('/today/')) return 'today';
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

function LoadingScreen() {
  return (
    <div className="receipt">
      <div className="rhead">
        <div className="name">ATRACKER</div>
        <div className="sub">LOCAL TOKEN RECEIPT</div>
      </div>
      <div className="placeholder" style={{ padding: 40 }}>
        正在读取本机数据…
      </div>
    </div>
  );
}

function FirstRun() {
  return (
    <div className="receipt">
      <div className="rhead">
        <div className="name">ATRACKER</div>
        <div className="sub">LOCAL TOKEN RECEIPT</div>
      </div>
      <div className="rno">
        <span>NO. 00000000</span>
        <span>还没有数据</span>
        <span>TERMINAL 01</span>
      </div>
      <div className="placeholder" style={{ margin: '18px 0', lineHeight: 2 }}>
        本机还没有采集到用量。先在项目目录跑一次：
        <br />
        <b>npm run scan</b>
        <br />
        扫完刷新这一页。扫描器只读各 agent 的本地日志，不加钩子、不改 agent 行为。
      </div>
      <div className="placeholder">
        检查各来源是否可读：<b>node packages/cli/src/index.ts doctor</b>
      </div>
    </div>
  );
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="receipt">
      <div className="rhead">
        <div className="name">ATRACKER</div>
      </div>
      <div className="placeholder" style={{ margin: 20 }}>
        读取失败：{message}
      </div>
    </div>
  );
}

export function App() {
  const route = useRoute();
  const view = viewOf(route.path);

  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [unit, setUnit] = useState<Unit>(initialUnit);

  // 总账的状态全在 URL 里。没有 month 就用本月，没有 from/to 就是整月。
  const month = route.params.get('month') ?? currentMonth();
  const from = route.params.get('from');
  const to = route.params.get('to');
  const sel: Selection | null = from ? { a: from, b: to ?? from } : null;
  const topScope: 'range' | 'total' = route.params.get('scope') === 'total' ? 'total' : 'range';
  const homeRange = sel ? { from: sel.a, to: sel.b } : monthRange(month);

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

  // 旧版 URL（?view=conv&dir=…）转成 hash 路由，免得存过的链接失效。
  // 只跑一次：转换后地址栏里就没有 view 了，但模块加载时快照的 search 还在。
  useEffect(() => {
    if (legacyRedirected) return;
    legacyRedirected = true;
    const q = new URLSearchParams(location.search);
    const v = q.get('view');
    if (!v) return;
    if (v === 'today') navigate('/today/' + (q.get('date') ?? todayDate()), [], { replace: true });
    else if (v === 'conv') {
      navigate('/conversations', [
        ['dir', q.get('dir')],
        ['agent', q.get('agent')],
        ['model', q.get('model')],
        ['vendor', q.get('vendor')]
      ], { replace: true });
    } else if (v === 'log') navigate('/logs', [], { replace: true });
    else {
      const legacyFrom = q.get('from');
      if (legacyFrom && DAY_RE.test(legacyFrom)) {
        navigate('/', [
          ['month', legacyFrom.slice(0, 7)],
          ['from', legacyFrom],
          ['to', legacyFrom]
        ], { replace: true });
      } else navigate('/', [], { replace: true });
    }
  }, []);

  // 总账：累计、日历、区间聚合、来源 × 模型
  useEffect(() => {
    if (view !== 'home') return;
    let alive = true;
    Promise.all([
      api.total(),
      api.calendar(month),
      api.aggregate(homeRange.from, homeRange.to),
      api.matrix(homeRange.from, homeRange.to)
    ])
      .then(([t, c, a, m]) => {
        if (!alive) return;
        setTotal(t);
        setCal(c);
        setAgg(a);
        setMatrix(m);
        setError(null);
      })
      .catch(err => {
        if (alive) setError((err as Error).message);
      });
    return () => { alive = false; };
  }, [view, month, homeRange.from, homeRange.to, refreshToken]);

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
      api.doctor()
    ])
      .then(([l, d]) => {
        if (!alive) return;
        setLogs(l);
        setDoctor(d);
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

  /** 点顶部导航。每个按钮都回到自己的默认状态，不继承别的视图的选中项。 */
  function handleNav(next: View) {
    if (next === 'home') navigate('/');
    else if (next === 'today') navigate('/today');
    else if (next === 'conv') navigate('/conversations');
    else navigate('/logs');
  }

  /* ---------- 总账 ---------- */

  /** 改总账的 URL。同一页里改条件用 replace，避免后退要点很多次。 */
  function goHome(next: { month?: string; sel?: Selection | null; scope?: 'range' | 'total' }): void {
    const m = next.month ?? month;
    const s = next.sel === undefined ? sel : next.sel;
    const scope = next.scope ?? topScope;
    navigate('/', [
      ['month', m === currentMonth() ? null : m],
      ['from', s?.a],
      ['to', s?.b],
      ['scope', scope === 'total' ? 'total' : null]
    ], { replace: true });
  }

  function selectDay(dayKey: string) {
    let next: Selection | null;
    if (sel === null) next = { a: dayKey, b: dayKey };
    else if (sel.a === sel.b) {
      if (dayKey === sel.a) next = null;
      else next = dayKey < sel.a ? { a: dayKey, b: sel.b } : { a: sel.a, b: dayKey };
    } else next = { a: dayKey, b: dayKey };
    goHome({ sel: next });
  }

  function prevMonth() {
    goHome({ month: shiftMonth(month, -1), sel: null });
  }

  function nextMonth() {
    goHome({ month: shiftMonth(month, 1), sel: null });
  }

  function backToCurrentMonth() {
    goHome({ month: currentMonth(), sel: null });
  }

  function clearSelection() {
    goHome({ sel: null });
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

  /** 「在日历中查看这天」：回到总账，选中这天。 */
  function openDayInCalendar(date: string) {
    navigate('/', [['month', date.slice(0, 7)], ['from', date], ['to', date]]);
  }

  /* ---------- 日志 ---------- */

  function filterLogs(patch: Partial<LogFilter>) {
    navigate('/logs', logParams({ ...logFilter, ...patch }), { replace: true });
  }

  function clearLog() {
    navigate('/logs', [], { replace: true });
  }

  if (error) return <ErrorScreen message={error} />;

  let body: ReactNode;
  if (view === 'home') {
    const stale = !agg || !cal || agg.from !== homeRange.from || agg.to !== homeRange.to || cal.month !== month;
    if (!total || !matrix || stale) return <LoadingScreen />;
    if (total.total === 0) return <FirstRun />;
    body = (
      <HomeView
        total={total}
        cal={cal}
        agg={agg}
        matrix={matrix}
        month={month}
        sel={sel}
        unit={unit}
        onPrevMonth={prevMonth}
        onNextMonth={nextMonth}
        onToday={backToCurrentMonth}
        onSelectDay={selectDay}
        onClearSelection={clearSelection}
        topScope={topScope}
        onTopScope={scope => goHome({ scope })}
        onOpenDir={dir => navigate('/conversations', [['dir', dir]])}
        onOpenCell={(agent, model, vendor) =>
          navigate('/conversations', [['agent', agent], ['model', model], ['vendor', vendor]])}
      />
    );
  } else if (view === 'today') {
    if (!day || day.date !== dayDate) return <LoadingScreen />;
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
  } else if (view === 'conv') {
    if (!conv) return <LoadingScreen />;
    body = (
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
    );
  } else {
    if (!logs) return <LoadingScreen />;
    body = (
      <LogsView
        logs={logs}
        doctor={doctor}
        filter={logFilter}
        onFilter={patch => filterLogs(patch)}
        onClear={clearLog}
        onRescan={api.scan}
      />
    );
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
      {body}
    </div>
  );
}
