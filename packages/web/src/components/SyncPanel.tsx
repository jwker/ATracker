// 多设备同步的状态面板，放在日志页。
// 同步是唯一一个「静默失败也看不出来」的部分：iCloud 不同步、对方关机、
// 文件写坏，页面上的数字都看着正常。所以这里把目录、上次导出/导入、
// 每台设备的最后写入时间、错误都摆出来。

import { useState } from 'react';
import type { SyncPayload } from '../types.ts';
import { api } from '../api.ts';

interface SyncPanelProps {
  sync: SyncPayload | null;
  /** 操作完成后让父组件重新取数 */
  onChanged: () => void;
}

function when(ts: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function SyncPanel({ sync, onChanged }: SyncPanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!sync) return <div className="placeholder">正在读取同步状态…</div>;

  if (!sync.enabled) {
    return (
      <div className="sync">
        <div className="row">
          <span className="k">状态</span>
          <span className="v">关闭</span>
        </div>
        <div className="note" style={{ marginTop: 6 }}>
          多设备同步关着。桌面版在「文件 → 多设备同步（iCloud）」里打开；
          命令行用 <code>atracker serve --sync</code>，或用 <code>--sync-dir</code> 指定任意目录。
        </div>
      </div>
    );
  }

  const imp = sync.lastImport;
  const devices = sync.devices;

  return (
    <div className="sync">
      <div className="row"><span className="k">同步目录</span><span className="v">{sync.dir}</span></div>
      <div className="row">
        <span className="k">上次导出</span>
        <span className="v">
          {sync.lastExportAt ? `${when(sync.lastExportAt)} · ${sync.lastExportFiles.length} 个文件` : '还没导出过'}
        </span>
      </div>
      <div className="row">
        <span className="k">上次对表</span>
        <span className="v">
          {imp
            ? `${when(sync.lastImportAt)} · 读到 ${imp.files} 个文件 · 导入 ${imp.aggRows} 条聚合 / ${imp.sessionRows} 条会话`
            : '还没对过表'}
        </span>
      </div>
      <div className="row">
        <span className="k">错误</span>
        <span className={'v' + (imp && imp.errors.length ? ' warn' : ' ok')}>
          {imp && imp.errors.length ? imp.errors.join('；') : '无'}
        </span>
      </div>

      {devices.map(d => (
        <div className="devrow" key={d.id} style={d.ignored ? { opacity: 0.55 } : undefined}>
          <span className="nm">
            {renaming === d.id ? (
              <input
                className="renameinput"
                value={draft}
                autoFocus
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && draft.trim()) {
                    void run('rename', async () => {
                      await api.renameLocal(draft.trim());
                      setRenaming(null);
                    });
                  }
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <>
                {d.name}
                {d.local ? '（本机）' : ''}
                {d.ignored ? ' · 已忽略' : ''}
              </>
            )}
          </span>
          <span className="id">{d.id.slice(0, 8)}</span>
          <span className="v">{when(d.last_seen)}</span>
          {d.local && renaming !== d.id && (
            <button
              className="act"
              onClick={() => { setRenaming(d.id); setDraft(d.name); }}
            >
              改名
            </button>
          )}
          {!d.local && !d.ignored && (
            <button
              className="act"
              disabled={busy === d.id}
              onClick={() => void run(d.id, () => api.ignoreDevice(d.id))}
            >
              忽略
            </button>
          )}
          {!d.local && !!d.ignored && (
            <button
              className="act"
              disabled={busy === d.id}
              onClick={() => void run(d.id, () => api.restoreDevice(d.id))}
            >
              恢复
            </button>
          )}
        </div>
      ))}

      {error && <div className="row"><span className="k">操作失败</span><span className="v warn">{error}</span></div>}

      <div className="note" style={{ marginTop: 8 }}>
        「忽略」会删掉本机库里这台设备的行，之后不再导入；对方机器和它在同步目录里的文件都不动，
        想恢复点「恢复」等下一轮对表。改名只对本机有意义——别的设备的名字由它自己决定。
      </div>
    </div>
  );
}
