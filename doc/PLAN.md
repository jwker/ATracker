# ATracker — 本机 Agent Token 用量汇总看板

## 1. 这个项目解决什么问题

在一台电脑里同时用多个 AI 编码 agent（codex、Claude Code、pi、opencode、DeepSeek Harness）时，每个 agent 都把用量记在自己家目录里，彼此不通。本项目只读这些本地文件，把它们统一成一套用量事件，写进本地数据库，再提供看板、热力图和多维度下钻。

原则是**不加任何钩子、不改 agent 行为、不上传任何数据**。所有数字都来自 agent 自己已经落盘的会话日志。

## 2. 范围与已定决策

第一期覆盖五个 agent：codex、Claude Code、pi、opencode、DeepSeek Harness。

已确定的事项：

- **技术栈**：TypeScript + Node 24 以上，SQLite 用 Node 自带的 `node:sqlite`，前端 React 19 + Vite + TypeScript。
- **成本**：不内置任何自动定价源。成本来自一个手动填写的配置文件，格式见第 4.2 节。
- **参照**：可以参考本机已装的 TokenTracker（MIT 协议，源码在 `~/.tokentracker/tracker/app`）的 zstd 帧遍历实现和定价匹配思路，架构自己写。
- **子 agent**：用量计入，但归属到父会话，同时保留父会话标识，看板可切换「含子 agent」和「仅主 agent」两种口径。详见第 6.4 节。
- **token 口径**：按总 token、输入、输出、缓存命中分开统计，另加缓存写入和推理 token。详见第 3.1 节。

## 3. 数据源（本机实测）

下面每一条都在当前机器上验证过，字段名是文件里的真实字段名。

