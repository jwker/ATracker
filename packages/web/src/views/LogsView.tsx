import { useState } from 'react';
import type { DoctorPayload, LogsPayload } from '../types.ts';
import type { LogFilter } from '../state.ts';
import { fmtTime, full } from '../format.ts';

interface LogsViewProps {
  logs: LogsPayload;
  doctor: DoctorPayload | null;
  filter: LogFilter;
  onFilter: (patch: Partial<LogFilter>) => void;
  onClear: () => void;
  onRescan: () => Promise<void>;
}

const LEVELS: { id: string; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'warn', label: '警告' },
  { id: 'err', label: '错误' }
];

const TRIGGER_LABEL: Record<string, string> = {
  watch: '文件变更',
  poll: '兜底轮询',
  manual: '手动'
};

const LEVEL_MARK: Record<string, string> = {
  ok: 'OK',
  info: '..',
  warn: '!',
  err: 'X'
};

export function LogsView(props: LogsViewProps) {
  const { logs, doctor, filter } = props;
  const [rescanning, setRescanning] = useState(false);

  const batches = logs.batches.map(b => {
    const rows = logs.logs.filter(l => l.batch_id === b.id);
    const started = b.started_at ?? 0;
    return {
      id: b.id,
      at: fmtTime(started),
      trigger: b.trigger,
      ms: b.finished_at ? b.finished_at - started : 0,
      files: b.files_scanned ?? 0,
      events: b.events_written ?? 0,
      dup: Math.max(0, (b.events_read ?? 0) - (b.events_written ?? 0)),
      skipped: Math.max(0, (b.files_total ?? 0) - (b.files_scanned ?? 0)),
      warn: rows.filter(l => l.level === 'warn').length,
      err: rows.filter(l => l.level === 'err').length
    };
  });

  const rows = logs.logs.map(l => ({
    at: fmtTime(l.at),
    lvl: l.level,
    src: l.source,
    msg: l.message,
    batch: l.batch_id
  }));

  const srcs = ['all'];
  for (const l of rows) if (!srcs.includes(l.src)) srcs.push(l.src);

  const diag = (doctor?.sources ?? []).map(s => ({
    name: s.id,
    ok: s.ok,
    text: s.ok ? `可读 / ${s.roots.length} 个路径` : '路径不存在'
  }));

  const last = batches[0] ?? {
    at: '—',
    ms: 0,
    trigger: '—',
    events: 0,
    dup: 0,
    skipped: 0,
    warn: 0,
    err: 0
  };

  const rescan = async () => {
    setRescanning(true);
    try {
      await props.onRescan();
    } catch {
      setRescanning(false);
    }
  };

  return (
    <>
      <div className="sec">
        <div className="sec-h">
          <b>扫描状态</b>
          <span>{last.at}</span>
          <span className="r">trigger {last.trigger}</span>
        </div>
        <div className="logstat">
          <div className="box">
            <div className="k">最近扫描</div>
            <div className="v">{last.at.slice(5, 16)}</div>
            <div className="s">{(last.ms / 1000).toFixed(1)} s / {last.trigger}</div>
          </div>
          <div className="box">
            <div className="k">写入事件</div>
            <div className="v">{full(last.events)}</div>
            <div className="s">去重 {last.dup} 条</div>
          </div>
          <div className="box">
            <div className="k">跳过文件</div>
            <div className="v">{last.skipped}</div>
            <div className="s">指纹未变</div>
          </div>
          <div className="box">
            <div className="k">警告 / 错误</div>
            <div className="v">{last.warn} / {last.err}</div>
            <div className="s">队列 0 / 2000</div>
          </div>
        </div>
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>过滤</b>
          <span>FILTER</span>
          <span className="r">{rows.length} 行</span>
        </div>
        <div className="f-label">级别</div>
        <div className="chips">
          {LEVELS.map(l => (
            <button
              key={l.id}
              className="chip"
              data-lvl={l.id}
              onClick={() => props.onFilter({ lvl: l.id })}
              aria-pressed={filter.lvl === l.id}
            >
              {l.label}
            </button>
          ))}
        </div>
        <div className="f-label">来源</div>
        <div className="chips">
          {srcs.map(x => (
            <button
              key={x}
              className="chip"
              data-src={x}
              onClick={() => props.onFilter({ src: x })}
              aria-pressed={filter.src === x}
            >
              {x === 'all' ? '全部' : x}
            </button>
          ))}
        </div>
        <input
          className="search"
          placeholder="关键字，例如 database is locked"
          value={filter.q}
          onChange={e => props.onFilter({ q: e.target.value })}
        />
        <div style={{ marginTop: 8 }}>
          <button className="ghost" onClick={props.onClear}>清除筛选</button>{' '}
          <button className="ghost" onClick={rescan}>
            {rescanning ? '已触发 / 排队中' : '重新扫描'}
          </button>
        </div>
        <div className="diag" style={{ marginTop: 9 }}>
          {diag.map(x => (
            <span key={x.name}>
              <b>{x.name}</b> {x.text}
            </span>
          ))}
        </div>
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>扫描批次</b>
          <span>点一行只看该批日志</span>
        </div>
        <table className="batch">
          <thead>
            <tr>
              <th className="l">时间</th>
              <th className="l">触发</th>
              <th>耗时</th>
              <th>文件</th>
              <th>事件</th>
              <th>警</th>
              <th>错</th>
              <th className="l">结果</th>
            </tr>
          </thead>
          <tbody>
            {batches.map(b => (
              <tr
                key={b.id}
                data-batch={b.id}
                className={filter.batch === b.id ? 'cur' : undefined}
                onClick={() => props.onFilter({ batch: filter.batch === b.id ? null : b.id })}
              >
                <td className="l">{b.at.slice(5)}</td>
                <td className="l">{TRIGGER_LABEL[b.trigger] ?? b.trigger}</td>
                <td>{b.ms}</td>
                <td>{b.files}</td>
                <td>{b.events}</td>
                <td>{b.warn}</td>
                <td>{b.err}</td>
                <td className="l">
                  {b.err ? <span className="stamp">有错误</span> : <span className="stamp ok">成功</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="sec">
        <div className="sec-h">
          <b>日志流</b>
          <span>EVENT TAPE</span>
          <span className="r">{filter.batch ? `批次 ${filter.batch}` : '全部批次'}</span>
        </div>
        <div className="tape">
          {rows.map((l, i) => (
            <div className={'ll ' + l.lvl} key={`${l.batch}-${l.at}-${i}`}>
              <span className="t">{l.at.slice(5)}</span>
              <span className="lv">{LEVEL_MARK[l.lvl] ?? l.lvl}</span>
              <span className="s">{l.src}</span>
              <span>{l.msg}</span>
            </div>
          ))}
          {rows.length === 0 && <div className="placeholder">没有符合条件的日志行。</div>}
        </div>
      </div>
    </>
  );
}
