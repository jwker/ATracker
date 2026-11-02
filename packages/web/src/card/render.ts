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
  ctx.textAlign = 'left';
  ctx.fillStyle = C.ink;
  ctx.fillText(left, x, y);
  const lw = ctx.measureText(left).width;
  ctx.textAlign = 'right';
  ctx.fillStyle = C.muted;
  ctx.fillText(right, x + w, y);
  const rw = ctx.measureText(right).width;
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
  const h = {
    padTop: 60, brand: 104, meta: 60, gapA: 26,
    lab: 34, value: 132, sub: 34, hit: 60, gapB: 30,
    chartHead: 40, chart: 216, axis: 30, note: 30, gapC: 26,
    modelsHead: 40, row: 34 * rows, gapD: 26,
    footerLine: 24, footer: 40, padBottom: 56
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
  ctx.fillText('ATRACKER', CARD_W / 2, y + 46);
  ctx.letterSpacing = '0px';
  ctx.font = font(21);
  ctx.fillStyle = C.muted;
  ctx.fillText('TOKEN RECEIPT', CARD_W / 2, y + 82);
  y += h.brand;
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(x, y - 16);
  ctx.lineTo(x + CONTENT_W, y - 16);
  ctx.stroke();

  // 日期行
  ctx.textAlign = 'left';
  ctx.font = font(24);
  ctx.fillStyle = C.muted;
  ctx.fillText(data.metaLeft, x, y + 24);
  ctx.textAlign = 'right';
  ctx.fillText(data.metaRight, x + CONTENT_W, y + 24);
  y += h.meta;
  ctx.strokeStyle = C.rule;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(x, y - 8);
  ctx.lineTo(x + CONTENT_W, y - 8);
  ctx.stroke();
  ctx.setLineDash([]);

  // 大数字
  y += h.gapA;
  ctx.textAlign = 'left';
  ctx.font = font(24);
  ctx.fillStyle = C.muted;
  ctx.letterSpacing = '4px';
  ctx.fillText(data.bigLabel, x, y + 24);
  ctx.letterSpacing = '0px';
  y += h.lab;
  ctx.font = font(126, 700);
  ctx.fillStyle = C.ink;
  ctx.fillText(data.bigValue, x, y + 100);
  const vw = ctx.measureText(data.bigValue).width;
  ctx.font = font(63, 700);
  ctx.fillText(data.bigUnit, x + vw + 8, y + 100);
  y += h.value;

  // 调用次数 + 四桶：一行，字号按可用宽度收缩
  let subSize = 22.5;
  ctx.font = font(subSize);
  while (ctx.measureText(data.buckets).width > CONTENT_W && subSize > 14) {
    subSize -= 0.5;
    ctx.font = font(subSize);
  }
  ctx.fillStyle = C.muted;
  ctx.fillText(data.buckets, x, y + 26);
  y += h.sub;

  // 命中率
  ctx.font = font(63);
  ctx.fillStyle = C.accent;
  ctx.fillText(data.hitRate, x, y + 46);
  const hw = ctx.measureText(data.hitRate).width;
  ctx.font = font(24);
  ctx.fillStyle = C.muted;
  ctx.fillText('输入来自缓存', x + hw + 14, y + 44);
  y += h.hit;

  // 图表标题 + 分隔线
  y += h.gapB;
  ctx.font = font(24);
  ctx.fillStyle = C.ink;
  ctx.letterSpacing = '4px';
  ctx.fillText(data.chartTitle, x, y + 26);
  ctx.letterSpacing = '0px';
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, y + 34);
  ctx.lineTo(x + CONTENT_W, y + 34);
  ctx.stroke();
  y += h.chartHead + 10;

  // 柱子
  const n = Math.max(1, data.bars.length);
  const gap = n > 24 ? 6 : 9;
  const bw = (CONTENT_W - gap * (n - 1)) / n;
  const baseY = y + 216;
  for (let i = 0; i < n; i++) {
    const b = data.bars[i]!;
    const bx = x + i * (bw + gap);
    if (b.empty) {
      ctx.fillStyle = C.wash;
      ctx.fillRect(bx, baseY - 6, bw, 6);
    } else {
      const bh = Math.max(8, b.v * 216);
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
    ctx.fillText(lb, x + t * CONTENT_W, y + 30);
  });
  ctx.textAlign = 'left';
  y += h.axis + 4;

  // 图注
  ctx.font = font(22);
  ctx.fillStyle = C.muted;
  ctx.fillText(data.chartNoteLeft, x, y + 22);
  ctx.textAlign = 'right';
  ctx.fillText(data.chartNoteRight, x + CONTENT_W, y + 22);
  ctx.textAlign = 'left';
  y += h.note;

  // TOP 模型
  y += h.gapC;
  ctx.font = font(24);
  ctx.fillStyle = C.ink;
  ctx.letterSpacing = '4px';
  ctx.fillText('TOP 模型', x, y + 26);
  ctx.letterSpacing = '0px';
  ctx.textAlign = 'right';
  ctx.fillStyle = C.muted;
  ctx.fillText(data.chartTitle.indexOf('小时') >= 0 ? '占今天' : '占区间', x + CONTENT_W, y + 26);
  ctx.textAlign = 'left';
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, y + 34);
  ctx.lineTo(x + CONTENT_W, y + 34);
  ctx.stroke();
  y += h.modelsHead;
  for (const m of data.models) {
    leader(ctx, m.label, m.pct.toFixed(1) + '%', x, y + 26, CONTENT_W, 27);
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
