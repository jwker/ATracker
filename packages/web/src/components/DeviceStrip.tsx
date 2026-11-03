// 多设备切换。只在设备超过一台时出现，且只对总账和月度生效——
// 今日、会话、日志在 P3 还不按设备过滤，所以不显示，免得误导。

import type { DevicesPayload } from '../types.ts';

interface DeviceStripProps {
  devices: DevicesPayload;
  /** 当前选中的设备 id，null 表示全部 */
  active: string | null;
  onSelect: (deviceId: string | null) => void;
}

export function DeviceStrip({ devices, active, onSelect }: DeviceStripProps) {
  // 被忽略的设备不出现在切换条里，否则「忽略」等于没效果
  const visible = devices.devices.filter(d => !d.ignored);
  if (visible.length < 2) return null;

  return (
    <div className="devstrip">
      <button type="button"
        className={'chip' + (active === null ? ' on' : '')}
        onClick={() => onSelect(null)}
        aria-pressed={active === null}
      >
        全部设备
      </button>
      {visible.map(d => (
        <button type="button"
          key={d.id}
          className={'chip' + (active === d.id ? ' on' : '')}
          onClick={() => onSelect(d.id)}
          aria-pressed={active === d.id}
          title={`${d.id}${d.last_seen ? ' · 最后写入 ' + new Date(d.last_seen).toLocaleString('zh-CN') : ''}`}
        >
          {d.name}
          {d.id === devices.local.id ? '（本机）' : ''}
        </button>
      ))}
    </div>
  );
}
