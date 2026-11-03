// 采集器共用的解析工具。
//
// 这些小函数解决的是同一类问题：日志是第三方写出来的，字段可能缺、类型不对、
// 时间解析不出来。处理原则是「宁可跳过一条，不要写错一条」——写错的数据比缺的数据
// 难发现得多，缺了会少一行，写错了会一直错到有人去查。

/**
 * 解析一行 JSON。返回对象，或者 null（这一行不能用）。
 *
 * 光 JSON.parse 不够：文件里有一行字面量 `null` 时，parse 成功但结果是 null，
 * 后面直接读 `rec.type` 会抛异常。这个异常会一路冒到扫描编排，
 * 让整个来源本轮的其它文件都不再采集。
 */
export function parseRecord(line: string): Record<string, any> | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, any>;
}

/**
 * 解析时间戳。解析不出来返回 null，让调用方跳过这条记录。
 *
 * 不要兜底成 Date.now()：那会把历史用量记到扫描那一天，
 * 页面上看不出异常，只是今天的数字突然多了一截。
 */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}