| Agent | 位置 | 格式 | 用量粒度 | 模型与厂商字段 |
| --- | --- | --- | --- | --- |
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.zst` | zstd 压缩的 JSONL | 每轮一次 `event_msg`，其 `payload.type` 为 `token_count` | `turn_context.payload.model`；厂商看 `session_meta.payload.model_provider` |
| Claude Code | `~/.claude/projects/<目录slug>/<会话uuid>.jsonl`，子 agent 在 `<会话uuid>/subagents/` 下 | 纯 JSONL | 每条 `type` 为 `assistant` 的消息，`message.usage` | `message.model` |
| pi | `~/.pi/agent/sessions/<目录slug>/<时间戳>_<会话uuid>.jsonl` | 纯 JSONL | 每条 `type` 为 `message` 且 `message.role` 为 `assistant` 的记录，`message.usage` | `message.provider` 与 `message.model` |
| opencode | `~/.local/share/opencode/opencode.db` | SQLite | 新表 `session_v2` / `session_message`（桌面端在用），旧表 `session` / `message` 是迁移前的副本 | `session_message.data.model.providerID` 与 `.id` |
| DeepSeek Harness | `~/.dsh/sessions/<目录slug>/<会话id>/session[.vN].jsonl.zstd` | zstd 压缩的 JSONL | `assistant/message` 事件的 `data.usage` | `data.message.source.provider` 与 `.model`；`request/header` 的 `data.header.config` 也带一份 |

补充的旁路数据，用于补齐上下文和交叉校验，不作为用量主来源：

- `~/.codex/state_5.sqlite` 的 `threads` 表给出每个会话的 `cwd`、`rollout_path`、`model`、`model_provider` 和累计 `tokens_used`；`thread_spawn_edges` 表给出父子线程关系。
- `~/.codex/thread_history_1.sqlite` 的 `thread_turns` 表给出每个 turn 的 `rollout_byte_offset`，可以据此做增量读取。
- Claude Code 会话文件里的 `cost-state` 事件带 `modelUsage` 汇总（按模型的 input、output、cacheRead、cacheCreation、thinking token）和 `totalCostUSD`，可以拿来对账。
- `~/.dsh/storages/session_projcache.json` 与同目录 `sessions/*.json` 给出每个 DeepSeek Harness 会话的 `identity.cwd` 和 `tokenUsage.totals`。
- `~/.pi/agent/models-store.json` 给出 pi 的 provider 列表和每个模型的官方单价。

### 3.1 token 口径的统一规则

不同 agent 对「输入」的定义不一样，直接相加会错。本项目把每个源的字段统一到下面这套口径：

| 统一字段 | 含义 |
| --- | --- |
| `input_tokens` | 未命中缓存的输入 |
| `cache_read_tokens` | 缓存命中（读取缓存） |
| `cache_write_tokens` | 缓存写入 |
| `output_tokens` | 输出，**包含**推理 token |
| `reasoning_tokens` | 推理 token，是 `output_tokens` 的子集，只做拆分展示，不重复计入总量 |
| `total_tokens` | `input_tokens + cache_read_tokens + cache_write_tokens + output_tokens` |

各源的转换规则：

- **codex**：两处要注意。
  1. `input_tokens` **含有**缓存命中部分，要减去 `cached_input_tokens` 才是未缓存输入。**已验证**：实测一条记录里 `input_tokens 13262`、`cached_input_tokens 4416`、`output_tokens 174`，它自报的 `total_tokens 13436` 等于 `input_tokens + output_tokens`，说明缓存已经算在 `input_tokens` 里。
  2. **每轮的用量要用 `total_token_usage` 的增量，不能用 `last_token_usage`。** 一轮里可能有多次 API 调用（工具调用循环），`last_token_usage` 只记最后一次，而累计值的增量才是这一轮的真实总量。实测一个 61 轮的会话，两者相差 4 万 token（2,057,836 对 2,098,037）。**用增量算，合计正好等于 `state_5.sqlite` 里 `threads.tokens_used`**，这是对账标准。
- **Claude Code**：`input_tokens` 是不含缓存的输入，`cache_read_input_tokens` 是缓存命中，`cache_creation_input_tokens` 是缓存写入，`output_tokens_details.thinking_tokens` 是推理 token。**同一条 assistant 消息会按内容块写成多行**（`apiBlockIndex` 不同、uuid 也不同），每行带的是同一份 usage，直接累加会翻倍，要按 `message.id` 去重。
- **pi**：`usage.input` 是不含缓存的输入，`cacheRead` 是缓存命中，`cacheWrite` 是缓存写入，`reasoning` 是推理 token。pi 自己报的 `totalTokens` 等于输入加输出加缓存命中加缓存写入，不含推理 token，符合上面的口径。
- **opencode**：`tokens.input` 是不含缓存的输入，`tokens.cache.read` 是缓存命中，`tokens.cache.write` 是缓存写入，`tokens.reasoning` 是推理 token。
  **两代存储格式要分清**：同一个 `opencode.db` 里既有旧表 `session` / `message`，也有 opencode 2.x（桌面端在用）的新表 `session_v2` / `session_message`。新表是旧表迁移过来的，同一批会话在两边各存一份（实测 `ses_0de322576f` 两边的 `tokens_input` 都是 24481），**两张都读会重复计算**。所以只要 `session_v2` 有数据就只读新表。
  **压缩掉的旧消息要补差**：会话被压缩后，旧消息从消息表里删掉，但 token 数仍留在 `session_v2` 的汇总列里（实测差 336.9 万，占 0.8%）。总量以来源自己的口径为准，差出来的量按四个桶分别补成一条事件，模型取会话的模型，日期取会话最后活动时间。差额的**成本**也按来源口径：来源报 0 就是 0（免费模型），`null` 才表示不知道，两者不能混。
- **DeepSeek Harness**：`data.usage` 里的 `inputTokens` 是不含缓存的输入，`cacheReadTokens` 是缓存命中，`cacheWriteTokens` 是缓存写入，`reasoningTokens` 是推理 token。一个会话目录里可能有多个版本文件（`session.jsonl.zstd` 是 v0，`session.v2/v4` 是后来的格式），新版是旧版的延续不是叠加，**只读编号最高的那个**，全加起来会重复计算。

每一家的口径都要在 M2 阶段用旁路数据核对一遍，发现不一致就在采集器里做转换并写进测试。

### 3.2 目录（cwd）的来源

每个 agent 都有工作目录，取值优先级：

1. 记录里直接带的 `cwd`（Claude Code 的每一行、pi 的 `session` 行、opencode 的 `session_v2.directory`（旧格式是 `message.data.path.cwd`）、codex 的 `turn_context.payload.cwd`、DeepSeek Harness 的 `session` 头行）。这是最可靠的来源。
2. 目录名 slug（例如 `-Users-jiangjiang-Documents-host-film`）是 cwd 的编码，但编码规则有损（点号会被替换），只用于定位文件，不作为取值来源。

## 4. 数据模型

### 4.1 用量事件

所有 collector 输出同一种事件，落库表 `usage_event`：

| 字段 | 含义 |
| --- | --- |
| `event_id` | 稳定唯一键，由 agent、会话标识、记录标识派生，用于去重 |
| `agent` | `codex` / `claude-code` / `pi` / `opencode` / `dsh` |
| `session_id` | agent 自己的会话标识 |
| `parent_session_id` | 父会话标识；子 agent 和派生线程填这里，顶级会话为空 |
| `is_child` | 是否是子 agent 或派生线程产生的用量 |
| `ts` | 事件发生的 UTC 毫秒时间戳 |
| `local_date` | 按本机时区折算的日期，Y-M-D |
| `cwd` | 工作目录绝对路径 |
| `model` | 模型标识，保留原始写法 |
| `provider` | 厂商键，例如 `openai`、`anthropic`、`deepseek`、`minimax-cn`、`zai` |
| `input_tokens` | 未缓存输入 |
| `cache_read_tokens` | 缓存命中 |
| `cache_write_tokens` | 缓存写入 |
| `output_tokens` | 输出，含推理 |
| `reasoning_tokens` | 推理 token，输出的子集 |
| `total_tokens` | 总量 |
| `thinking_level` | 思考档位，仅 pi 提供，其他源为空。存下来但不做筛选 |
| `cost` | 成本 |
| `cost_source` | `reported`（来源自带）、`estimated`（按成本表算）、`priced`（按成本表算但用户没填时的空值） |

另外两张表：`file_cursor` 记录每个源文件已解析到的位置和指纹，`model_price` 存成本表。

前端查聚合用另外一套物化表（来源、目录、模型、来源 × 模型的日聚合，加一张累计单行表），结构见 `doc/TECH.md` 第 4 节。

### 4.2 成本表配置文件

手写维护，路径 `config/pricing.json`，随项目进版本库。**这是唯一生效的定价来源**，litellm 拉来的草稿只写到 `config/pricing.draft.json`，不会覆盖它。文件已经建好，模板见 `config/pricing.json`。

各个旋钮都在这一个文件里：

| 想改什么 | 改哪里 |
| --- | --- |
| 某个模型的四个桶单价 | `models` 下对应模型名 |
| 模型的匹配不到时按厂商给个默认价 | `providers` |
| 某个模型名带后缀、匹配不到时按通配给价 | `rules` |
| 同一个模型在不同 agent 下价格不同 | `byAgent` |
| DeepSeek 这类按时段变价 | 模型条目里的 `schedule` |
| MiniMax 这类按输入长度分档 | 模型条目里的 `tiers` |

文件的结构：

```json
{
  "currency": "USD",
  "unit": "usd_per_million_tokens",
  "models": {
    "gpt-5.6-sol": { "input": 1.25, "output": 10, "cache_read": 0.125, "cache_write": 1.25 }
  },
  "rules": [
    { "match": "glm-5.*", "price": { "input": 0.6, "output": 2.2, "cache_read": 0.06, "cache_write": 0.6 } }
  ],
  "providers": {
    "minimax-cn": { "default": { "input": 0.3, "output": 1.2, "cache_read": 0.006, "cache_write": 0 } }
  },
  "byAgent": {
    "claude-code": { "claude-opus-4-8": { "input": 15, "output": 75, "cache_read": 1.5, "cache_write": 18.75 } }
  }
}
```

价格分四个桶，与第 3.1 节的 token 口径一一对应：

| 桶 | 对应的 token 字段 | 说明 |
| --- | --- | --- |
| `input` | 未缓存输入 | 普通输入单价 |
| `output` | 输出 | 含推理 token，推理部分不再单独计价 |
| `cache_read` | 缓存命中 | 命中缓存的读取价，通常是输入价的几十分之一 |
| `cache_write` | 缓存写入 | 首次写入缓存的价，Anthropic 和 DeepSeek 一般等于或略高于输入价 |

有些模型没有独立的缓存写入价，填 0 即可，缺这个字段也按 0 处理。

**按输入长度分档。** 上下文长的请求单价更高，这类模型在条目里带一个 `tiers` 数组，按单次请求的输入长度选档：

```json
"tiers": [
  { "inputTokensAbove": 512000, "input": 0.6275, "output": 2.5098, "cache_read": 0.1255, "cache_write": 0 }
]
```

本机 `~/.pi/agent/models-store.json` 里的 MiniMax-M3 就是这种结构，阈值 512000。阈值比较的量按「该次请求的总输入」算，即未缓存输入加缓存命中，这一点标为待确认，见第 9 节。

**按时段变价。** DeepSeek 这类模型按调用时刻分波峰和波谷定价。本项目按**每条用量事件的时间戳**逐条算，而不是按会话或按天汇总后算一次，所以跨时段的长会话也能算准。价格条目可以带一个 `schedule` 段：

```json
{
  "models": {
    "deepseek-v4-flash": {
      "input": 0.44, "output": 1.32, "cache_read": 0.014, "cache_write": 0.44,
      "schedule": {
        "peakHoursUtc": [[1, 4], [6, 10]],
        "offPeakMultiplier": 0.5,
        "weekendOffPeak": { "timezone": "Asia/Shanghai", "from": "2026-08-23" }
      }
    }
  }
}
```

含义是：表里存的是波峰价；UTC 时间落在 `peakHoursUtc` 里的算波峰，用原价；其余算波谷，四个桶的价都乘 `offPeakMultiplier`。`weekendOffPeak` 段表示从某个日期起，北京时间的周六周日整天算波谷。字段都可以改，`peakHoursUtc` 写成空数组就表示全天同一价。

这套规则的来源是 TokenTracker 的实现（`src/lib/pricing/index.js` 的 `isDeepSeekOffPeak` 与 `getRowPricing`）：它把波峰价存进表里，波谷判定顺序是「先看记录上的 `pricing_tier` 标记，再看调用时刻的 UTC 小时是否落在 01:00–04:00 或 06:00–10:00 之外，最后看北京时间是不是周末」，波谷价是四个桶统一乘 0.5。DeepSeek 官方定价页见 `api-docs.deepseek.com/quick_start/pricing`。本项目把判定做成了配置而不是写死，规则以你填的为准。

匹配顺序，从上到下先命中先用：

1. `byAgent` 里按 agent 加模型名的条目。
2. `models` 里模型名精确匹配（大小写不敏感）。
3. `rules` 里的通配规则（`match` 是 glob）。
4. `providers` 里按厂商的默认价。

价格表里没有的模型，成本留空并在看板上标注「未配置价格」，不填 0，避免看起来像免费。

各 agent 的成本来源：pi、opencode、DeepSeek Harness 的记录自带成本，直接采信并标 `reported`；codex 和 Claude Code 不带成本，用成本表算并标 `estimated`。

### 4.3 厂商归属

优先取 agent 自带的 provider 字段。只有当来源没给厂商时才用模型名反查：本地覆盖表优先，其次成本表里的厂商归类。

## 5. 架构

```
collector（只读各 agent 文件）
   ↓ 归一化为 usage_event
SQLite（本地，node:sqlite）
   ↓ 聚合查询
HTTP API（只读）
   ↓
看板前端
```

命令行：

- `atracker scan` 扫描入库。
- `atracker serve` 起 API 和前端。
- `atracker doctor` 体检各源的可读性和字段覆盖。
- `atracker pricing check` 列出哪些模型还没配价格。

## 6. 关键技术难点

### 6.1 zstd 多帧文件

这是最需要小心的一点。Node 的 `zlib.zstdDecompressSync` 和 `zstdDecompressSync` 流**只解第一帧**，多帧拼接的文件会静默丢掉后面的内容。DeepSeek Harness 的会话文件正是多帧拼接的：实测一个 9.7 MB 的 v0 会话文件由 27347 帧组成，解开后是 36011 行、21.7 MB。

两种解法：

- 自己写帧遍历器：解析 zstd 帧头拿到窗口描述符和内容大小，再逐块跳过压缩数据。参考实现在 `~/.tokentracker/tracker/app/src/lib/rollout.js` 的 `inspectDshZstdFrames`，它已经把这套做通了。
- 调用系统 `zstd` 命令行做兜底。

**待定**：第一期先按帧遍历器实现，不引入系统依赖。

### 6.2 增量扫描

不能每次都全量重扫。做法是给每个源文件记指纹（路径、大小、修改时间、inode），指纹没变就跳过；变了就重新解析并按 `event_id` 覆盖写入。codex 的 rollout 还有 `rollout_byte_offset` 可以用，收益更大。

### 6.3 去重

同一个 turn 在多处出现的情况很常见。规则是**一条用量只取一个权威来源**：

- codex 取 `token_count` 的 `last_token_usage`，不取 `total_token_usage`。
- DeepSeek Harness 统一取 `assistant/message` 的 `data.usage`。v0 格式里 `assistant/chunk` 的 usage 块和它是一一对应的同一份数据，只取前者。

### 6.4 子 agent 的归属

Claude Code 的子 agent 有独立的文件，位置是 `~/.claude/projects/<目录slug>/<父会话uuid>/subagents/agent-<agentId>.jsonl`，记录里带 `isSidechain: true` 和 `agentId`，父会话 uuid 直接体现在目录名里。

codex 的派生线程是独立线程，`state_5.sqlite` 的 `thread_spawn_edges` 表给出父子关系。

处理办法：

- 子 agent 的用量**照常计入总量**，因为它确实消耗了 API。
- 同时写入 `parent_session_id` 和 `is_child`，把用量归属到父会话。
- 看板提供「含子 agent」和「仅主 agent」两个开关，切换的是过滤条件而不是重新统计。

这样既不会漏，也不会重复计数：父会话文件里不包含子 agent 的 usage（实测父会话 416 条 assistant 消息、子 agent 35 条，父子各自独立计量）。

### 6.5 时区

库里存 UTC 时间戳和本机时区折算出的 `local_date`。热力图和所有按日聚合都走 `local_date`，避免跨时区时日期错位。

## 7. 里程碑

**M0 骨架。** 项目结构、SQLite schema、统一类型、厂商映射、成本表加载与匹配（含 `currency` 字段和多币种折算）。产出：能建库、能建表，`atracker pricing` 能报出缺价的模型，`atracker pricing import` 能从 litellm 拉一份草稿和差异报告。**已完成**（`packages/` 下 core / storage / collectors / cli 四层，Node 直接跑 TS 无构建步骤）。

**M1 五个 collector。** 每个 agent 一个采集器，输出统一事件。每个采集器配一个用本机真实文件做断言的测试。产出：`atracker scan` 能把五个源的用量全部落库。**五个都已完成**，共 4,746 条事件、30 天、8.91 亿 token。

**M2 对账。** 拿会话自带的数据交叉验证：codex 用 `threads.tokens_used`，Claude Code 用 `cost-state` 的 `modelUsage`，DeepSeek Harness 用 `session_projcache` 的 `tokenUsage.totals`，opencode 用 `session` 表的 `tokens_input` 等汇总列，pi 用 `*.meta.json` 的 `tokensIn/tokensOut/cacheRead`。同时核对第 3.1 节的 token 口径。产出：`atracker reconcile` 命令和一份对账报告，差异要么解释清楚，要么改采集器修掉。**已完成**，见下。

**对账结果（2026-10-21）。**

| 来源 | 基准 | 结果 |
| --- | --- | --- |
| codex | `threads.tokens_used` 全量合计 | 2,217,949 对 2,217,949，完全一致 |
| Claude Code | `cost-state` 的 `modelUsage` | 可比的 2 个会话全部一致。**注意**：`cost-state` 会被别的会话继承（里面写着 `claude-opus-4-8` 但实际用的是 `glm-5.3-flash`），模型对不上的不拿来比 |
| pi | `*.meta.json` 的 token 计数 | 可比的 1 个会话一致，另 1 个的 meta 是会话中途的快照，我们比它多 |
| opencode | `session` 表汇总列 | 434,547 对 434,547，完全一致 |
| DeepSeek Harness | `session_projcache` 的 `tokenUsage.totals` | 31 个会话全部一致；我们另多采到 8 个 projcache 没记的会话 |

**M3 聚合 API。** 一套接口支持按任意维度分组与过滤：agent、目录树、模型、厂商、日期段。产出：API 能返回看板和热力图需要的所有数据。**已完成**：`atracker serve` 起本地服务，接口清单见 `doc/TECH.md` 第 6.4 节。载荷字段和 `design/v3/_core.js` 要的形状对齐，前端移植时不用改结构。文件监听自动扫描和 SSE 推送也一起做了。

**M4 看板前端。** 顶部指标卡（总 token、输入、输出、缓存命中、成本、会话数、活跃天数）、按日热力图、维度切换、目录树下钻、日期区间选择、含子 agent 开关。产出：可用界面。**已完成**：按 `design/v3/02-receipt.html`（热敏小票）实现，视图代码从 v3 移植，数据层换成真接口。三个视图（总账 / 会话 / 日志）都接了真数据，日历选日与区间、交叉表下钻、单位与明暗切换都能用。**2026-10-21 已重构为 React 19 + Vite**，样式和交互保持不变，源码在 `packages/web/src`。

**M5 增量与体验。** 增量扫描、扫描耗时优化、`doctor` 命令、首次运行引导。产出：日常可用。**已完成**：文件指纹比对 + 字节偏移续读，首次全量 2873ms、之后每次 55ms；服务端每 5 分钟兜底轮询一次；`doctor` 列出每个来源的路径、文件数、事件数、上次扫描和缺价模型；库里没数据时界面显示引导。

**M6 扩展。** 再接其他 agent，按同一套 collector 契约接入。

## 8. 目录结构建议

```
ATracker/
  packages/
    core/         类型定义、归一化、厂商映射、成本表匹配
    collectors/   五个采集器 + 扫描编排
    storage/      SQLite schema、写入、聚合查询
    server/       HTTP API、SSE、文件监听
    web/          React 19 + Vite 前端（src 是源码，dist 是构建产物）
    cli/          命令行入口
  config/
    pricing.json  手写成本表
  data/           本地数据库（不入版本库）
  backup/         重构前的前端备份（不入版本库）
```

## 9. 剩下待讨论的事

### 9.1 已经定下来、不再讨论的

| 事项 | 决定 |
| --- | --- |
| 成本表和 litellm 的关系 | 以手写表为准；另外做 `atracker pricing import` 从 litellm 拉草稿做对照，不覆盖手写表 |
| 厂商没公布缓存写入价 | 统一统计到输入内，缓存写入桶恒为 0，价格填 0 |
| MiniMax 的价格 | 用官方价格页的数值，单位元/百万 token；M2.7 按 M3 同价；M3 分 ≤512k 和 >512k 两档 |
| DeepSeek 波峰波谷规则 | 按表里的默认值：UTC 01–04、06–10 为波峰，北京时间周末整天波谷，波谷乘 0.5 |
| 长上下文分档的阈值比较量 | 按该次请求的总输入算，即未缓存输入加缓存命中 |
| Claude Code 的计费 | 一律按 API 单价计算，订阅不单独计费，不需要按 agent 区分价格 |
| 缓存写入价单位 | 价格表支持 `currency` 字段，官方用哪种货币就填哪种 |
| pi 的思考档位 | 不做档位筛选。字段照常存进 `usage_event`，界面上不出现 |
| zstd 多帧解法 | 自己写帧遍历器，不引入系统依赖 |
| codex 的 `input_tokens` 含缓存 | 已验证（见 3.1 的实测数据），采集时减一次 `cached_input_tokens` |
| 界面风格 | 已定 `design/v3/02-receipt.html`「热敏小票」，第一个要实现的主题 |

### 9.2 还没定的

| 事项 | 现状 | 怎么定 |
| --- | --- | --- |
| MiniMax-M2.7-highspeed 的价格 | 已按 M3 同价填（决定），官方没有独立条目 | 用到时再问 MiniMax |
| 界面主题的第二套 | `design/v3/` 里还有 01/03/04/05/06/07 六个方向 | 第一个主题做完后再说 |

## 10. 从 litellm 拉价格草稿的可行性（已实测）

**网络。** 直连 `raw.githubusercontent.com` 不通：系统解析器对这个域名返回畸形应答，curl 在 2 毫秒内连接失败。公共 DNS（8.8.8.8、1.1.1.1）能正常解析到 GitHub 的真实地址，所以问题在本机的解析或网络过滤层，不是域名失效。`api.github.com` 和 `github.com` 正常。

可用的替代源是 jsDelivr 的 GitHub 镜像：

| 地址 | 结果 |
| --- | --- |
| `cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json` | 连续三次 200，2.95 MB，耗时 4.5 到 10 秒，三次内容 md5 一致 |
| `cdn.jsdelivr.net/gh/BerriAI/litellm@v1.104.4/...`（固定 release tag） | 200，2.94 MB，耗时 9.8 秒 |

不存在的 tag 会返回 404 或超时，所以固定版本要用真实存在的 release tag。

**数据。** 文件共 4225 个键，其中 3430 条带定价。需要的四个桶都能拿到：`input_cost_per_token`、`output_cost_per_token`、`cache_read_input_token_cost`、`cache_creation_input_token_cost`，另外还有 `litellm_provider` 字段可以用于厂商归类。文件里的价格单位是**每 token**，我们的成本表是**每百万 token**，换算是乘以一百万。

**覆盖度。** 本机五个源里实际出现过的模型，加上去厂商前缀的匹配规则之后的命中情况：

| 模型 | 出现的 agent | litellm 命中 |
| --- | --- | --- |
| `MiniMax-M2.7` | opencode | 命中 `sambanova/MiniMax-M2.7` 等 |
| `MiniMax-M3` | opencode、pi | 命中 `fireworks_ai/minimax-m3` 等 |
| `MiniMax-M3.1-Flash` | pi | 未命中 |
| `glm-5.3-flash` | Claude Code | 命中 `sail/zai-org/GLM-5.3-Flash` 等 |
| `deepseek-flash` | pi | 命中 |
| `deepseek-v4-flash` | Claude Code | 命中 |
| `deepseek-v4-pro` | pi | 命中 |
| `<synthetic>` | Claude Code | 不适用 |

`<synthetic>` 是 Claude Code 生成的合成回复，不是真实的 API 调用，采集阶段就应该排除，不参与定价。

**注意。** 命中不等于价格正确。litellm 里 MiniMax 和 GLM 这些模型记的是第三方推理服务商（火山、硅基流动之类）的价格，未必等于你直连厂商的官方价。所以拉来的内容只能作为草稿和对照，由人决定采信。

**实现。** 落成一个 `atracker pricing import` 命令：按 jsDelivr 主分支、jsDelivr 固定 tag、本地快照的顺序尝试取数据，取到后转成每百万 token 的四桶结构，写进 `config/pricing.draft.json`，同时输出一份和手写 `config/pricing.json` 的差异报告。**任何情况下都不覆盖手写文件。**

## 11. 界面风格方案

**已选定 `design/v3/02-receipt.html`「热敏小票」**，这是第一个要实现的主题。

`design/v3/` 是并行出的几版界面设计，共用一套数据与计算层（`data.js` + `_core.js`）：

| 文件 | 方向 | 状态 |
| --- | --- | --- |
| `02-receipt.html` | 热敏小票 | **已定，第一个实现** |
| `01-blueprint.html` | 工程蓝图 | 备选 |
| `03-departure.html` | 出发时刻表 | 备选 |
| `04-synth.html` | 模块合成器 | 备选 |
| `05-riso.html` | Riso 用量小报 | 备选 |
| `06-swiss.html` | 瑞士网格 | 备选 |
| `07-ledger.html` | 账本 | 备选 |

热敏小票这一版：窄幅纸带居中显示，条码抬头，齿孔撕边，虚线引导，逐行小票，金额用红色。**模块按 `design/wireframe/` 的线框原型**，排布和视觉语言是 v3 重新设计的。

界面要支持多主题：主题（风格）与明暗是两个正交维度，主题差异全部收敛到变量层，组件只引用语义变量。结构见 `doc/TECH.md` 第 6 节。

## 12. 文档与原型

| 文件 | 内容 |
| --- | --- |
| `doc/PRD.md` | 需求文档。口径定义、全局规则、主页面四个模块、对话页、日志页、异常处理 |
| `doc/TECH.md` | 技术设计。采集触发、价格兜底、聚合刷新、代码规则、界面主题、接口 |
| `doc/PLAN.md` | 本文件。规划、数据源核实、里程碑 |
| `README.md` | 实现说明。命令、目录、加 agent 和加模型的方法 |
| `design/wireframe/` | 线框原型，三个页面：主页面（日历）、对话页、日志页。灰阶低保真，用来看结构和交互 |
| `config/pricing.json` | 手写成本表，唯一的定价来源 |
| `design/v3/` | 界面设计。`02-receipt.html` 是已定的主题，其余是备选方向 |

需求以 `doc/PRD.md` 为准，界面以 `design/v3/02-receipt.html` 为准，两者不冲突：PRD 定义「显示什么、怎么算」，设计稿定义「长什么样、怎么排」。
