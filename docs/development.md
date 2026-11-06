# 开发

## 目录结构

```
packages/
  core/src/
    types.ts        UsageEvent 等公共类型
    api.ts          主进程与页面之间的调用形状（IPC 契约）
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
  service/src/
    service.ts      扫描编排、文件监听、多设备同步、事件推送
    handlers.ts     接口分发：一次调用进，一个结果出
    queries.ts      接口载荷
  desktop/src/
    main/index.ts   窗口、菜单、单实例、app:// 协议
    main/ipc.ts     IPC 注册与参数校验
    preload/index.ts 暴露 window.atracker
  web/              渲染进程源码
    index.html      页面入口
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
```

三段的边界：`service` 只管应用逻辑，不知道界面怎么来的；`desktop` 只做窗口、菜单和
IPC 桥接；`web` 只调用 `window.atracker.request`，不 import 任何 Node 的东西。

构建产物在 `out/main`、`out/preload`、`out/renderer`，由 `electron.vite.config.ts` 生成，
不进版本库。

## 常用命令

```bash
npm run scan         # 扫一次本机日志
npm run stats        # 打印累计用量
npm run typecheck    # 主进程/服务层和前端各跑一遍 tsc
npm test             # 跑单元测试（Node 自带的 test runner，不引依赖）
npm run build        # 只构建，不启动
npm run desktop      # 起 Electron：前端热更新，主进程改动自动重启
npm run desktop:prod # 用 out/ 里的构建产物跑（验证打包后的加载方式）
```

命令行子命令：`scan`、`stats`、`doctor`、`reconcile`、`sync export|import`。

`npm run desktop` 用仓库里的 `data/atracker.db` 和 `.dev-userdata/` 作为用户数据目录，
和「应用程序」里装的那一份互不影响：不会抢单实例锁，窗口位置也不会互相覆盖。

## 加一个 agent

1. 在 `packages/collectors/src/<id>/index.ts` 写采集器，实现 `Collector` 接口。契约见[架构第 2.2 节](architecture.md#22-采集器契约)。
2. 采集器只做一件事：读文件、产出 `UsageEvent`。不碰数据库，不改格式。
3. 在 `scanner.ts` 的 `COLLECTORS` 数组里加一行注册。

`COLLECTORS` 是显式的数组，不是扫目录再动态 import：打包成单个 bundle 之后，扫目录的假设就不成立了。

新采集器要自己带 fixture 测试，跑通再合并——五个来源的日志格式都改过不止一次。

## 采集器的版本号

改了采集器的解析逻辑就把 `version` 往上加一位。游标里存的是 `agent:version`，版本对不上时这个来源的文件会自动全部重扫，不用手动清库，也不用写迁移。

## 加一个模型

只在 `packages/core/src/catalog.ts` 的规则表里加一行（模型名 → 厂商）。这张表只在采集器没上报厂商时兜底，上报了原样用。

## 加一个接口

1. 在 `packages/service/src/queries.ts` 里写载荷函数（只查库，不碰界面）。
2. 在 `handlers.ts` 里加一条 `path` 分发。
3. 在 `packages/web/src/types.ts` 里声明载荷类型，在 `packages/web/src/api.ts` 里加一个方法。

IPC 通道是固定的，不需要为新接口加通道，也不要为了省事把整个 Node 模块暴露到 preload。

## 代码规则

- 采集器不许写任何 agent 的目录，只读。
- 单位换算只在 `core/units.ts` 里做，组件里不许自己除 1e8。
- 时间分桶只在 `core/time.ts` 里做。
- 界面和主进程之间只通过 `service/src/queries.ts` 的载荷形状通信，前端不直接拼 SQL。
- 前端不引图表库，柱状图和热力图都用 CSS 和表格。
- 渲染进程是沙箱：没有 `process`、`fs`、`ipcRenderer`。要用主进程的能力，加在 preload 里。

## 测试

`npm run typecheck` 和 `npm test` 是 CI 会跑的硬门槛。

测试用 Node 自带的 `node --test`，不引测试框架。采集游标的那几个用例在
`packages/collectors/src/scanner.test.ts`，覆盖的是「文件被追加、内容被改写、
行写到一半」这几种情况——游标推进方式不对，内容不是延迟一轮读到，是再也读不到，
所以这几个用例要钉住。

采集器部分靠 `reconcile` 对账：拿各来源自己在日志末尾写的汇总，和采集出来的
结果逐项比。改采集逻辑之后一定要跑一遍，不一致就说明口径错了。

## 端到端冒烟检查

构建之后，可以让应用自己加载一遍页面并检查桥接、接口和 `localStorage`：

```bash
npm run build
ATRACKER_SMOKE_TEST=1 ATRACKER_DB=/tmp/smoke.db npx electron . --user-data-dir=/tmp/smoke-userdata
```

窗口不显示，跑完打印一行 `SMOKE PASS {...}`，退出码 0 表示通过。检查四件事：页面挂载了、
`window.atracker` 存在、一次 IPC 取数返回 200、`localStorage` 可读写。打包后的
`.app` 也能用同样的方式跑，把 `npx electron .` 换成 `release/mac-arm64/ATracker.app/Contents/MacOS/ATracker`。

`--user-data-dir` 必须给一个临时目录：默认目录和「应用程序」里装的那份共用单实例锁，
不带这个参数会弹一句「ATracker 已经在运行」然后停在那里。
