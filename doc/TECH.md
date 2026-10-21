# ATracker 技术设计

对应 `doc/PRD.md` 的需求，本文只讲怎么实现。

技术选型：TypeScript，Node 24 以上。数据库用 Node 自带的 `node:sqlite`，不引入原生编译依赖。前端 React 19 + Vite + TypeScript，图表用 CSS 和表格实现，不引入图表库。

## 1. 分层

```
采集器（只读各 agent 的文件）
   ↓ 产出标准 UsageEvent
归一化层（单位换算、厂商归属、目录配色）
   ↓
存储层（usage_event 明细 + 物化聚合表）
   ↓
HTTP API（只读 + 一个扫描触发接口）
   ↓
前端（React 19 + Vite）
```

四个硬约束贯穿全文：

1. **只读。** 采集器只打开文件读，绝不写 agent 的目录，也绝不调 agent 的接口。
2. **单一出处。** 单位换算、颜色分配、成本计算、厂商归属，每件事只有一个实现文件，其他地方一律调用它。
3. **明细不可变。** `usage_event` 只追加不修改，修正靠同一个 `event_id` 覆盖写。
4. **加东西不改老代码。** 新增一个 agent 只需要新增一个目录和一条注册记录，不碰已有采集器。

## 2. 数据如何触发获取

### 2.1 三种触发源（已实现）

| 触发源 | 频率 | 用途 |
| --- | --- | --- |
| 文件变更监听 | 事件驱动，去抖 2 秒 | 主路径。agent 写完日志后自动采集 |
| 低频兜底轮询 | 每 5 分钟 | 监听可能丢事件（文件被原子替换、目录被删又建），兜底保证最终一致 |
| 手动触发 | 按需 | `atracker scan` 命令行；前端「刷新」按钮调 `POST /api/scan` |

监听用 `fs.watch(root, { recursive: true })`。下面是本机实测的行为，写实现时按这个来。

**实测结果（macOS，Node 26）**

| 操作 | 触发事件 | 说明 |
| --- | --- | --- |
| 追加一行到已存在文件 | `rename "a.jsonl"` | 追加和修改**不是** change 事件 |
| 写临时文件再 rename 覆盖 | 3 个事件：`rename "tmp.part"`、`rename "a.jsonl"`、`rename "a.jsonl"` | 临时文件也会报一次 |
| 新建文件 | `rename "c.jsonl"` | 与修改事件无法区分 |
| 删除文件 | `rename "c.jsonl"` | 与修改事件无法区分 |
| 一次写入 5 MB | 1 个事件 | FSEvents 会合并 |
| 同一文件 200 ms 内改两次 | 2 个事件 | 不合并到 1 个 |

结论有三条：

1. **macOS 上事件类型全部是 `rename`。** FSEvents 不区分新建、修改、删除、重命名，所以 `eventType` 这个参数在 macOS 上没有信息量，**必须靠 `stat` 判断文件现在的状态**。
2. **事件里的 filename 是相对路径**，而且中间目录会单独报事件（写 `a/b/c/deep.txt` 会收到 `"a"`、`"a/b"`、`"a/b/c"`、`"a/b/c/deep.txt"` 四条）。目录事件要处理成「扫这个目录下的文件」。
3. **事件只是「这些路径可能变了」的提示**，真正决定要不要重新解析的是文件指纹（size / mtime / inode）比对。

**异常情况**

| 情况 | 行为 | 处理 |
| --- | --- | --- |
| 监听的目录不存在 | `fs.watch` 抛 `ENOENT` | 该 agent 没装，记进 doctor 结果，跳过，不影响其他 agent |
| 被监听的目录被删除 | 句柄还在但事件变成目录本身，句柄失效 | 捕获 watch 的 `error` 事件，重建监听；重建时目录可能还不存在，退避重试 |
| 目录删掉又建回来 | 旧句柄收不到新文件的事件 | 靠兜底轮询补上 |

**监听根目录的选择**

| agent | 监听根 | 过滤 |
| --- | --- | --- |
| codex | `~/.codex/sessions` | 全部（`*.jsonl.zst`） |
| Claude Code | `~/.claude/projects` | `*.jsonl` |
| pi | `~/.pi/agent/sessions` | `*.jsonl` |
| opencode | `~/.local/share/opencode` | 只留 `opencode.db` 和它的 `-wal`、`-shm` |
| DSH | `~/.dsh/sessions` | `*.zstd` |

opencode 那个目录实测有 1853 个文件、101 MB，其中 80 MB 是数据库本身，13 MB 是快照，7 MB 是日志。快照和日志的变动与我们无关，**必须按文件名过滤**，否则事件量会被这些文件撑起来。

**实现骨架**

