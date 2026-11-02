// 分享卡片弹窗。只显示一个卡片——哪个入口点进来的就出哪张：
//   总账 → 全期卡（按月）　月度 → 范围卡（按天）　今日 → 今天卡（按小时）

import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { drawCard, type CardData } from '../card/render.ts';
import { buildRangeCard, buildTodayCard, monthsBetween } from '../card/data.ts';

export interface ShareTarget {
  kind: 'all' | 'month' | 'today';
  from: string;
  to: string;
  date: string;
  /** 'all' 表示全部设备，null 表示本机 */
  device: string | null;
  version: string;
}

const TITLES: Record<ShareTarget['kind'], string> = {
  all: '全期卡',
  month: '范围卡',
  today: '今天卡'
};

export function ShareCardDialog({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [data, setData] = useState<CardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    const load = target.kind === 'today'
      ? api.day(target.date, target.device).then(d => buildTodayCard(d, target.version))
      : Promise.all([
          api.aggregate(target.from, target.to, target.device),
          ...monthsBetween(target.from, target.to).map(m => api.calendar(m, target.device))
        ]).then(([agg, ...cals]) => buildRangeCard({
          kind: target.kind === 'all' ? 'all' : 'month',
          from: target.from,
          to: target.to,
          agg,
          calendars: cals,
          version: target.version
        }));

    load
      .then(card => { if (alive) setData(card); })
      .catch(err => { if (alive) setError((err as Error).message); });
    return () => { alive = false; };
  }, [target]);

  useEffect(() => {
    if (data && canvasRef.current) drawCard(canvasRef.current, data, 1);
  }, [data]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function save(): void {
    const c = canvasRef.current;
    if (!c) return;
    setSaving(true);
    c.toBlob(blob => {
      setSaving(false);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const name = target.kind === 'today' ? `atracker-${target.date}.png` : `atracker-${target.from}-${target.to}.png`;
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }

  return (
    <div className="sharemask" onClick={onClose} role="presentation">
      <div className="sharemodal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={TITLES[target.kind]}>
        <div className="sharehead">
          <span>{TITLES[target.kind]}</span>
          <span className="muted">1080 × 1920</span>
          <span className="sp" />
          <button className="ghost" onClick={save} disabled={!data}>
            {saving ? '导出中…' : '保存图片'}
          </button>
          <button className="ghost" onClick={onClose}>关闭</button>
        </div>
        {error ? (
          <div className="placeholder">生成失败：{error}</div>
        ) : data ? (
          <canvas ref={canvasRef} className="sharecanvas" />
        ) : (
          <div className="placeholder">正在生成…</div>
        )}
      </div>
    </div>
  );
}
