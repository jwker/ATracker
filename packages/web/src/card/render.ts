// 分享卡片的绘制。
//
// 直接画在 canvas 上，不用 html-to-image 之类的库：卡片就是文字、几条线和
// 一排柱子，手写坐标比引依赖更可控，而且网页版和桌面版（capturePage 走同一条
// 路）都能用。
//
// 坐标系按真卡尺寸设计：宽 1080，高 1920，纸宽 918。调用方按需缩放画布。

export interface CardModelRow {
  label: string;
  /** 百分比，0–100 */
  pct: number;
}

export interface CardBar {
  /** 高度比例 0–1 */
  v: number;
  /** true 表示这一根是高峰，画成强调色 */
  hot?: boolean;
  /** true 表示这个时段没有数据，画浅灰底线 */
  empty?: boolean;
}

export interface CardData {
  /** 卡片标题里的行，例如「2026-10-04 → 11-02」 */
  metaLeft: string;
  /** 右上角，例如「近 30 天」「截至 12:48」 */
  metaRight: string;
  /** 大数字的标签，例如「TOKEN 总量」「今日 TOKEN」 */
  bigLabel: string;
  /** 大数字本身，已经格式化好，例如「32.59」 */
  bigValue: string;
  /** 单位，例如「亿」 */
  bigUnit: string;
  /** 四桶那一行；调用次数只有本机有时才放进来越 */
  buckets: string;
  hitRate: string;
  chartTitle: string;
  bars: CardBar[];
  axisLabels: string[];
  chartNoteLeft: string;
  chartNoteRight: string;
  models: CardModelRow[];
  /** TOP 模型右侧的说明，例如「占区间」「占今天」 */
  modelsTitle: string;
  version: string;
}

const C = {
  desk: '#cfd0cb',
  paper: '#f6f5f0',
  ink: '#17181a',
  muted: '#6c6e69',
  faint: '#a9aba5',
  rule: '#c9cbc4',
  accent: '#bf3b22',
  wash: '#e8e8e2',
  bar: '#7d8079'
};

export const CARD_W = 1080;
export const CARD_H = 1920;

const PAPER_W = 918;
const PAD = 72;
const CONTENT_W = PAPER_W - PAD * 2;

const FONT = '"Courier New", "SF Mono", Menlo, monospace';
const font = (size: number, weight = 400) => `${weight} ${size}px ${FONT}`;

function tok(n: number): string {
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return Math.round(n).toLocaleString('en-US');
}
export { tok as cardTok };

/** 撕纸边：一排小三角。 */
function drawTornEdge(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, teeth: number, up: boolean): void {
  const step = w / teeth;
  ctx.fillStyle = C.paper;
  for (let i = 0; i < teeth; i++) {
    const x0 = x + i * step;
    ctx.beginPath();
    // up：上边缘，三角尖朝上（画在纸外）；否则是下边缘，尖朝下
    if (up) {
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + step / 2, y - step / 2);
      ctx.lineTo(x0 + step, y);
    } else {
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + step / 2, y + step / 2);
      ctx.lineTo(x0 + step, y);
    }
    ctx.closePath();
    ctx.fill();
  }
}

