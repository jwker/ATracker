# ATracker 实现说明

本机 AI 编码 agent 的 token 用量看板。只读采集各 agent 的本地日志，不加钩子、不改 agent 行为、不上传数据。

## 跑起来

```bash
npm install          # 安装 React/Vite 构建依赖；服务端运行时仍零依赖
npm run scan         # 扫描本机日志，写入 data/atracker.db
npm run stats        # 看累计用量
node packages/cli/src/index.ts doctor     # 看各来源是否可读
node packages/cli/src/index.ts reconcile  # 拿各来源自带的汇总数据对账
npm run serve       # 构建前端并起本地服务，默认端口 4178
```

Node 24 以上直接跑服务端 TypeScript，不需要构建步骤。前端是 React + Vite，`npm run serve` 会先构建，构建产物在 `packages/web/dist`。

## 文档

| 文件 | 内容 |
| --- | --- |
| `doc/PRD.md` | 需求文档。显示什么、怎么算 |
| `doc/TECH.md` | 技术设计。采集触发、厂商归类、聚合刷新、代码规则、接口 |
| `doc/PLAN.md` | 规划。各来源核实结果、里程碑、待定项 |
| `design/v3/` | 界面设计。`02-receipt.html` 是已定的主题 |
| `design/today/` | 当日详情页设计稿 |
| `design/wireframe/` | 功能线框原型 |

## 日常使用

```bash
npm run serve       # 构建前端并起服务，浏览器打开 http://127.0.0.1:4178
npm run dev:web     # 只起 Vite 开发服务器，/api 代理到 4178
npm run scan        # 手动扫一次（服务在跑的时候不用，文件变了会自动扫）
node packages/cli/src/index.ts doctor    # 看各来源状态和缺价模型
```

## 局域网访问

`npm run serve` 默认监听 `0.0.0.0`，启动时会把本机在局域网里的地址打出来，例如 `http://192.168.3.25:4178`。同一个 Wi-Fi 下的手机、平板可以直接打开这个地址，页面和接口都能用，开发服务器 `npm run dev:web` 也是监听所有网卡的。

只给本机看就加 `--host 127.0.0.1`：

```bash
node packages/cli/src/index.ts serve --host 127.0.0.1
```

注意这个服务是只读的，但里面是本机所有 agent 的用量和目录路径。同一局域网内的设备都能打开，不在可信网络里的时候用 `--host 127.0.0.1` 关掉。

服务端会监听五个来源目录，文件变了自动采集；每 5 分钟兜底轮询一次，监听丢的事件由它补上。扫描是增量的，第二次只花 50 毫秒左右。

## 目录

```
packages/
  core/src/
    types.ts     UsageEvent 等公共类型
    units.ts     三种数字单位，全站只在这里换算
    catalog.ts   模型 → 厂商
    palette.ts   目录 → 颜色，颜色跟随实体不跟随排名
    time.ts      时区与日期分桶
  storage/src/
    schema.sql   建表
    repo.ts      写入、聚合维护、查询
  collectors/src/
    types.ts     采集器契约
    zstd.ts      zstd 多帧读取
    codex/       codex 采集器
    scanner.ts   采集编排：算价、落库、维护聚合
  server/src/
    queries.ts   接口载荷，字段形状对齐 design/v3/_core.js
    app.ts       HTTP 路由、SSE 推送、文件监听、静态文件
  web/
    index.html   Vite 入口
    src/
      main.tsx   挂载
      App.tsx    页面状态、取数、路由参数
      views/     总账 / 月度 / 今日 / 会话 / 日志五个视图
      components/ 页头等公共组件
      receipt.css 主题变量与组件样式（热敏小票）
    dist/        构建产物，服务端直接托管
  cli/src/
    index.ts     命令行
    reconcile.ts 对账
data/atracker.db     运行时生成
```

当前前端用 React 19 + Vite，保留 `design/v3/02-receipt.html` 的热敏小票样式。后续改动都在 `packages/web/src` 上做。

## 加一个 agent

1. 在 `packages/collectors/src/<id>/index.ts` 写采集器，实现 `Collector` 接口。
2. 采集器只做一件事：读文件、产出 `UsageEvent`。不碰数据库、不改格式。
3. 在 `scanner.ts` 的 `COLLECTORS` 数组里加一行注册。

## 现在的状态

