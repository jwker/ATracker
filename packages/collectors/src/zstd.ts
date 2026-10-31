// zstd 多帧读取。
//
// dsh 把每条记录写成一个独立的 zstd 帧，一个 9.7MB 的会话文件里有 27347 帧。
// Node 26 的 zlib.zstdDecompressSync 只解第一帧，所以必须自己逐帧走。
//
// 找下一帧不能扫「魔数」：压缩数据里也会出现 28 B5 2F FD 这四个字节，扫到假
// 帧头会把后面的数据当新帧解，Node 24（Electron 内置）在这种情况下会一次解完
// 剩余所有帧，循环里就变成 O(n²)——实测会卡在 100% CPU 上几十分钟。
// 正确做法是解析帧头，按 block 头算出这一帧的结尾，每次只解一帧。

import { zstdDecompressSync } from 'node:zlib';

const MAGIC = 0xfd2fb528;

/** 单帧解压输出的上限，超过就中止这个文件。 */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/**
 * 从帧头开始走完所有 block，返回这一帧的结束偏移（不含）。
 * 帧格式见 RFC 8878：帧头描述符 → [窗口描述符] → [字典 id] → [内容长度] → block* → [校验和]。
 */
function frameEnd(buf: Buffer, start: number): number {
  let p = start + 4;
  const descriptor = buf[p];
  p += 1;
  if (descriptor === undefined) throw new Error('帧头不完整');

  const fcsFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const hasChecksum = (descriptor >> 2) & 1;

  if (!singleSegment) p += 1; // 窗口描述符
  p += [0, 1, 2, 4][descriptor & 3]; // 字典 id
  if (fcsFlag === 0) {
    if (singleSegment) p += 1;
  } else {
    p += [0, 2, 4, 8][fcsFlag]; // 帧内容长度
  }

  for (;;) {
    if (p + 3 > buf.length) throw new Error('block 头不完整');
    const header = buf.readUIntLE(p, 3);
    p += 3;
    const last = header & 1;
    const type = (header >> 1) & 3;
    const size = header >> 3;
    // RLE block 只带 1 字节，其余两种（raw / compressed）带 size 字节
    p += type === 1 ? 1 : size;
    if (last) break;
  }

  if (hasChecksum) p += 4;
  return p;
}

/**
 * 逐帧解压。返回每一帧的内容。
 * 遇到损坏或被截断的帧就停，剩下的部分留给下次扫描。
 */
export function* zstdFrames(buf: Buffer): Generator<Buffer> {
  let off = 0;
  while (off + 4 <= buf.length) {
    if (buf.readUInt32LE(off) !== MAGIC) return;

    let end: number;
    try {
      end = frameEnd(buf, off);
    } catch {
      return; // 帧头或 block 头不完整，说明文件被截断
    }
    if (end > buf.length) return;

    let piece: Buffer;
    try {
      piece = zstdDecompressSync(buf.subarray(off, end));
    } catch {
      return; // 帧坏了（文件被截断），停在这里
    }
    if (piece.length > MAX_FRAME_BYTES) {
      throw new Error(`单帧解压输出 ${piece.length} 字节，超过上限 ${MAX_FRAME_BYTES}`);
    }

    yield piece;
    off = end;
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
