import { useEffect, useState, type ReactNode } from 'react';

import { api } from './api.ts';
import { Header } from './components/Header.tsx';
import { HomeView } from './views/HomeView.tsx';
import { TodayView } from './views/TodayView.tsx';
import { ConversationsView } from './views/ConversationsView.tsx';
import { LogsView } from './views/LogsView.tsx';
import {
  dayOf,
  monthRange,
  shiftMonth
} from './format.ts';
import {
  EMPTY_CONV_FILTER,
  EMPTY_LOG_FILTER,
  type ConversationFilter,
  type LogFilter,
  type Selection,
  type Theme,
  type Unit,
  type View
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

interface NavOptions {
  clearConv?: boolean;
  dir?: string;
  agent?: string;
  model?: string | null;
  day?: string;
  date?: string;
}

const params = new URLSearchParams(location.search);

function initialView(): View {
  const v = params.get('view');
  return v === 'today' || v === 'conv' || v === 'log' ? v : 'home';
}

/** 当日详情页看哪一天。默认今天，可以用 date 参数打开某一天。 */
function initialDayDate(): string {
  const d = params.get('date');
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : dayOf(Date.now());
}

/** 日期加减一天。 */
function shiftDay(date: string, delta: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + delta * 86400000;
  const nd = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${nd.getUTCFullYear()}-${p(nd.getUTCMonth() + 1)}-${p(nd.getUTCDate())}`;
}

function initialUnit(): Unit {
  const u = params.get('unit');
  return u === 'abbr' || u === 'full' ? u : 'zh';
}

function initialTheme(): Theme {
  const fromUrl = params.get('theme');
  if (fromUrl === 'dark' || fromUrl === 'light') return fromUrl;
  try {
    const saved = localStorage.getItem('atracker-mode');
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    // localStorage 不可用时退回默认值
  }
  return 'light';
}

function initialMonth(): string {
  const from = params.get('from');
  if (from && /^\d{4}-\d{2}/.test(from)) return from.slice(0, 7);
  return new Date().toISOString().slice(0, 7);
}

function initialSelection(): Selection | null {
  const from = params.get('from');
  return from ? { a: from, b: from } : null;
}

function initialConvFilter(): ConversationFilter {
  return {
    dir: params.get('dir'),
    agent: params.get('agent'),
    model: params.get('model')
  };
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
  const [view, setView] = useState<View>(initialView);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [unit, setUnit] = useState<Unit>(initialUnit);
  const [month, setMonth] = useState<string>(initialMonth);
  const [dayDate, setDayDate] = useState<string>(initialDayDate);
  const [sel, setSel] = useState<Selection | null>(initialSelection);
  const [topScope, setTopScope] = useState<'range' | 'total'>('range');
  const [convFilter, setConvFilter] = useState<ConversationFilter>(initialConvFilter);
  const [convQ, setConvQ] = useState('');
  const [convId, setConvId] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState<LogFilter>(EMPTY_LOG_FILTER);

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

  // 总账：累计、日历、区间聚合、来源 × 模型
  useEffect(() => {
    if (view !== 'home') return;
    let alive = true;
    const range = sel ? { from: sel.a, to: sel.b } : monthRange(month);
    Promise.all([
      api.total(),
      api.calendar(month),
      api.aggregate(range.from, range.to),
      api.matrix(range.from, range.to)
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
  }, [view, month, sel, refreshToken]);

  // 会话列表。目录不进请求参数：一级菜单要列出所有目录，
  // 选哪个目录是前端的二级菜单状态。
  useEffect(() => {
    if (view !== 'conv') return;
    let alive = true;
    api.conversations({
      agent: convFilter.agent,
      model: convFilter.model,
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
  }, [view, convFilter.agent, convFilter.model, convQ, refreshToken]);

  // 选中的会话必须落在当前这一组里。目录换了就换成新组里的第一个；
  // 选中的目录在这批结果里不存在，就退回全部目录。
  useEffect(() => {
    if (view !== 'conv' || !conv) return;
    const groups = conv.groups;
    if (convFilter.dir && !groups.some(g => g.dir.path === convFilter.dir)) {
      setConvFilter(prev => ({ ...prev, dir: null }));
      return;
    }
    const list = convFilter.dir
      ? (groups.find(g => g.dir.path === convFilter.dir)?.list ?? [])
      : groups.flatMap(g => g.list);
    setConvId(prev => (list.some(c => c.id === prev) ? prev : (list[0]?.id ?? null)));
  }, [view, conv, convFilter.dir]);

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
      api.logs({
        batch: logFilter.batch,
        level: logFilter.lvl,
        source: logFilter.src,
        q: logFilter.q
      }),
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
  }, [view, logFilter, refreshToken]);

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

  function navigate(next: View, opts: NavOptions = {}) {
    let nextFilter = convFilter;
    let nextSel = sel;
    let nextDate = dayDate;

    setView(next);

    if (opts.date) {
      nextDate = opts.date;
      setDayDate(nextDate);
    }

    if (opts.clearConv) {
      nextFilter = EMPTY_CONV_FILTER;
      setConvFilter(nextFilter);
      setConvQ('');
      setConvId(null);
    } else if (opts.dir) {
      nextFilter = { dir: opts.dir, agent: null, model: null };
      setConvFilter(nextFilter);
      setConvQ('');
      setConvId(null);
    } else if (opts.agent) {
      nextFilter = { dir: null, agent: opts.agent, model: opts.model ?? null };
      setConvFilter(nextFilter);
      setConvQ('');
      setConvId(null);
    }

    if (opts.day) {
      nextSel = { a: opts.day, b: opts.day };
      setSel(nextSel);
      setMonth(dayOf(new Date(opts.day + 'T00:00:00').getTime()).slice(0, 7));
    }

    const url = new URL(location.href);
    url.searchParams.set('view', next);
    for (const key of ['dir', 'agent', 'model', 'from', 'date']) url.searchParams.delete(key);
    if (next === 'conv') {
      if (nextFilter.dir) url.searchParams.set('dir', nextFilter.dir);
      if (nextFilter.agent) url.searchParams.set('agent', nextFilter.agent);
      if (nextFilter.model) url.searchParams.set('model', nextFilter.model);
    }
    if (next === 'today') url.searchParams.set('date', nextDate);
    if (nextSel) url.searchParams.set('from', nextSel.a);
    history.replaceState({}, '', url);
  }

  function handleNav(next: View) {
    if (next === 'conv') navigate('conv', { clearConv: true });
    else if (next === 'today') navigate('today', { date: dayDate });
    else navigate(next);
  }

  function selectDay(day: string) {
    setSel(prev => {
      if (!prev) return { a: day, b: day };
      if (prev.a === prev.b) {
        if (day === prev.a) return null;
        return { a: day < prev.a ? day : prev.a, b: day > prev.b ? day : prev.b };
      }
      return { a: day, b: day };
    });
  }

  function prevMonth() {
    setMonth(m => shiftMonth(m, -1));
    setSel(null);
  }

  function nextMonth() {
    setMonth(m => shiftMonth(m, 1));
    setSel(null);
  }

  function today() {
    setSel(null);
    setMonth(dayOf(Date.now()).slice(0, 7));
  }

  function clearConversation() {
    navigate('conv', { clearConv: true });
  }

  /** 清掉日历上的选区，回到整月。 */
  function clearSelection() {
    setSel(null);
    const url = new URL(location.href);
    url.searchParams.delete('from');
    history.replaceState({}, '', url);
  }

  /** 一级菜单选目录。只改二级菜单看哪一组，别的筛选不动。 */
  function selectDir(path: string | null) {
    setConvFilter(prev => ({ ...prev, dir: path }));
    const url = new URL(location.href);
    url.searchParams.set('view', 'conv');
    if (path) url.searchParams.set('dir', path);
    else url.searchParams.delete('dir');
    history.replaceState({}, '', url);
  }

  function clearLog() {
    setLogFilter(EMPTY_LOG_FILTER);
  }

  function gotoDay(date: string) {
    navigate('today', { date });
  }

  function prevDay() {
    gotoDay(shiftDay(dayDate, -1));
  }

  function nextDay() {
    gotoDay(shiftDay(dayDate, 1));
  }

  function backToToday() {
    gotoDay(dayOf(Date.now()));
  }

  if (error) return <ErrorScreen message={error} />;

  let body: ReactNode;
  if (view === 'home') {
    if (!total || !cal || !agg || !matrix) return <LoadingScreen />;
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
        onToday={today}
        onSelectDay={selectDay}
        onClearSelection={clearSelection}
        topScope={topScope}
        onTopScope={setTopScope}
        onOpenDir={dir => navigate('conv', { dir })}
        onOpenCell={(agent, model) => navigate('conv', { agent, model })}
      />
    );
  } else if (view === 'today') {
    if (!day) return <LoadingScreen />;
    body = (
      <TodayView
        day={day}
        unit={unit}
        onPrevDay={prevDay}
        onNextDay={nextDay}
        onToday={backToToday}
        onOpenCell={(agent, model) => navigate('conv', { agent, model })}
        onOpenDir={dir => navigate('conv', { dir })}
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
        onSelect={setConvId}
        onSearch={setConvQ}
        onClear={clearConversation}
        onGoDay={day => navigate('home', { day })}
      />
    );
  } else {
    if (!logs) return <LoadingScreen />;
    body = (
      <LogsView
        logs={logs}
        doctor={doctor}
        filter={logFilter}
        onFilter={patch => setLogFilter(prev => ({ ...prev, ...patch }))}
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
