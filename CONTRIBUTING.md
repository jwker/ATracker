# 参与

这个项目是本地跑的小工具，代码量不大，欢迎修改和提 PR。

## 开发环境

需要 Node 24 以上。`npm install` 之后：

```bash
npm run typecheck    # 服务端和前端各跑一遍 tsc，CI 会跑这个
npm run serve        # 构建前端并起服务，默认 4178
npm run dev:web      # 只起 Vite，改前端时更快
```

## 提交之前

1. `npm run typecheck` 通过。
2. 改了采集器的话，跑 `node packages/cli/src/index.ts reconcile`，把对账结果贴进 PR 描述。它拿各来源自己写在日志里的汇总数据和采集结果逐项比，不一致说明口径错了。
3. 不要提交 `data/`、`release/`、`packages/web/dist/`、`build/buildinfo.json`——都在 `.gitignore` 里，别用 `-f` 绕过。

## 改采集器的注意事项

五个来源的日志格式都不规范，每条规则都是踩过坑换来的。动手前先读[容易踩的坑](docs/pitfalls.md)，尤其这几条：

- codex 每轮要用 `total_token_usage` 的增量，`input_tokens` 含缓存，要减掉 `cached_input_tokens`。
- Claude Code 一条消息可能写成多行，要按 `message.id` 去重。
- opencode 有新旧两套存储格式，两张表都读会翻倍。

改了采集器的解析逻辑，把采集器的 `version` 加一位：游标里存的是 `agent:version`，版本对不上会自动全量重扫。

## 代码规则

- 采集器只读，不写任何 agent 的目录。
- 单位换算只在 `packages/core/src/units.ts`，时间分桶只在 `packages/core/src/time.ts`，别在组件里自己算。
- 前端不引图表库，柱状图和热力图用 CSS 和表格画。
- 服务端和前端之间只通过 `packages/server/src/queries.ts` 的载荷形状通信。

## 提交信息

一句话说清楚改了什么、为什么。如果修复的是某个具体现象，把现象写进正文（比如"10 月 31 号有数据但卡片柱子到 30 号就没了"），比写"修 bug"有用得多。
