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

| 文件                  | 内容                                                   |
| --------------------- | ------------------------------------------------------ |
| `doc/PRD.md`        | 需求文档。显示什么、怎么算                             |
| `doc/TECH.md`       | 技术设计。采集触发、厂商归类、聚合刷新、代码规则、接口 |
| `doc/PLAN.md`       | 规划。各来源核实结果、里程碑、待定项                   |
| `design/v3/`        | 界面设计。`02-receipt.html` 是已定的主题             |
| `design/today/`     | 当日详情页设计稿                                       |
| `design/wireframe/` | 功能线框原型                                           |

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
npm run desktop            # 开发：直接在 Electron 里跑，用仓库的 data/atracker.db
npm run pack:mac           # 只出 .app（不签名、不打包成 dmg），最快，用来验证
npm run dist:mac:unsigned  # 出未签名的 release/ATracker-<版本>-arm64.dmg 和 .zip
npm run dist:mac           # 正式包：用钥匙串里的 Developer ID 签名，再打 dmg
npm run dist:win           # 出 Windows 安装包，要在 Windows 或 CI 上跑
```

打包前会自动 `npm run build:web`，不用手动构建前端。产物都在 `release/`：

| 文件                                 | 说明                                        |
| ------------------------------------ | ------------------------------------------- |
| `release/ATracker-0.1.0-arm64.dmg` | 安装包，双击拖进「应用程序」                |
| `release/ATracker-0.1.0-arm64.zip` | 同一份 .app 的压缩包，给不走 dmg 的分发渠道 |
| `release/mac-arm64/ATracker.app`   | 解包后的 .app，验证时直接双击这个           |

默认按当前机器架构打包（Apple Silicon 上是 arm64）。要 x64 或 universal 就在命令后面加
`--x64` / `--universal`，这时需要能下载对应架构的 Electron。

## 分享卡片

三个页面都有「分享卡片 →」，点了弹出一个弹窗，**只显示一张卡**，跟着来源页走：

| 入口 | 卡片 | 柱子 |
| --- | --- | --- |
| 总账 | 全期卡 | 按月（6 个月就 6 根） |
| 月度 | 范围卡 | 按天（当月 30 根、选区 N 根） |
| 今日 | 今天卡 | 按小时（0–23 点） |

每张卡的高峰（用量最大的那个月 / 那一天 / 那一小时）标红。弹窗里「保存图片」导出 1080×1920 PNG，「关闭」或按 ESC 退出，点遮罩也能关。

两张都是 1080×1920（9:16），页面上按 320 宽预览，各自的「保存这张」导出 PNG。

实现上不引第三方截图库：`packages/web/src/card/render.ts` 直接用 canvas 画（文字、点线、柱状图），网页版和桌面版走同一条路。纸的高度按内容算——模型多的时候纸会自己拉长，实测每多一个模型多 15px（预览），画面上限 6 行模型。

**调用次数只有本机有**：同步过来的聚合里没有这个字段，所以切到「全部设备」或别的设备时，卡片上「N 次调用」这一段会自动去掉。

## 版本号怎么加

这个项目现在会装到两三台机器上，所以要能一眼看出「这台跑的是哪一版」。

**规则**（开发期用 `0.x`）：

| 什么时候 | 怎么做 | 例子 |
| --- | --- | --- |
| 只提交、不装机 | 不动版本号 | — |
| 要装到机器上的修复 | `npm version patch` | 0.1.1 → 0.1.2 |
| 一个能说清楚的新功能 | `npm version minor` | 0.1.2 → 0.2.0 |
| 给别人用、接口稳定了 | `npm version major` | 0.9.0 → 1.0.0 |

打包时 `scripts/buildinfo.mjs` 会把**版本号 + git 提交 + 构建时间**写进 `build/buildinfo.json`，跟着包一起打进去。应用里两处能看到：

- 日志页最底部的版本行：`ATracker 0.1.1 · 提交 3f2a1c9 · 11-02 12:30 构建`
- 「关于 ATracker」面板

两台机器对比时**看提交哈希比看版本号准**——版本号只在装机的那次跳，哈希每次提交都变。

一次完整的发版流程：

```bash
npm version patch          # 改 package.json，并建一个 commit（不加 tag 也行）
npm run dist:mac:unsigned  # 自动带新版本号 + 当前提交
open release/ATracker-<新版本>-arm64.dmg
```

`electron-builder` 的 `--dir` 模式（`npm run pack:mac`）不产出安装包，但也会刷新 buildinfo，适合只看「这一版对不对」。

打包后的应用把数据库放在用户数据目录（macOS 是 `~/Library/Application Support/ATracker/atracker.db`），首次启动会自动扫一遍本机日志，不需要手动跑 `npm run scan`。

**窗口尺寸**：默认取屏幕工作区宽度的 80%（夹在 1000–1400 之间）和高度 92%（上限 1200），这块屏幕上就是 1210×820，小票两侧各留 195px 桌面。拖过之后尺寸和位置记在 `~/Library/Application Support/ATracker/window-state.json`，下次沿用；删掉这个文件就回到默认值。位置只在还落在某块屏幕里时才恢复，换了显示器不会跑到屏幕外。

外壳只有 `packages/desktop/src/main.ts` 一个文件：主进程里 `import ATrackerServer`，起一个只监听 `127.0.0.1`、端口随机的本地服务，再把窗口指过去。服务端代码没有为桌面版改写，也没有 IPC，所以 `npm run serve` 和桌面版跑的是同一套代码。数据目录、监听地址、端口都由 main 传入。

几个注意点：

- **包是未签名的。** 本机构建没配证书，第一次打开要右键 →「打开」，或者 `xattr -dr com.apple.quarantine /Applications/ATracker.app`。要正经分发就配好 Developer ID 和 `notarytool` 凭据，再跑 `npm run dist:mac`。
- **Electron 二进制要先下载。** `npm install` 之后如果 `node_modules/electron/dist` 是空的，说明下载被墙了，用镜像补一次：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`。
- **打包不联网拉 Electron。** `electron-builder.yml` 里 `electronDist` 指向 `node_modules/electron/dist`，用本地这份。
- **图标**：源文件是 `build/icon.svg`——强调红 `#bf3b22`（和页面里的红同一个值）铺满整个圆角画布，上面一张米色小票，三行内容（深色、浅灰、加粗的深色）。没有透明边距。改完跑 `npm run icon` 重新生成 `build/icon.png`（1024px），打包时 electron-builder 自动转成 icns / ico。
- **菜单**：应用菜单、文件（重新扫描 ⌘R、打开数据目录）、编辑、视图（重新加载页面 ⇧⌘R、开发者工具）、窗口，都是中文。
- **重复副本**：macOS 没有安装登记，复制一份 `.app` 就是第二份，系统层面挡不住「装第二次」。能挡的是同时运行：Info.plist 里带 `LSMultipleInstancesProhibited`（第二份会由系统拒绝启动），应用内还有单实例锁兜底。另外，如果从 `/Applications` 以外的地方启动而 `/Applications` 里已经有一份，会弹提示告诉你两份的路径和版本。