```ts
// packages/core/src/watcher.ts
export interface WatchTarget {
  agent: string;
  root: string;
  match: (relPath: string) => boolean;   // 过滤无关文件
}

class SourceWatcher {
  private watchers = new Map<string, fs.FSWatcher>();
  private pending = new Map<string, Set<string>>();  // agent -> 可能有变化的相对路径
  private timer: NodeJS.Timeout | null = null;

  start(targets: WatchTarget[]) {
    for (const t of targets) this.attach(t);
  }

  private attach(t: WatchTarget) {
    try {
      const w = fs.watch(t.root, { recursive: true }, (_type, filename) => {
        if (!filename) return;
        const rel = filename.toString();
        if (!t.match(rel)) return;                 // 过滤掉无关文件
        const set = this.pending.get(t.agent) ?? new Set<string>();
        set.add(rel);
        this.pending.set(t.agent, set);
        this.schedule();
      });
      w.on('error', () => this.rebuild(t));        // 目录被删或句柄失效
      this.watchers.set(t.agent, w);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;  // 该 agent 没装
      throw err;
    }
  }

  private schedule() {
    if (this.timer) return;                        // 已有定时器，新事件合并进来
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 2000);
  }

  private flush() {
    for (const [agent, paths] of this.pending) {
      this.pending.delete(agent);
      this.onChanged(agent, [...paths]);            // 交给采集层去 stat 和比指纹
    }
  }
}
```

去抖 2 秒，期间的新事件合并成一次扫描。每个 agent 一个独立的监听器，一个坏了不影响其他。

**收到变更路径之后做什么**

```
对每个变更路径：
  stat 它
    不存在    → 文件被删，忽略
    是目录    → 列出目录下的文件，全部进候选集
    是文件    → 进候选集
候选集里的每个文件，和 file_cursor 比指纹：
  没变 → 跳过
  变了 → 重新解析
```

监听只负责「缩小范围」，真正的判断在指纹比对这一步。这样即使事件丢了，只要兜底轮询扫到，指纹也会发现变化。

### 2.2 采集器契约

每个 agent 一个采集器，实现同一个接口。采集器只做一件事：**读原始文件，产出标准事件**。

```ts
// packages/collectors/src/types.ts
export interface UsageEvent {
  eventId: string;          // 稳定唯一键，去重靠它
  agent: string;            // 'codex' | 'claude-code' | 'pi' | 'opencode' | 'dsh'
  sessionId: string;
  parentSessionId: string | null;   // 子 agent 和派生线程填父会话
  isChild: boolean;
  ts: number;               // UTC 毫秒
  cwd: string;
  model: string;            // 原始模型名
  provider: string | null;  // 来源自带最好，null 交给 catalog 推断
  input: number;            // 未缓存输入
  output: number;           // 输出，含推理
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;        // 是 output 的子集
  reportedCostUsd: number | null;   // 来源自带成本，没有就 null
}

export interface Collector {
  id: string;
  label: string;
  /** 产出该采集器负责的用量事件 */
  scan(ctx: ScanContext): AsyncGenerator<UsageEvent>;
  /** 该采集器读哪些路径，用于 doctor 和监听 */
  roots(): string[];
}
```

`ScanContext` 提供文件枚举能力，采集器不自己写目录遍历。

### 2.3 文件指纹与增量（已实现）

每次扫描都读一遍全部文件太慢，所以给每个源文件记一条指纹：

```sql
CREATE TABLE file_cursor (
  path        TEXT PRIMARY KEY,
  source      TEXT NOT NULL,      -- agent id
  size        INTEGER NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  inode       INTEGER NOT NULL,
  offset      INTEGER NOT NULL DEFAULT 0,  -- 已解析到的字节位置
  complete    INTEGER NOT NULL DEFAULT 0,  -- 文件是否已读到结尾
  last_scan_at INTEGER NOT NULL,
  last_error  TEXT
);
```

判定逻辑：

| 文件状态 | 动作 |
| --- | --- |
| 指纹没变 | 跳过 |
| 文件变大了，`offset` 有效 | 从 `offset` 继续读，只解析新增部分 |
| 文件变小或 inode 变了 | 文件被重写或替换，整个文件重读，事件按 `eventId` 覆盖 |
| 新文件 | 全量读 |

`eventId` 要跨扫描稳定，这样重复解析不会产生重复行。各来源用的标识：

| 来源 | 稳定标识 |
| --- | --- |
| codex | 会话 uuid + 行号 `ordinal` |
| Claude Code | 会话 uuid + `message.id`（同一消息按内容块写成多行，要按这个去重） |
| pi | 消息 `id` |
| opencode | 消息行 `id` |
| DeepSeek Harness | 会话 id + 事件 `seq` |

**实测的增量效果。** 首次全量扫描 2873ms，之后每次 55ms（52 倍）。第二次扫描的日志里，DSH 的 43 个会话文件、codex 的 3 个 rollout 全部跳过，那个 9.7 MB 的多帧 zstd 不用再解一遍。

**采集器带版本号。** 改了采集器的解析逻辑就把 `version` 往上加一位，游标里存的是 `agent:version`，版本对不上时这个来源的文件全部重扫。改解析规则不用手动清库。

判定规则：

| 情况 | 动作 |
| --- | --- |
| 指纹（大小、mtime、inode）没变 | 整个文件跳过 |
| 纯文本文件变大了 | 从上次的字节偏移继续读 |
| 文件被重写或 inode 变了 | 整个重读，事件按 `eventId` 覆盖 |
| 压缩文件（zstd） | 没法续读，指纹没变就整个跳过，变了就整个重读（`eventId` 保证幂等） |

### 2.4 不完整文件

agent 正在写日志时，我们读到的最后一行可能是半截的。处理规则：

