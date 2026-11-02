# 开发

## 目录结构

```
packages/
  core/src/
    types.ts        UsageEvent 等公共类型
    units.ts        三种数字单位，全站只在这里换算
    catalog.ts      模型 → 厂商
    palette.ts      目录 → 颜色，颜色跟随实体不跟随排名
    time.ts         时区与日期分桶
    device.ts       本机设备身份
    config.ts       ~/.atracker/config.json
    build.ts        读构建信息（版本、提交）
  storage/src/
    schema.sql      建表
    repo.ts         写入、聚合维护、查询
    sync.ts         多设备同步文件的导出与导入
  collectors/src/
    types.ts        采集器契约
    zstd.ts         zstd 多帧读取
    scanner.ts      采集编排：落库、维护聚合
    codex/          codex 采集器
    claude-code/    Claude Code 采集器
    pi/  opencode/  dsh/  其余三个
  server/src/
    queries.ts      接口载荷
    app.ts          HTTP 路由、SSE 推送、文件监听、静态文件
  web/
    index.html      Vite 入口
    src/
      main.tsx      挂载
      App.tsx       页面状态、取数、路由参数
      views/        总账 / 月度 / 今日 / 会话 / 日志五个视图
      components/   页头、四桶、模型矩阵、同步面板等公共组件
      card/         分享卡片的取数与绘制
      receipt.css   主题变量与组件样式（热敏小票）
  cli/src/
    index.ts        命令行
    reconcile.ts    拿各来源自带的汇总数据对账
  desktop/src/
    main.ts         Electron 壳
```

运行时零依赖：服务端只用 Node 自带模块，SQLite 走 `node:sqlite`，采集 zstd 用自己的帧遍历器。`dependencies` 里的 React 只用于构建前端。

## 常用命令

```bash
npm run scan         # 扫一次本机日志
npm run stats        # 打印累计用量
npm run typecheck    # 服务端和前端各跑一遍 tsc
npm run serve        # 构建前端并起服务，默认 http://127.0.0.1:4178
npm run dev:web      # 只起 Vite 开发服务器，/api 代理到 4178
```

命令行子命令：`scan`、`stats`、`doctor`、`reconcile`、`sync export|import`、`serve`。

## 加一个 agent

1. 在 `packages/collectors/src/<id>/index.ts` 写采集器，实现 `Collector` 接口。契约见[架构第 2.2 节](architecture.md#22-采集器契约)。
2. 采集器只做一件事：读文件、产出 `UsageEvent`。不碰数据库，不改格式。
3. 在 `scanner.ts` 的 `COLLECTORS` 数组里加一行注册。

`COLLECTORS` 是显式的数组，不是扫目录再动态 import：打包成单个可执行文件之后，扫目录的假设就不成立了。

新采集器要自己带 fixture 测试，跑通再合并——五个来源的日志格式都改过不止一次。

## 采集器的版本号

改了采集器的解析逻辑就把 `version` 往上加一位。游标里存的是 `agent:version`，版本对不上时这个来源的文件会自动全部重扫，不用手动清库，也不用写迁移。

## 加一个模型

只在 `packages/core/src/catalog.ts` 的规则表里加一行（模型名 → 厂商）。这张表只在采集器没上报厂商时兜底，上报了原样用。

## 代码规则

- 采集器不许写任何 agent 的目录，只读。
- 单位换算只在 `core/units.ts` 里做，组件里不许自己除 1e8。
- 时间分桶只在 `core/time.ts` 里做。
- 服务端和前端之间只通过 `server/src/queries.ts` 的载荷形状通信，前端不直接拼 SQL。
- 前端不引图表库，柱状图和热力图都用 CSS 和表格。

## 测试

`npm run typecheck` 是 CI 会跑的硬门槛。采集器部分靠 `reconcile` 对账：拿各来源自己在日志末尾写的汇总，和采集出来的结果逐项比。改采集逻辑之后一定要跑一遍，不一致就说明口径错了。