## 设备标识

一台机器一个 id，存在 `~/.atracker/device.json`（首次运行自动生成，名字默认取主机名，可以直接改文件里的 `name`）：

```json
{ "id": "4179855c-…", "name": "my-macbook", "platform": "darwin" }
```

命令行和桌面版共用这一份——两者的数据库不同（`data/atracker.db` 和 `~/Library/Application Support/ATracker/atracker.db`），但设备是同一台，身份不该跟着库走。

库里每个维度都带 `device`：`usage_event.device` 记这一行是哪台机器产生的，四张 `agg_day_*` 的主键都变成 `(day, device, …)`。升级时历史行会被自动认领给本机，不用手动迁移。

`GET /api/devices` 返回本机身份、身份文件路径，以及库里出现过的设备列表。日志页的诊断区会显示本机设备名和 id 前 8 位。

`ATRACKER_DEVICE_FILE` 可以指定身份文件位置（测试用）。

## 多设备同步

每台设备把自己的数据写成一个目录里的 rollup 文件，读别人的文件把数字汇总到本机库。**文件各管各的，谁都不改别人的**；「合并」只发生在查询阶段。

```bash
# 服务端自动同步：扫描完写自己的文件，启动时和每 60 秒读别人的文件
atracker serve --sync-dir ~/.atracker/sync

# 也可以手动跑一次
atracker sync export [--dir <目录>]
atracker sync import [--dir <目录>]
```