1. 按字节读，读到最后一个完整的换行就停。
2. 最后那半行不解析，`offset` 停在最后一个完整换行的位置。
3. 下次扫描从 `offset` 继续。

这样正在写的文件不会产生半条记录，也不会重复。

### 2.5 扫描批次

一次扫描是一个批次，记录在 `scan_batch` 表：

```sql
CREATE TABLE scan_batch (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  files_total   INTEGER, files_scanned INTEGER,
  events_read   INTEGER, events_written INTEGER,
  errors        INTEGER,
  trigger       TEXT     -- 'watch' | 'poll' | 'manual'
);
```

**日志行也要落库**，供日志页读取：

```sql
CREATE TABLE scan_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  at       INTEGER NOT NULL,
  level    TEXT NOT NULL,   -- 'ok' | 'info' | 'warn' | 'err'
  source   TEXT NOT NULL,   -- agent id，或 '系统' / '价格'
  message  TEXT NOT NULL
);
CREATE INDEX idx_scan_log_batch ON scan_log(batch_id);
CREATE INDEX idx_scan_log_at ON scan_log(at DESC);
```

保留最近 5000 条，超出删最旧的。日志只保留在库里，不写文件。

**扫描是单实例的。** 用 `data/atracker.lock` 做进程锁，防止 `atracker serve` 和 `atracker scan` 同时写库。拿不到锁的进程直接退出并提示。

**单个文件解析失败不影响整批。** 错误分级：

| 级别 | 处理 |
| --- | --- |
| 文件读不出来 | 记日志，跳过这个文件，其余照常 |
| 单行 JSON 解析失败 | 跳过这行，记一次计数 |
| zstd 解压失败（文件被截断） | 从最后一个完整帧继续，下次再解剩下的 |
| 目录不存在 | 跳过，doctor 里报出来 |

### 2.6 大文件

DSH 的一个会话文件实测 9.7 MB、27347 个 zstd 帧，解开 21.7 MB。codex 的 rollout 也可能很大。解析必须流式：一边读一边解析，不要整个读进内存再 split。

zstd 多帧要用自己写的帧遍历器（Node 的 `zlib.zstdDecompressSync` 只解第一帧），参考 `design` 之外的实现在 `doc/PLAN.md` 第 6.1 节提到的来源。

### 2.7 数据量大时的稳定性

下面每一项都是本机实测出来的数字，实现时按这些约束写。

**事件风暴不会崩，但会把工作推给下游。** 改 3000 个文件收到 3002 个事件，FSEvents 在这个量级不做合并。去抖窗口里累积的是一个路径字符串集合，几千条占用的内存可以忽略，真正的时间花在后续的 stat 和解析上。

**事件回调里不能做重活。** 同步 stat 3000 个文件要 14ms，异步并发 64 是 24ms。14ms 在 60fps 下会掉一帧，所以事件回调里只收集路径，stat 和解析全部放到事件循环外面做。

**整体解压 DSH 的会话文件是错的。** Node 的 `zstdDecompressSync` 只解第一帧，实测 9.3 MB 的会话文件整体解压只拿到 2 行，而正确的逐帧走法能解出 27347 帧、21.3 MB、63358 行。必须逐帧处理。

**逐帧处理的内存会涨，但不是泄漏。** 上面那个 9.3 MB 的文件逐帧走一遍，RSS 峰值 169 MB；再走一遍涨到 184 MB，强制 GC 后 RSS 不回落（V8 保留堆页）但也不继续涨。所以内存占用大约是文件大小的 20 倍量级，需要给单文件解析设上限。

**截断的文件不会死循环，但遍历器必须保证每步都前进。** 把文件截到 60%，逐帧走到第 16727 帧就解不动并放弃，74ms，没有死循环。实现时每一轮必须校验偏移确实前进了，否则遇到畸形帧会转圈。

**解压炸弹要防。** 一段重复数据能压缩到几十字节再解开成一大块，所以单帧的解压输出要有上限（建议 64 MB），超了中止这个文件并记日志。

**SQLite 写入要用分批提交。** 实测 100 万行：

| 提交方式 | 耗时 | WAL 大小 | 全表汇总查询 |
| --- | --- | --- | --- |
| 单事务 | 1541 ms | 64.8 MB | 37 ms |
| 每 2 万行提交 | 1458 ms | 5.4 MB | 37 ms |

速度一样，WAL 小了 12 倍。**每 2 万行提交一次**，WAL 保持在可接受范围。

**必须设的四个闸门**

| 闸门 | 建议值 | 防的是什么 |
| --- | --- | --- |
| 单帧解压输出上限 | 64 MB | 解压炸弹 |
| 单文件解析内存上限 | 512 MB | RSS 飙升 |
| 事务提交批次 | 2 万行 | WAL 膨胀 |
| 扫描单实例 | 进程锁 | 两个进程同时写库 |

**扫描要分片让出事件循环。** 解析完一个文件就 `setImmediate` 让一次，保证扫描期间 HTTP 服务还能响应、还能接收新的 watch 事件。

**扫描不能重叠。** 扫描期间又来了变更事件时，只记一个「脏」标记，等当前批次跑完再跑一次，不要并发扫描。

**SQLite 开 WAL 模式。** 读不阻塞写，前端在扫描过程中查询聚合表不会卡。

