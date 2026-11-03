// 原子写。
//
// 直接 writeFileSync 写最终文件有两个问题：进程在写一半被杀会留下半截 JSON，
// 下次读到它就会解析失败。现在改成先写同目录的临时文件再 rename——
// rename 在同一个文件系统里是原子的，读到的一定是完整的旧版本或新版本。

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 把内容写到文件。
 *
 * 先写临时文件再改名。临时文件和目标文件在同一个目录，保证 rename 不跨
 * 文件系统（跨了就不是原子的）。写失败会把临时文件清掉，不留垃圾。
 */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* 临时文件可能没建成 */ }
    throw err;
  }
}