同步目录的优先级：`--sync-dir <路径>` > `--sync`（用 iCloud 默认目录 `~/Library/Mobile Documents/com~apple~CloudDocs/ATracker`）> `ATRACKER_SYNC_DIR` > `~/.atracker/config.json` 里的 `syncDir`。都没有就关掉，不读也不写。

桌面版在「文件 → 多设备同步」里开关，切换时写到 `~/.atracker/config.json`，不用重启。开关用的是当前配置的目录；没配过就是 iCloud 默认目录，所以不改任何设置也能直接用。「文件 → 同步目录…」可以换成任意文件夹，选完自动打开同步。文件按「设备 + 月」拆，`atracker-<设备id>-<月>.jsonl`，每个几十 KB。

日志页有一块「多设备同步」面板：目录、上次导出、上次对表（读了几份文件、导入了多少行）、错误，以及每台设备的最后写入时间、改名 / 忽略 / 恢复。**忽略**会删掉本机库里这台设备的行并停止导入，同步目录里对方写的文件不动，随时可以恢复。

`GET /api/sync` 返回同步状态：目录、上次导出时间和文件、上次导入读了多少文件、导入了哪些设备。

设备切换条在库里有超过一台设备时出现，总账、月度、今日三页都有。**默认只算本机**——不带 `device` 参数时接口按本机返回，「全部设备」要显式写 `?device=all`。今日页会按范围区分：切到别的设备时，小时图、最大的几次调用、采集状态整块隐藏（这些依赖逐轮明细，不同步），顶部给一句说明。

会话页把本机和远端的会话合在一起列。远端会话带设备名标签，点进去显示汇总，逐轮明细那一段替换成「明细在那台设备上」的说明。

文件是 JSONL，三种行：`device`（设备自述）、`agg`（日级聚合，`k` 区分 agent / dir / model / agent_model 四种维度）、`session`（会话汇总）。目录字段是绝对路径。

导入按「设备 + 月」整块替换（先删再插），重复导入幂等。本机自己的文件会被跳过——本机的数据本来就该从明细重算。重建聚合时只重算「明细里有数据的设备」，所以本机重扫不会把远端设备的行删掉（这条专门验过）。

### 两台机器怎么配起来

前提：两台机器登录同一个 Apple ID，并且都打开了 iCloud Drive（系统设置 → Apple 账户 → iCloud → 「iCloud 云盘」）。没开的话，菜单里勾选同步会弹提示，勾自动弹回去。

**第一台（比如这台 Mac）**

1. 装好 ATracker（dmg 拖进「应用程序」），打开。
2. 菜单「文件 → 多设备同步（iCloud）」勾上。
3. 打开「日志」页，往下有一块「多设备同步」：
   - 「同步目录」应该是 `…/com~apple~CloudDocs/ATracker`
   - 「上次导出」显示「刚刚 · N 个文件」
   - 设备列表里只有这一台，标着「（本机）」
4. 到 Finder 里打开 iCloud Drive → ATracker，应该能看到 `atracker-<设备id>-<月>.jsonl`，一个月一个文件，每个几十 KB。

**第二台（另一台 Mac）**

1. 同样装好、打开。
2. 同样勾上「多设备同步（iCloud）」。**路径不用填**——勾选时它会算出这台机器自己的 iCloud 路径（`~/Library/Mobile Documents/com~apple~CloudDocs/ATracker`），写到这台机器的 `~/.atracker/config.json` 里。两台机器上的路径字符串不一样，但指的是云端的同一个文件夹。
3. 等 iCloud 把第一台的文件同步过来（几十秒到几分钟，取决于文件大小和网络），然后等最多 60 秒让 ATracker 对一次表。
4. 「日志」页的同步面板里会出现两台设备，各自的「最后写入」时间。总账、月度、今日三页的导航下面会出现设备切换条：`全部设备 / 这台（本机）/ 那台`。

