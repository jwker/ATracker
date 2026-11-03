// 版本行：显示「0.1.1 · 3f2a1c9 · 11-02 12:30 构建」。
// 两台机器装的包不一样的时候，对比这一行最快。

import type { BuildInfo } from '../types.ts';

export function BuildStamp({ build }: { build: BuildInfo | null }) {
  if (!build) return null;
  // 指定时区。这一行的用途是「两台机器装的包不一样时对比」，
  // 不指定的话两台机器时区不同，同一次构建会显示成不同的墙钟时间。
  const builtAt = build.builtAt
    ? new Date(build.builtAt).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
      })
    : '—';
  return (
    <div className="buildstamp">
      <span>ATracker {build.version}</span>
      <span>提交 {build.commit}{build.dirty ? '（有未提交改动）' : ''}</span>
      <span>{builtAt} 构建</span>
      {build.branch && <span>{build.branch}</span>}
    </div>
  );
}