**文件描述符不会耗尽。** 递归 watch 在 macOS 上底层是 FSEvents，一个根目录一个句柄，我们总共监听 5 个根，句柄数是常数级。但如果改成「每个子目录单独 watch」，上万个目录就会打满 fd。重建监听时必须先 close 旧句柄，否则泄漏。

## 3. 价格落后于模型

### 3.1 成本有四种来源

`usage_event.cost` 可为空，`cost_source` 枚举：

| 值 | 含义 | 界面表现 |
| --- | --- | --- |
| `reported` | 来源自己报了成本（pi、opencode、DSH） | 直接用 |
| `priced` | 按价格表精确算出 | 直接用 |
| `estimated` | 按兜底规则估算 | 和确定值分开显示 |
| `missing` | 没有可用价格 | 成本留空，显示「—」 |

**任何情况下都不用 0 代替未知。** 0 是一个确切的结论（免费），未知不是。

**人民币定价的模型一律用价格表。** 价格表里带 `currency: CNY` 的条目（比如 MiniMax 全系）不采用来源自报的成本。原因是来源自报的是美元：pi 的模型目录按 6.694 的汇率从官方人民币价折出来，再乘 6.5 会和表里的口径差 3% 左右，两套汇率混在一个报表里对不上账。价格表用美元定价的模型仍然优先用来源自报的值，因为它和表里的价格同单位。

### 3.1.1 多币种

价格表每条可以带 `currency` 字段，不写默认 `USD`，中国厂商填 `CNY`。

引擎内部统一折算成人民币再汇总，美元副单位按固定汇率 6.5 反算：

```
CNY 条目：金额（元）        → 内部就是元
USD 条目：金额（美元）× 6.5 → 内部是元
显示：主单位 = 内部的人民币值，副单位 = 内部值 ÷ 6.5
```

这样填 `CNY` 的条目在界面上显示的就是官方原值，不用绕一圈再还原。汇率是常量，不做配置项。

### 3.2 匹配阶梯

算一条事件的成本时，按顺序试，命中即停：

| 顺序 | 来源 | 结果 | cost_source |
| --- | --- | --- | --- |
| 1 | `models` 里模型名精确匹配 | 精确价 | `priced` |
| 2 | `byAgent` 里按 agent 加模型名 | 精确价 | `priced` |
| 3 | `rules` 里的通配规则 | 规则价 | `priced` |
| 4 | `providers` 里按厂商的默认价 | 厂商价 | `estimated` |
| 5 | `fallback` 全局兜底价 | 兜底价 | `estimated` |
| 6 | 都没有 | 无 | `missing` |

规则 4 和 5 出来的价标 `estimated`，因为它们不是这个模型的真实价格。

### 3.3 新模型没有价格时的处理

这是最常见的场景：agent 升级了，模型换了，价格表里还没有。

**采集侧照常收，不因为没价格就丢数据。** token 数是事实，成本是推算，两者分开存。

**界面侧要显式说出来，不能静默。** 4.1 价格模块下面固定有一行：

> 3 个模型未配置价格，未计入 ¥12.40（占已计价的 0.7%）

**给一条命令把缺口列出来：**

```
$ atracker pricing check
模型                          用量            缺价影响
MiniMax-M3.1-Flash           3,412,880       未计入
glm-5.3-flash                1,204,000       未计入
gpt-5.6-sol-preview            12,400       未计入
```

这条命令读的是库里实际出现过的模型和用量，所以补价格的目标很明确。

**补价格不需要重新采集日志。** 价格是从 token 数算出来的，token 数没变，只需要重算成本：

```
atracker pricing reload
```

这条命令重新读 `config/pricing.json`，按新价重算所有事件成本，再重建聚合表。规则和扫描时一致：价格表里有人民币定价的模型按表算，其他模型有来源自报成本就用自报的，没有自报就按表算，没有价格就留空。改完价格表跑这一条就行，不用重新采集日志。几百万行的话是秒级。

**从 litellm 拉草稿。** `atracker pricing import` 按 jsDelivr 主分支、jsDelivr 固定 tag、本地快照的顺序取数据，转成每百万 token 的四桶结构，写进 `config/pricing.draft.json`，同时输出和手写 `config/pricing.json` 的差异报告。**任何情况下都不覆盖手写文件。**

草稿里的价格来自 litellm，litellm 记的是各家推理服务商的价格，未必等于你直连厂商的官方价，所以草稿只用来对照，不能直接用。

**兜底价的默认值是关闭。** `config/pricing.json` 里没有 `fallback` 段就等于不兜底，缺价就是缺价。想兜底就自己填，并接受它是估算值。

### 3.4 价格表与厂商

价格表只有价格，厂商归类在 `packages/core/src/catalog.ts` 里。两者分开的原因是：厂商信息变化比价格慢，而且厂商可以从采集器上报的 `provider` 字段直接得到，不需要查表。

## 4. 4.1 的 token 总量如何快速刷新

### 4.1 物化聚合表

`usage_event` 是明细，可能有几百万行，每次算总量都扫一遍不行。维护三张日聚合表和一张累计表：