**验证通了没有**：在两台机器的「总账」页看「全期」那行，覆盖天数和总量应该一致（切到「全部设备」时）。不一致就看「上次对表」的时间和「错误」那一行。

**没生效时按这个顺序查**

| 现象 | 先看什么 |
| --- | --- |
| 勾选后同步面板说目录不存在 | iCloud Drive 没开，或者 iCloud 目录被改名了 |
| 面板里只有本机，没有对方 | 对方的文件还没写到 iCloud；或者 iCloud 还没把它同步下来（在 Finder 里看 iCloud Drive/ATracker 里有没有对方的文件） |
| 有对方文件但设备列表里没有 | 看「上次对表」是不是几十秒内；「错误」有没有内容 |
| 有对方设备但数字不对 | 切到「全部设备」再看；确认两台机器的时区都是 Asia/Shanghai（写死在 `core/time.ts`） |
| 同一个项目在两台机器上分成两个目录 | 目录按绝对路径归并，`/Users/a/proj` 和 `/Users/b/proj` 就是两条记录，这是设计如此 |
| 点开对方的会话没有逐轮明细 | 明细不同步，只同步标题、轮次数、四桶和总量 |

**想换一个同步目录**（Syncthing、Dropbox、局域网共享盘）：桌面版菜单「文件 → 同步目录…」选一个文件夹即可，选完自动打开同步，当前路径会显示在菜单项的右侧。也可以手动改 `~/.atracker/config.json` 的 `syncDir`，或者用下面的命令行方式。

**不开桌面版时**（比如远程登录一台服务器）用命令行，效果一样：

```bash
# 第一台
atracker serve --sync            # --sync 用 iCloud 默认目录
# 或者指定任意目录（Syncthing、Dropbox 都行）
atracker serve --sync-dir ~/Sync/ATracker
```

只想同步一次、不开服务：`atracker sync export` 写自己的文件，`atracker sync import` 读别人的。

### 什么会上传，什么不会

| 数据 | 会不会进同步文件 |
| --- | --- |
| 每天每来源每模型每目录的 token 汇总 | 会 |
| 会话标题、轮次数、四桶、总量 | 会 |
| 目录绝对路径（含用户名和项目结构） | 会 |
| 每一条调用的逐轮明细（时间、模型、四个桶） | 不会，只留在本机 |
| 提示词和回答的正文 | 从来不采集，也不上传 |

同步目录是 iCloud Drive 里的普通文件夹，Apple 会把它同步到同一账号的其它设备。不同账号、或者不想走 iCloud 的时候，把 `--sync-dir` 指到任何共享目录（Syncthing、Dropbox、局域网共享盘）就行，格式一样。

## 采集器的版本号

改了采集器的解析逻辑就把 `version` 往上加一位。游标里存的是 `agent:version`，版本对不上时这个来源的文件会自动全部重扫，不用手动清库。

## 四个容易踩的坑

**codex 的每轮用量要用 `total_token_usage` 的增量，不能用 `last_token_usage`。** 一轮里可能有多次 API 调用，`last_token_usage` 只记最后一次。实测一个 61 轮的会话两者相差 4 万 token。

**codex 的 `input_tokens` 含缓存命中部分。** 要减掉 `cached_input_tokens` 才是未缓存输入。别的来源（Claude Code、pi、opencode、DeepSeek Harness）报的都是不含缓存的口径。

**Claude Code 的同一条消息会写成多行。** 一条 assistant 消息按内容块分行写，每行带同一份 usage，要按 `message.id` 去重，否则用量翻倍。

**DeepSeek Harness 一个会话目录里有多个版本文件。** 只读编号最高的那个，全加起来会重复计算。

**opencode 有两代存储格式。** 同一个库里旧表 `session`/`message` 和新表 `session_v2`/`session_message` 存着同一批会话，两张都读会翻倍。会话被压缩后旧消息不在消息表里了，只在会话汇总列里，差出来的量要按四个桶补一条事件。

详见 `doc/PLAN.md` 第 3.1 节。
