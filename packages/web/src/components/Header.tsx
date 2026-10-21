import type { Theme, Unit, View } from '../state.ts';
import { dayOf, fmtTime, UNITS } from '../format.ts';

const VIEWS: { id: View; label: string }[] = [
  { id: 'home', label: '总账' },
  { id: 'conv', label: '会话' },
  { id: 'log', label: '日志' }
];

interface HeaderProps {
  view: View;
  theme: Theme;
  unit: Unit;
  onNav: (view: View) => void;
  onUnit: (unit: Unit) => void;
  onToggleTheme: () => void;
}

export function Header(props: HeaderProps) {
  const now = Date.now();
  return (
    <>
      <div className="rhead">
        <div className="name">ATRACKER</div>
        <div className="sub">LOCAL TOKEN RECEIPT</div>
        <div className="barcode" />
      </div>
      <div className="rno">
        <span>NO. {dayOf(now).replace(/-/g, '')}</span>
        <span>{fmtTime(now)}</span>
        <span>TERMINAL 01</span>
      </div>
      <div className="navrow">
        {VIEWS.map(v => (
          <button
            key={v.id}
            data-nav={v.id}
            className="tab"
            onClick={() => props.onNav(v.id)}
            aria-current={props.view === v.id}
          >
            {v.label}
          </button>
        ))}
        <span className="sp" />
        <div className="unit">
          {UNITS.map(u => (
            <button
              key={u.id}
              data-unit={u.id}
              onClick={() => props.onUnit(u.id)}
              aria-pressed={props.unit === u.id}
            >
              {u.label}
            </button>
          ))}
        </div>
        <button className="ghost" onClick={props.onToggleTheme}>
          {props.theme === 'light' ? '夜间小票' : '日间小票'}
        </button>
      </div>
      <div className="tear">TEAR ALONG DOTTED LINE</div>
    </>
  );
}
