// 目录 → 颜色。颜色跟随实体，不跟随排名：同一个目录在任何页面、任何月份都是同一个颜色。

const PALETTE = [
  '#4c7fd1', '#4aa38a', '#c08a3e', '#9a6fc4', '#c76a6a', '#5f8fa8',
  '#7a9e4f', '#b5679a', '#4f9eb5', '#a3924f', '#8f6f5c', '#6a7fb5'
];

/** 路径的稳定哈希。 */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function dirColor(path: string): string {
  return PALETTE[hash(path) % PALETTE.length];
}

export const DIR_PALETTE = PALETTE;
