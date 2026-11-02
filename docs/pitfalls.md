# 容易踩的坑

五个来源的日志格式都不规范，下面几条是踩过并验证过的，改采集器之前先看一遍。

## codex 的每轮用量要用增量，不能用 `last_token_usage`

一轮里可能有多次 API 调用，`last_token_usage` 只记最后一次。要用 `total_token_usage` 的增量。实测一个 61 轮的会话，两种算法相差 4 万 token。

## codex 的 `input_tokens` 含缓存命中部分

要减掉 `cached_input_tokens` 才是「未命中输入」。别的来源（Claude Code、pi、opencode、DeepSeek Harness）报的都是不含缓存的口径，直接照抄 codex 的字段会让输入量虚高。

## Claude Code 的同一条消息会写成多行

一条 assistant 消息按内容块分行写，每行带同一份 usage。要按 `message.id` 去重，否则用量翻倍。

## DeepSeek Harness 一个会话目录里有多个版本文件

只读编号最高的那个。全加起来会重复计算。

## opencode 有两代存储格式

同一个库里旧表 `session`/`message` 和新表 `session_v2`/`session_message` 存着同一批会话，两张都读会翻倍。会话被压缩之后旧消息不在消息表里了，只在会话汇总列里，差出来的量要按四个桶补一条事件。

## zstd 要自己遍历帧

Node 的 `zlib.zstdDecompressSync` 只解第一帧，而 codex 的文件是多帧拼接的。自己写遍历器时要解析帧头（magic + frame header descriptor + 可选字段 + block headers），不能只扫 `28 B5 2F FD` 这个魔法数：每一帧的数据里都可能出现同样的字节序列，扫描法在 Node 24 上是 O(n²)——每次 `zstdDecompressSync` 都会把剩余所有帧解一遍。

截断的文件不会死循环，但遍历器必须保证每一步都真的前进了。实测把文件截到 60%，逐帧走到第 16727 帧解不动并放弃，74ms，没有死循环；实现时每一轮都要校验偏移确实增加，否则遇到畸形帧会转圈。

实现见 `packages/collectors/src/zstd.ts`。

## 时区

库里存 UTC 时间戳，按 `core/time.ts` 里写死的时区折算成自然日，不读系统时区。多设备同步时两台机器必须用同一套分桶边界，否则同一天的用量会分到两天去。

按日期做补零时也要小心：`Date.parse('2026-10-01T00:00:00+08:00')` 拿到的是 UTC 时刻，再 `toISOString()` 取日期会**退回前一天**。要么用 `Date.UTC` 构造，要么直接做字符串运算。

## 大文件与增量

文件识别用指纹（大小 + mtime + 首尾片段），不读全文。已知的失败模式是「文件大小和 mtime 都没变但内容变了」，实际不会发生。不完整文件（还在写入）会记下偏移，下次从偏移处继续。

扫描是增量的，第二次只花几十毫秒。如果发现某次扫描明显变慢，先看是不是游标版本对不上触发了全量重扫。