- 五个采集器都已实现并对账通过：codex 和 opencode 与来源自带的汇总精确一致，Claude Code、pi、DeepSeek Harness 在双方都覆盖的会话上全部一致。
- 接口已完成：`atracker serve` 提供只读接口、文件监听自动扫描和 SSE 推送。清单见 `doc/TECH.md` 第 6.4 节。
- 前端已完成：React 19 + Vite 实现，保留 `design/v3/02-receipt.html`（热敏小票）的样式，总账、月度、今日、会话、日志五个视图都接了真数据。总账看全期，月度看一个月或一个选区（日历在这一页）。会话页是两级菜单：上面一条目录，下面一条该目录下的会话，选中的目录写进 URL。

## 为什么没有金额

看板只统计 token，不折算成本。成本算不准不是实现问题，是口径问题：

- 订阅制（opencode-go、minimax-cn-coding-plan 这类）不按量计费，单价无从谈起。
- 同一个模型名在不同渠道下价格不同，`MiniMax-M3.1-Flash` 在 `minimax-cn`、`minimax`、`minimax-cn-coding-plan` 三条渠道下的计费方式完全不一样。
- 模型和价格都变得快，维护一张价格表注定滞后；阶梯价和波峰波谷又让单价随调用时刻变化。

这几种口径加总出来的数字看着精确到分，实际没有可比性，所以整块去掉了。token 是各 agent 自己记的，采集器只做单位归一，能复核，看板上只留这个。

## 桌面应用

```bash
npm run desktop    # 直接在 Electron 里跑，开发时用仓库的 data/atracker.db
npm run dist:mac   # 出 release/ATracker-<版本>-arm64.dmg 和 .zip
npm run dist:win   # 出 Windows 安装包，需要在 Windows 或 CI 上跑
```

打包后的应用把数据库放在用户数据目录（macOS 是 `~/Library/Application Support/ATracker/atracker.db`），首次启动会自动扫一遍本机日志，不需要手动跑 `npm run scan`。

外壳只有 `packages/desktop/src/main.ts` 一个文件：主进程里 `import ATrackerServer`，起一个只监听 `127.0.0.1`、端口随机的本地服务，再把窗口指过去。服务端代码没有为桌面版改写，也没有 IPC，所以 `npm run serve` 和桌面版跑的是同一套代码。数据目录、监听地址、端口都由 main 传入。

几个注意点：

- **包是未签名的。** 本机构建没配证书，第一次打开要右键 →「打开」，或者 `xattr -dr com.apple.quarantine /Applications/ATracker.app`。要正经分发就配好 Developer ID 和 `notarytool` 凭据，再跑 `npm run dist:mac`。
- **Electron 二进制要先下载。** `npm install` 之后如果 `node_modules/electron/dist` 是空的，说明下载被墙了，用镜像补一次：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`。
- **打包不联网拉 Electron。** `electron-builder.yml` 里 `electronDist` 指向 `node_modules/electron/dist`，用本地这份。
- **图标还是 Electron 默认的。** 要换就放 1024px 的 `build/icon.png`（mac 用 512 以上的 icns/png），electron-builder 会自动转。

## 采集器的版本号

改了采集器的解析逻辑就把 `version` 往上加一位。游标里存的是 `agent:version`，版本对不上时这个来源的文件会自动全部重扫，不用手动清库。

## 四个容易踩的坑

**codex 的每轮用量要用 `total_token_usage` 的增量，不能用 `last_token_usage`。** 一轮里可能有多次 API 调用，`last_token_usage` 只记最后一次。实测一个 61 轮的会话两者相差 4 万 token。

**codex 的 `input_tokens` 含缓存命中部分。** 要减掉 `cached_input_tokens` 才是未缓存输入。别的来源（Claude Code、pi、opencode、DeepSeek Harness）报的都是不含缓存的口径。

**Claude Code 的同一条消息会写成多行。** 一条 assistant 消息按内容块分行写，每行带同一份 usage，要按 `message.id` 去重，否则用量翻倍。

**DeepSeek Harness 一个会话目录里有多个版本文件。** 只读编号最高的那个，全加起来会重复计算。

**opencode 有两代存储格式。** 同一个库里旧表 `session`/`message` 和新表 `session_v2`/`session_message` 存着同一批会话，两张都读会翻倍。会话被压缩后旧消息不在消息表里了，只在会话汇总列里，差出来的量要按四个桶补一条事件。

详见 `doc/PLAN.md` 第 3.1 节。