```sql
-- 按 agent 的日聚合
CREATE TABLE agg_day_agent (
  day TEXT NOT NULL, agent TEXT NOT NULL,
  input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, reasoning INTEGER,
  tokens INTEGER, cost_usd REAL, cost_cny REAL,
  PRIMARY KEY (day, agent)
);
-- 按目录的日聚合：日历堆叠条用它
CREATE TABLE agg_day_dir (
  day TEXT NOT NULL, dir TEXT NOT NULL,
  input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
  tokens INTEGER, cost_usd REAL, cost_cny REAL,
  PRIMARY KEY (day, dir)
);
-- 按模型的日聚合：模型条形图用它
CREATE TABLE agg_day_model (
  day TEXT NOT NULL, model TEXT NOT NULL, vendor TEXT,
  input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
  tokens INTEGER, cost_usd REAL, cost_cny REAL,
  PRIMARY KEY (day, model)
);
-- 来源 × 模型的日聚合：交叉表用它
CREATE TABLE agg_day_agent_model (
  day TEXT NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL, vendor TEXT,
  input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
  tokens INTEGER, cost_usd REAL, cost_cny REAL,
  PRIMARY KEY (day, agent, model)
);
-- 累计一行：4.1 和 4.2 直接读这张表
CREATE TABLE agg_total (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, reasoning INTEGER,
  tokens INTEGER, cost_usd REAL, cost_cny REAL,
  unpriced_models INTEGER, unpriced_tokens INTEGER,
  updated_at INTEGER
);
```

数据量很小：365 天 × 5 个 agent = 1,825 行，× 6 个目录 = 2,190 行，× 6 个模型 = 2,190 行，× 5 个来源 × 6 个模型 = 10,950 行。全表加起来不到两万行。

### 4.2 各模块查哪张表

| 模块 | 数据来源 | 查询 |
| --- | --- | --- |
| 4.1 token 总量与价格 | `agg_total` | 一行，O(1) |
| 4.2 token 总数四项 | `agg_total` | 一行，O(1) |
| 4.3 日历每格数字 | `agg_day_dir` 按月分组求和 | 一个月 31 行 |
| 4.3 日历堆叠条 | `agg_day_dir` 按月 | 同上 |
| 4.4 区间 token 构成 | `agg_day_*` 按范围求和 | 区间天数行 |
| 4.4.2 来源 × 模型 交叉表 | `agg_day_agent_model` 按范围求和 | 区间 × 来源数 × 模型数 |
| 4.4.3 模型条形图 | `agg_day_model` 按范围求和 | 区间 × 模型数 |
| 4.4.4 目录条形图 | `agg_day_dir` 按范围求和 | 区间 × 目录数 |
| 5.3 会话详情 | `usage_event` | 按 `session_id` 查，明细本来就要细 |

**所有聚合查询都是小表扫描，前端每次刷新都是毫秒级。**

### 4.3 增量维护

一次扫描结束后，只重算**受影响的日期**：

```
1. 收集本次新增或修改的事件的日期集合 D
2. 对 D 里每一天，从 usage_event 重算该日的四个聚合维度（来源、目录、模型、来源 × 模型）
3. 用 UPSERT 写回 agg_day_*
4. 从 agg_day_* 全表重算 agg_total（一张小表，直接重算比增量更不容易出错）
```

第 2 步要按天扫 `usage_event`，所以 `usage_event` 上要有索引：

```sql
CREATE INDEX idx_usage_event_day ON usage_event(local_day, agent);
CREATE INDEX idx_usage_event_session ON usage_event(session_id);
CREATE INDEX idx_usage_event_ts ON usage_event(ts);
```

写入、聚合更新、`agg_total` 更新放在**同一个事务**里，保证不会出现「明细写了但聚合没更新」的中间态。

一个扫描批次只碰几天的数据，重算是毫秒级的。即使是全量首扫，几百万行重算也在秒级。

### 4.4 目录配色

目录颜色跟随实体：同一个目录在任何页面、任何月份都是同一个颜色，筛选后颜色不会重新分配。

- 色板在 `core/src/palette.ts`，28 个低饱和色，米白纸面和深色底上都看得清。
- 分配结果存在 `dir_color` 表。扫描结束后把这次出现的目录交给 `assignColors()`：已有颜色的保持不变，新的从路径哈希算出的起点往后找空位，保证同时可见的目录不撞色。
- 接口返回目录时带上颜色，前端直接用，不再自己算哈希。

### 4.5 日志页要读的接口

| 接口 | 作用 |
| --- | --- |
| `GET /api/scan/batches?limit=20` | 最近的扫描批次 |
| `GET /api/logs?batch=&level=&source=&q=` | 日志行，支持按批次、级别、来源、关键字过滤 |
| `GET /api/doctor` | 每个来源的可读性和文件数 |
| `POST /api/scan` | 触发一次手动扫描，立刻返回，扫描在后台跑 |

过滤在 SQL 里做，不把全量日志拉回前端。

### 4.6 前端怎么知道要刷新

服务端用 SSE 推：

```
GET /api/events
data: {"type":"scan_done","batch":42,"affected_days":["2026-10-18"],"duration_ms":63,"warn":1,"err":0}
data: {"type":"log","batch":42,"level":"warn","source":"价格","message":"1 个模型未配置价格"}
```