/** 点线引导：左侧文字、右侧数值，中间一串点。 */
function leader(ctx: CanvasRenderingContext2D, left: string, right: string, x: number, y: number, w: number, size: number): void {
  ctx.font = font(size);

  // 右侧数值先量宽度：左侧文字要给它留出位置。
  ctx.textAlign = 'right';
  const rw = ctx.measureText(right).width;

  // 左侧文字太长就截断。不截的话模型名会直接压到百分比上，甚至伸出纸面。
  ctx.textAlign = 'left';
  const room = w - rw - 24;
  let text = left;
  if (ctx.measureText(text).width > room) {
    while (text.length > 1 && ctx.measureText(text + '…').width > room) text = text.slice(0, -1);
    text += '…';
  }
  ctx.fillStyle = C.ink;
  ctx.fillText(text, x, y);
  const lw = ctx.measureText(text).width;

  ctx.textAlign = 'right';
  ctx.fillStyle = C.muted;
  ctx.fillText(right, x + w, y);
  const from = x + lw + 12;
  const to = x + w - rw - 12;
  if (to <= from) return;
  ctx.strokeStyle = C.faint;
  ctx.lineWidth = 2;
  ctx.setLineDash([3, 6]);
  ctx.beginPath();
  ctx.moveTo(from, y - size * 0.22);
  ctx.lineTo(to, y - size * 0.22);
  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * 画一张卡片。返回纸的高度，方便调用方（比如调试）核对。
 * scale 用于按比例缩小画到预览 canvas 上。
 */
export function drawCard(canvas: HTMLCanvasElement, data: CardData, scale = 1): number {
  const W = CARD_W * scale;
  const H = CARD_H * scale;
  canvas.width = Math.round(W);
  canvas.height = Math.round(H);
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;
  ctx.scale(scale, scale);
  ctx.textBaseline = 'alphabetic';

  // 桌面底色
  ctx.fillStyle = C.desk;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // 先算纸高，再决定纸的纵向位置（竖直居中）
  const rows = data.models.length;
  // 各段的纵向占位。整体留白偏松：板块之间空 40–50px，
  // 上面紧贴会让卡片看起来像表格。
  const h = {
    padTop: 84, brand: 116, meta: 70, gapA: 48,
    lab: 42, value: 142, sub: 46, hit: 80, gapB: 50,
    chartHead: 50, chart: 244, axis: 40, note: 44, gapC: 46,
    modelsHead: 50, row: 46 * rows, gapD: 46,
    footerLine: 30, footer: 54, padBottom: 76
  };
  const paperH = Object.values(h).reduce((a, b) => a + b, 0);
  const paperX = (CARD_W - PAPER_W) / 2;
  const paperY = Math.max(40, (CARD_H - paperH) / 2);

  // 纸 + 撕纸边
  ctx.fillStyle = C.paper;
  ctx.fillRect(paperX, paperY, PAPER_W, paperH);
  drawTornEdge(ctx, paperX, paperY, PAPER_W, 14, true);
  drawTornEdge(ctx, paperX, paperY + paperH, PAPER_W, 14, false);

  let y = paperY + h.padTop;
  const x = paperX + PAD;

  // 品牌
  ctx.textAlign = 'center';
  ctx.fillStyle = C.ink;
  ctx.font = font(54, 700);
  ctx.letterSpacing = '16px';
  ctx.fillText('ATRACKER', CARD_W / 2, y + 52);
  ctx.letterSpacing = '0px';
  ctx.font = font(21);
  ctx.fillStyle = C.muted;
  ctx.fillText('TOKEN RECEIPT', CARD_W / 2, y + 86);
  y += h.brand;
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(x, y - 6);
  ctx.lineTo(x + CONTENT_W, y - 6);
  ctx.stroke();

  // 日期行
  ctx.textAlign = 'left';
  ctx.font = font(24);
  ctx.fillStyle = C.muted;
  ctx.fillText(data.metaLeft, x, y + 28);
  ctx.textAlign = 'right';
  ctx.fillText(data.metaRight, x + CONTENT_W, y + 28);
  y += h.meta;
  ctx.strokeStyle = C.rule;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(x, y - 12);
  ctx.lineTo(x + CONTENT_W, y - 12);
  ctx.stroke();
  ctx.setLineDash([]);

  // 大数字
  y += h.gapA;
  ctx.textAlign = 'left';
  ctx.font = font(24);
  ctx.fillStyle = C.muted;
  ctx.letterSpacing = '4px';
  ctx.fillText(data.bigLabel, x, y + 28);
  ctx.letterSpacing = '0px';
  y += h.lab;
  ctx.font = font(126, 700);
  ctx.fillStyle = C.ink;
  ctx.fillText(data.bigValue, x, y + 106);
  const vw = ctx.measureText(data.bigValue).width;
  ctx.font = font(63, 700);
  ctx.fillText(data.bigUnit, x + vw + 8, y + 106);
  y += h.value;

  // 调用次数 + 四桶：一行，字号按可用宽度收缩
  let subSize = 22.5;
  ctx.font = font(subSize);
  while (ctx.measureText(data.buckets).width > CONTENT_W && subSize > 14) {
    subSize -= 0.5;
    ctx.font = font(subSize);
  }
  ctx.fillStyle = C.muted;
  ctx.fillText(data.buckets, x, y + 30);
  y += h.sub;

  // 命中率
  ctx.font = font(63);
  ctx.fillStyle = C.accent;
  ctx.fillText(data.hitRate, x, y + 52);
  const hw = ctx.measureText(data.hitRate).width;
  ctx.font = font(24);
  ctx.fillStyle = C.muted;
  ctx.fillText('输入来自缓存', x + hw + 14, y + 50);
  y += h.hit;

  // 图表标题 + 分隔线
  y += h.gapB;
  ctx.font = font(24);
  ctx.fillStyle = C.ink;
  ctx.letterSpacing = '4px';
  ctx.fillText(data.chartTitle, x, y + 30);
  ctx.letterSpacing = '0px';
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, y + 40);
  ctx.lineTo(x + CONTENT_W, y + 40);
  ctx.stroke();
  y += h.chartHead + 12;

  // 柱子
  const bars = data.bars ?? [];
  const n = bars.length;
  // 柱子越多间隔越小，而且要保证每根至少 2px，否则会算出负宽度。
  // 柱子特别多时（区间跨年，按天能到几百根），还得保证总宽度不超出内容区，
  // 否则柱子会画出纸面。
  const gap = n > 60 ? 0 : n > 30 ? 2 : n > 12 ? 4 : 9;
  const bw = n === 0 ? 0 : Math.min(CONTENT_W / n, Math.max(2, (CONTENT_W - gap * (n - 1)) / n));
  const baseY = y + h.chart;
  for (let i = 0; i < n; i++) {
    const b = bars[i]!;
    const bx = x + i * (bw + gap);
    if (b.empty) {
      ctx.fillStyle = C.wash;
      ctx.fillRect(bx, baseY - 6, bw, 6);
    } else {
      // 比例夹在 0 到 1。接口那边可能传出 NaN 或大于 1 的值，
      // 直接算会让柱子超出图表区，或者画不出来。
      const v = Number.isFinite(b.v) ? Math.min(1, Math.max(0, b.v)) : 0;
      const bh = Math.max(8, v * h.chart);
      ctx.fillStyle = b.hot ? C.accent : C.bar;
      ctx.fillRect(bx, baseY - bh, bw, bh);
    }
  }
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, baseY);
  ctx.lineTo(x + CONTENT_W, baseY);
  ctx.stroke();
  y = baseY;

  // 横轴刻度
  ctx.font = font(20);
  ctx.fillStyle = C.faint;
  const labels = data.axisLabels;
  labels.forEach((lb, i) => {
    const t = labels.length === 1 ? 0 : i / (labels.length - 1);
    ctx.textAlign = i === 0 ? 'left' : i === labels.length - 1 ? 'right' : 'center';
    ctx.fillText(lb, x + t * CONTENT_W, y + 34);
  });
  ctx.textAlign = 'left';
  y += h.axis + 4;

  // 图注
  ctx.font = font(22);
  ctx.fillStyle = C.muted;
  ctx.fillText(data.chartNoteLeft, x, y + 26);
  ctx.textAlign = 'right';
  ctx.fillText(data.chartNoteRight, x + CONTENT_W, y + 26);
  ctx.textAlign = 'left';
  y += h.note;

  // TOP 模型
  y += h.gapC;
  ctx.font = font(24);
  ctx.fillStyle = C.ink;
  ctx.letterSpacing = '4px';
  ctx.fillText('TOP 模型', x, y + 30);
  ctx.letterSpacing = '0px';
  ctx.textAlign = 'right';
  ctx.fillStyle = C.muted;
  ctx.fillText(data.modelsTitle, x + CONTENT_W, y + 30);
  ctx.textAlign = 'left';
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, y + 40);
  ctx.lineTo(x + CONTENT_W, y + 40);
  ctx.stroke();
  y += h.modelsHead;
  for (const m of data.models) {
    const pct = (Number.isFinite(m.pct) ? Math.min(100, Math.max(0, m.pct)) : 0).toFixed(1) + '%';
    leader(ctx, m.label, pct, x, y + 32, CONTENT_W, 27);
    y += h.row / Math.max(1, rows);
  }
  y += h.gapD;

  // 页脚
  ctx.strokeStyle = C.rule;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + CONTENT_W, y);
  ctx.stroke();
  ctx.setLineDash([]);
  y += h.footerLine;
  ctx.font = font(20);
  ctx.fillStyle = C.faint;
  ctx.textAlign = 'center';
  ctx.letterSpacing = '6px';
  ctx.fillText(`ATRACKER ${data.version}`, CARD_W / 2, y + 24);
  ctx.letterSpacing = '0px';
  ctx.textAlign = 'left';

  return paperH;
}
