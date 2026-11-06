# 桌面应用

桌面版是唯一的界面：双击图标就能用，不启动本地服务、不开监听端口，也没有浏览器版本。
数据库在 `~/Library/Application Support/ATracker/atracker.db`，和开发时用的
`data/atracker.db` 分开。

## 进程分工

应用分成三段，由 `electron.vite.config.ts` 分别构建到 `out/`：

| 进程 | 源码 | 产物 | 职责 |
| --- | --- | --- | --- |
| 主进程 | `packages/desktop/src/main/` | `out/main/index.js` | 窗口、菜单、单实例、`app://` 协议、IPC 注册；应用服务（数据库、扫描、监听、同步）也跑在这里 |
| preload | `packages/desktop/src/preload/` | `out/preload/index.cjs` | 用 `contextBridge` 暴露 `window.atracker`，只有四个方法 |
| 渲染进程 | `packages/web/` | `out/renderer/` | 页面本体，沙箱里跑，只能用 `window.atracker` 取数 |

主进程和页面之间用 IPC，不用 HTTP：没有端口，也就没有「同网段的机器能打开」这回事。
一次调用是 `{ method, path, params, body }`，主进程交给 `packages/service/src/handlers.ts`
按 `path` 分发，返回 `{ status, body }`。

页面在生产环境通过自定义协议 `app://atracker` 加载，不用 `file://`。原因是 `file://`
没有可用的 origin：`localStorage` 存不了（明暗模式、单位偏好靠它），也没法在响应头里加 CSP。
协议处理器把 `out/renderer` 映射成这个来源，并给每个响应加安全头。

`preload` 必须是 CommonJS：沙箱化的 preload 不支持 ESM，所以构建配置里把它的输出格式
固定成 `cjs`，文件名是 `index.cjs`。

## 开发与打包

```bash
npm run desktop            # 开发：前端热更新，主进程改动自动重启
npm run desktop:prod       # 用构建产物跑一遍，验证打包后的加载方式
npm run build              # 只构建到 out/
npm run pack:mac           # 只出 .app（不签名、不打包成 dmg），最快，用来验证
npm run dist:mac:unsigned  # 出未签名的 dmg 和 zip
npm run dist:mac           # 正式包：用钥匙串里的 Developer ID 签名，再打 dmg
npm run dist:win           # 出 Windows 安装包，要在 Windows 或 CI 上跑
```

`npm run desktop` 用的是仓库里的 `data/atracker.db` 和 `.dev-userdata/`，不会和
「应用程序」里装的那一份抢单实例锁，也不会覆盖它的窗口位置。

打包前会自动 `npm run build`，不用手动构建前端。产物都在 `release/`：

| 文件 | 说明 |
| --- | --- |
| `release/ATracker-<版本>-<提交>-arm64.dmg` | 安装包，双击拖进「应用程序」 |
| `release/ATracker-<版本>-<提交>-arm64.zip` | 同一份 .app 的压缩包，给不走 dmg 的分发渠道 |
| `release/mac-arm64/ATracker.app` | 解包后的 .app，只有 `pack:mac` 会留下 |

文件名第三段是目标架构，默认跟当前机器（Apple Silicon 上是 arm64）。要 x64 或 universal 就在命令后面加 `--x64` / `--universal`，这时需要能下载对应架构的 Electron。

`dist:mac*` 打完会删掉 `release/mac-arm64`，因为里面的 .app 会被 Spotlight 当成第二个应用，搜索里出现两个 ATracker。要留着排查问题就设 `ATRACKER_KEEP_APP_DIR=1`。

## 版本号

版本号来自 `package.json`，文件名第二段是当前提交的短哈希。工作区有未提交改动时哈希后面多一个 `-dev`，一眼能看出不是干净版本。

发版前用 `npm version minor`（新功能）或 `patch`（修 bug）走一步，它会改版本号并打好 tag；工作区脏的时候会拒绝执行。

`scripts/buildinfo.mjs` 会把版本、提交、分支、构建时间写进 `build/buildinfo.json`，打进包里的 `/api/status` 和日志页页脚都读它。这个文件不进版本库——它是构建产物，进了库反而会让工作区永远是脏的。主进程启动时用环境变量 `ATRACKER_BUILDINFO` 告诉 `core/build.ts` 去哪儿找它：bundle 之后模块位置不再等于源码位置，靠相对路径会算错。

## 数据放哪

重构前后路径没变，升级安装不会丢数据，也不会触发迁移：

| 东西 | 位置 |
| --- | --- |
| 数据库 | `~/Library/Application Support/ATracker/atracker.db` |
| 窗口位置和大小 | 同目录下的 `window-state.json` |
| 本机身份 | `~/.atracker/device.json` |
| 同步目录等配置 | `~/.atracker/config.json` |
| 多设备同步文件 | 配置里指定的目录（默认 iCloud Drive 下的 `ATracker/`） |

开发时数据库改用仓库里的 `data/atracker.db`，用户数据目录改用 `.dev-userdata/`。
`ATRACKER_DB` 可以把库指到任意路径，冒烟检查用它指到临时文件。

## 壳做了什么

- 单实例：已经在跑就激活原窗口。系统层面还设了 `LSMultipleInstancesProhibited`，防止从 dmg 和「应用程序」各起一个
- 记窗口位置和大小，下次打开还原；首次打开取工作区的 80%，宽度限制在 1000～1400 之间
- 中文菜单，多设备同步的开关和目录选择都挂在「文件」下
- 关窗即退出（不驻留托盘）
- 页面里的外链交给系统浏览器，只放行 http/https；页面内跳转只允许留在 `app://atracker` 和开发服务器的来源上

## 冒烟检查

构建之后可以自己跑一遍端到端检查，窗口不显示，跑完打印一行结果：

```bash
npm run build
ATRACKER_SMOKE_TEST=1 ATRACKER_DB=/tmp/smoke.db npx electron . --user-data-dir=/tmp/smoke-userdata
```

输出 `SMOKE PASS {...}`、退出码 0 表示通过。它检查页面挂载、`window.atracker` 存在、
一次 IPC 取数返回 200、`localStorage` 可读写。详细说明见[开发](development.md)。

## 签名与分发

未签名的包第一次打开需要右键「打开」。要给别人用又不想让对方看到安全提示，就得有 Apple Developer ID 签名并公证，`npm run dist:mac` 走这条路，需要钥匙串里已经有证书。