前端收到后，重新拉受影响的模块。日历只刷新那几格，4.1 和 4.2 刷新数值。

首屏：服务端启动时如果库是空的，先跑一次全量扫描再开始监听，前端这段时间显示骨架屏。

## 5. 可扩展与可编辑的代码规则

### 5.1 目录结构

```
packages/
  core/src/
    types.ts        # UsageEvent 等公共类型
    units.ts        # 三种单位的换算，只有这一个实现
    money.ts        # 人民币与美元的换算
    pricing.ts      # 价格表读取、匹配阶梯、成本计算
    catalog.ts      # 模型 → 厂商
    palette.ts      # 目录 → 颜色
    time.ts         # 时区与日期分桶
  collectors/src/
    codex/index.ts
    claude-code/index.ts
    pi/index.ts
    opencode/index.ts
    dsh/index.ts
    registry.ts     # 扫描目录自动注册，不手写列表
  storage/src/
    schema.sql      # 建表
    migrations/     # 001_xxx.sql、002_xxx.sql ...
    repo.ts         # 读写与聚合维护
  server/src/
    routes.ts
    events.ts       # SSE
packages/web/src/   # React 前端
config/pricing.json # 手写价格表
data/atracker.db    # 运行时生成，不进版本库
```

### 5.2 采集器怎么写

一个新 agent 的采集器长这样：

```ts
// packages/collectors/src/cursor/index.ts
import type { Collector, ScanContext, UsageEvent } from '../types.js';

export const cursorCollector: Collector = {
  id: 'cursor',
  label: 'Cursor',
  roots: () => [join(homedir(), '.cursor')],
  async *scan(ctx: ScanContext): AsyncGenerator<UsageEvent> {
    for await (const file of ctx.filesUnder(this.roots())) {
      if (!file.path.endsWith('.jsonl')) continue;
      for await (const line of ctx.readLines(file)) {
        const raw = JSON.parse(line);
        // 只做「读出来 → 变成标准事件」，不做任何换算
        yield {
          eventId: hash('cursor', raw.sessionId, raw.messageId),
          agent: 'cursor',
          sessionId: raw.sessionId,
          parentSessionId: null,
          isChild: false,
          ts: raw.createdAt,
          cwd: raw.workspacePath,
          model: raw.modelName,
          provider: raw.provider ?? null,
          input: raw.usage.inputTokens,
          output: raw.usage.outputTokens,
          cacheRead: raw.usage.cacheReadTokens ?? 0,
          cacheWrite: raw.usage.cacheCreationTokens ?? 0,
          reasoning: raw.usage.reasoningTokens ?? 0,
          reportedCostUsd: raw.usage.cost ?? null
        };
      }
    }
  }
};
```

注册是自动的：`registry.ts` 扫描 `collectors/src/*/index.ts` 目录，把导出的采集器收进表。**新增一个 agent 不需要改 registry**，也就不会出现「加了一个忘了注册」的情况。

### 5.3 单一职责的边界

| 层 | 允许做 | 禁止做 |
| --- | --- | --- |
| 采集器 | 读文件、解析 JSON、映射成 UsageEvent | 算钱、换算单位、分配颜色、写数据库 |
| 归一化层（core） | 单位换算、厂商归属、配色、成本计算 | 读文件 |
| 存储层 | 建表、写入、维护聚合 | 判断业务规则（比如谁是谁的父会话） |
| 前端 | 展示、交互 | 自己算成本或单位 |

**一条硬规则：采集器返回的 token 四个桶必须已经是最终口径。** 比如 codex 的 `input_tokens` 含缓存这件事，在 codex 采集器里就减掉，不要留到下游再处理。下游再处理就意味着每个下游都要记得处理这件事。

### 5.4 配置与代码分离

代码里不出现具体模型名、不出现具体目录名、不出现价格数字。

| 东西 | 放在哪 |
| --- | --- |
| 价格 | `config/pricing.json` |
| 厂商归类 | `core/src/catalog.ts` 的规则表，或者采集器上报的 provider |
| 目录配色 | `core/src/palette.ts` 的色板，按路径哈希映射 |
| 来源配色 | 同一个文件里另一套色板，按 agent id 映射，和目录色板互不干扰 |
| 单位档位 | `core/src/units.ts` |
| 汇率 | `core/src/money.ts` |
| 图例上限、波谷时段这类阈值 | 有名字的常量，加注释 |

### 5.5 加一个模型要改什么

| 情况 | 改哪里 | 要不要重新采集 |
| --- | --- | --- |
| 只是价格变了 | `config/pricing.json` | 不要，跑 `atracker pricing reload` 重算 |
| 模型名换了个版本 | `config/pricing.json` 加一条 | 不要 |
| 新模型，推断不出厂商 | `catalog.ts` 加一条规则 | 不要 |
| 新 agent 出现在机器上 | 新增一个采集器目录 | 要 |

### 5.6 加一个 agent 的步骤清单

1. 在 `packages/collectors/src/<id>/index.ts` 写采集器，实现 `Collector` 接口。
2. 在 `packages/collectors/src/<id>/fixture/` 放两三个脱敏后的真实文件样本。
3. 写测试：给定样本，断言产出的 UsageEvent 列表（token 四桶、时间、目录、模型）。
4. 跑 `atracker doctor`，确认能读到文件、能算出字段覆盖率。
5. 对账：拿该 agent 自带的汇总数据核对（见 5.7）。

