// zstd 多帧读取。
// Node 的 zlib.zstdDecompressSync 只解第一帧，多帧拼接的文件会静默丢掉后面的内容，
// 所以这里逐帧走：找到帧头 → 解一帧 → 跳到下一帧。

import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 单帧解压输出的上限，超过就中止这个文件。 */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/**
 * 逐帧解压。返回每一帧的内容。
 * 遇到损坏的帧就停，剩下的部分留给下次扫描。
 */
export function* zstdFrames(buf: Buffer): Generator<Buffer> {
  let off = 0;
  while (off + 4 <= buf.length) {
    if (buf.readUInt32LE(off) !== MAGIC.readUInt32LE(0)) break;
    let piece: Buffer;
    try {
      piece = zstdDecompressSync(buf.subarray(off));
    } catch {
      return; // 帧坏了（文件被截断），停在这里
    }
    if (piece.length > MAX_FRAME_BYTES) {
      throw new Error(`单帧解压输出 ${piece.length} 字节，超过上限 ${MAX_FRAME_BYTES}`);
    }
    yield piece;
    const next = buf.indexOf(MAGIC, off + 4);
    if (next < 0) return;
    if (next <= off) return; // 保底：偏移必须前进，否则会死循环
    off = next;
  }
}

/** 逐帧逐行。 */
export function* zstdLines(buf: Buffer): Generator<string> {
  for (const frame of zstdFrames(buf)) {
    const text = frame.toString('utf8');
    let start = 0;
    while (start < text.length) {
      const nl = text.indexOf('\n', start);
      if (nl < 0) {
        const tail = text.slice(start);
        if (tail.trim()) yield tail;
        break;
      }
      const line = text.slice(start, nl);
      if (line.trim()) yield line;
      start = nl + 1;
    }
  }
}
