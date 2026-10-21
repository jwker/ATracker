// 目录 → 颜色。颜色跟随实体：同一个目录在任何页面、任何月份都是同一个颜色。
// 分配结果存在数据库里（dir_color 表），目录之间不会撞色。

/** 色板。在米白纸面和深色底上都能看清的一组低饱和色。 */
export const DIR_PALETTE = [
  '#c9503f', '#d08040', '#c9a13f', '#a8a83f', '#8a9e3f', '#6f9f46',
  '#4f9e5c', '#3f9e6b', '#3aa087', '#3d93b8', '#4a7fc9', '#5b6ed0',
  '#6a63cc', '#7a63c9', '#8a5fc4', '#9a5fc0', '#a95fba', '#b85fae',
  '#c05c9e', '#c9538a', '#c9536f', '#b4644a', '#a06a4a', '#8d6a52',
  '#7d7060', '#6e8296', '#7a8a9e', '#5f7a92', '#4a5a8a', '#3f5a8a'
];

/** 路径的稳定哈希。用 FNV-1a，分布比简单求和均匀。 */
export function hashPath(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 给一批目录分配互不重复的颜色。
 * 已经有颜色的保持不变（颜色跟随实体），新的从哈希起点往后找空位。
 * @param existing 已有的映射
 * @param paths 本次出现的目录
 * @returns 需要写入的映射
 */
export function assignColors(
  existing: Map<string, string>,
  paths: string[]
): Map<string, string> {
  const result = new Map(existing);
  const used = new Set(existing.values());
  const pending = [...new Set(paths)].sort();

  for (const p of pending) {
    if (result.has(p)) continue;
    const start = hashPath(p) % DIR_PALETTE.length;
    let pick = DIR_PALETTE[start];
    for (let i = 0; i < DIR_PALETTE.length; i++) {
      const c = DIR_PALETTE[(start + i) % DIR_PALETTE.length];
      if (!used.has(c)) { pick = c; break; }
    }
    used.add(pick);
    result.set(p, pick);
  }
  return result;
}

/** 兜底：没进表的目录临时算一个色。 */
export function dirColor(path: string): string {
  return DIR_PALETTE[hashPath(path) % DIR_PALETTE.length];
}