**不要改任何已有采集器的代码。** 如果发现需要改，说明边界划错了，要在 `core` 里加能力，而不是在别的采集器里加分支。

### 5.7 测试规则

| 层 | 测什么 |
| --- | --- |
| 采集器 | fixture 输入 → 期望的 UsageEvent 列表。要覆盖：字段缺失、文件被截断、模型中途切换 |
| 单位换算 | 三种单位的边界值（0、999、1 万、1 亿、10 亿） |
| 成本计算 | 匹配阶梯的每一级、缺价、波峰波谷、缺价模型不计入总额 |
| 聚合维护 | 增量重算后，聚合表和明细对得上 |
| 对账 | 和 agent 自带的汇总交叉校验 |

对账用的来源（都是现成的）：

| agent | 自带汇总 | 位置 |
| --- | --- | --- |
| codex | 每个会话的 `tokens_used` | `~/.codex/state_5.sqlite` 的 `threads` 表 |
| Claude Code | 每个会话的 `modelUsage` 和 `totalCostUSD` | 会话文件里的 `cost-state` 事件 |
| pi | 每个会话的 `tokensIn/tokensOut/cacheRead` | `~/.pi/agent/sessions/*/*.meta.json` |
| opencode | 每个会话的 `tokens_input` 等汇总列 | `opencode.db` 的 `session` 表 |
| DSH | 每个会话的 `tokenUsage.totals` | `~/.dsh/storages/session_projcache` |

### 5.8 代码规则清单

1. 一个采集器只做一件事：读文件、产出事件。不碰数据库，不算钱，不改格式。
2. 所有数字格式化走 `core/units.ts`，所有金额走 `core/money.ts`，所有成本走 `core/pricing.ts`。禁止在别处写 `toFixed` 拼单位。
3. `usage_event` 只追加。修正数据用同一个 `event_id` 覆盖，不要 UPDATE 别的字段。
4. 新增字段必须可空并给默认值，迁移只往前加，不改历史迁移文件。
5. 魔法数字要有名字和注释（折扣、阈值、上限、条数）。
6. 日志统一格式：`[采集器] 发生了什么`。错误信息里带上文件路径。
7. 单个文件解析失败只跳过这个文件，不影响整批；单个文件的失败计数写进 `scan_batch`。
8. 写库前先拿进程锁，避免两个进程同时写。
9. 聚合表的更新和明细写入在同一个事务里。
10. 时间一律存 UTC 毫秒，按日分桶时用 `core/time.ts` 转成本机时区，不在业务代码里手写时区偏移。

## 6. 界面主题

### 6.1 主题和明暗是两个正交维度

`data-theme` 决定**风格**，`data-mode` 决定**明暗**，两者互不影响：

```html
<html data-theme="receipt" data-mode="light">
```

第一版用 `design/v3/02-receipt.html` 的「热敏小票」风格，主题 id 记作 `receipt`。以后加新风格，只要再提供一份变量，不会把明暗逻辑重写一遍。

v3 的五个设计已经演示了这套结构：`design/v3/_core.js` 是共享的计算层（状态、聚合、格式化、路由），每个 HTML 只负责自己的结构和 CSS。实现时把 `_core.js` 的逻辑拆进 `core` 和 `components`，把每个设计的 CSS 变成一份主题变量。

### 6.2 分层

```
packages/web/src/
  themes/
    receipt/
      tokens.css     变量层：--paper --ink --accent --rule …
      layout.css     布局层（可选）：这个风格偏好的排布
      index.ts       注册：id、显示名、默认布局
  components/        组件：只引用语义变量
  layouts/           页面排布：ledger / calendar-first / table-first / two-reports / three-col
  app.tsx            组装：主题 × 排布
```

三层各管各的：

| 层 | 负责 | 禁止 |
| --- | --- | --- |
| 变量层 | 颜色、字体、圆角、密度 | 出现具体组件名 |
| 组件层 | 日历、交叉表、条形、日志流的结构和样式 | 写死任何颜色值 |
| 排布层 | 页面各区块的位置和尺寸 | 依赖具体主题 |

**组件层里出现一个 `#` 十六进制色值就是 bug**，评审时要查。

### 6.3 运行时切换

```ts
document.documentElement.dataset.theme = 'receipt';
document.documentElement.dataset.mode = 'dark';
localStorage.setItem('atracker-theme', themeId);
localStorage.setItem('atracker-mode', mode);
```

切换主题只换一份 CSS 变量，组件不重渲染。排布也可以跟着主题走：主题注册时声明默认排布，用户手动改过就以用户的选择为准。

### 6.4 前后端的接口

前端只读接口，参数都是日期和筛选条件：

| 接口 | 作用 |
| --- | --- |
| `GET /api/total` | 累计总量：四桶、token 数、成本、未计价量 |
| `GET /api/calendar?month=YYYY-MM` | 某月每天的总量和按目录的拆分，加上目录图例 |
| `GET /api/aggregate?from=&to=` | 区间内的四桶、按来源、按模型、按目录 |
| `GET /api/matrix?from=&to=` | 来源 × 模型交叉表 |
| `GET /api/day?date=YYYY-MM-DD` | 单日详情：四桶、小时分布、来源 × 模型、当天会话、最贵调用、采集状态 |
| `GET /api/conversations?dir=&agent=&model=&q=` | 会话列表，按目录分组 |
| `GET /api/conversation?id=codex:<会话uuid>` | 单个会话的逐轮明细 |
| `GET /api/logs?batch=&level=&source=&q=` | 日志行 |
| `GET /api/scan/batches` | 扫描批次 |
| `GET /api/doctor` | 各来源可读性 |
| `POST /api/scan` | 触发一次手动扫描，立刻返回，扫描在后台跑 |
| `GET /api/events` | SSE。推 `scan_done`（批次号、写了多少条、哪些天变了）和 `log` |

所有聚合查询都走物化表，不扫明细（见 4.2）。接口返回的字段名要和 `packages/core/src/types.ts` 一致，前端不自己算成本。

### 6.5 变量清单

每个主题必须定义下面这些语义名。缺一个就渲染出难看的默认样式，所以清单要固定。

| 变量 | 用途 |
| --- | --- |
| `--bg` `--panel` `--panel2` `--head` | 背景的四个层级 |
| `--fg` `--fg2` `--fg3` | 文字的三级灰 |
| `--line` `--line2` | 两种分隔线 |
| `--accent` `--accent2` `--neg` `--info` | 强调、提示、负向、信息 |
| `--accent-bg` `--accent-bd` `--amber-bg` `--neg-bg` | 状态标签的底色和边框 |
| `--sel` | 选中态底色 |
| `--shade1` … `--shade4` | 热力图和交叉表的色阶 |
| `--font` | 字体栈 |
| `--r` `--row` `--pad` | 圆角、行高、内边距 |

色阶那四个变量是给热力图和交叉表用的，主题必须给出从浅到深的四档，不能让组件自己去调透明度。

### 6.6 加一个主题要做什么

1. 建 `themes/<id>/tokens.css`，按上面的清单定义一整套变量，明暗各一套。
2. 可选建 `themes/<id>/layout.css`，覆盖这个风格偏好的排布。
3. 在 `themes/index.ts` 注册：id、显示名、默认排布、变量文件。
4. 组件不用动，排布不用动。

`receipt` 的实现在 `design/v3/02-receipt.html`：小票纸带的变量在文件开头的 `:root[data-theme=light]` / `:root[data-theme=dark]` 两段里，排布和结构在同一文件的 CSS 后半段。

### 6.7 约束

- 每个主题必须同时提供明暗两套，缺一套就等于半个主题。
- 组件里禁止出现具体颜色值，一律用语义变量。
- 排布层里不允许按主题名写分支，主题差异全部收敛到变量层。
- 新增排布（`layouts/`）不能改组件，改排布只动 `layouts/` 和 `app.tsx`。

## 7. 前端

前端用 React 19 + Vite + TypeScript。`npm run build:web` 把源码构建到 `packages/web/dist`，服务端直接托管这个目录。开发时先起 `atracker serve`，再跑 `npm run dev:web`（Vite 默认 5173），`/api` 会代理到 4178。

| 文件 | 内容 |
| --- | --- |
| `packages/web/index.html` | Vite 入口 |
| `packages/web/src/main.tsx` | 挂载 React 根节点 |
| `packages/web/src/App.tsx` | 页面状态、取数、URL 参数、SSE 刷新 |
| `packages/web/src/views/` | 总账、今日、会话、日志四个视图 |
| `packages/web/src/components/` | 页头等公共组件 |
| `packages/web/src/receipt.css` | 主题变量和组件样式。第一套是「热敏小票」（`design/v3/02-receipt.html`） |

**主题和明暗的分工。** CSS 用 `[data-mode="light"]` 和 `[data-mode="dark"]` 两段变量表示明暗，用 `data-theme` 表示风格（现在是 `receipt`）。加新风格就是再加一段 `[data-theme="<id>"]` 的变量，不动组件。

**取数层。** `src/api.ts` 只负责请求接口；`src/format.ts` 负责单位和货币换算。视图组件不自己拼单位、不自己算成本。

**轮询改推送。** `App.tsx` 用 `EventSource('/api/events')` 订阅，扫描完成后服务端推 `scan_done`，前端重新取数重画。

**前端源码只有一份。** 页面代码在 `packages/web/src`，`packages/web/dist` 是构建产物，不手工改。


## 8. 落地顺序

| 阶段 | 内容 | 产出 |
| --- | --- | --- |
| T1 | 存储层：建表、迁移、`file_cursor`、`usage_event` 写入 | `atracker scan --source codex` 能落库 |
| T2 | 采集器：一个一个来，每个配 fixture 测试 | 五个源都能采集 |
| T3 | 聚合层：增量重算、`agg_*` 维护 | `atracker stats` 能秒出总量 |
| T4 | 成本：`core/pricing.ts`、匹配阶梯、`pricing check`、`pricing reload` | 成本能算，缺口能列出来 |
| T5 | 服务层：API、SSE、扫描触发 | 前端能实时刷新 |
| T6 | 前端：按 `design/v3/02-receipt.html` 实现，主题层按 TECH 第 6 节的结构搭 | 完整界面 |
