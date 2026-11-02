# 桌面应用

Web 版要开终端起服务。桌面版是同一个服务外面套一层 Electron 壳，双击图标就能用，数据库放在 `~/Library/Application Support/ATracker/atracker.db`，和开发时的 `data/atracker.db` 分开。

## 开发与打包

```bash
npm run desktop            # 开发：在 Electron 里跑，用仓库的 data/atracker.db
npm run pack:mac           # 只出 .app（不签名、不打包成 dmg），最快，用来验证
npm run dist:mac:unsigned  # 出未签名的 dmg 和 zip
npm run dist:mac           # 正式包：用钥匙串里的 Developer ID 签名，再打 dmg
npm run dist:win           # 出 Windows 安装包，要在 Windows 或 CI 上跑
```

打包前会自动 `npm run build:web`，不用手动构建前端。产物都在 `release/`：

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

`scripts/buildinfo.mjs` 会把版本、提交、分支、构建时间写进 `build/buildinfo.json`，打进包里的 `/api/status` 和日志页页脚都读它。这个文件不进版本库——它是构建产物，进了库反而会让工作区永远是脏的。

## 壳做了什么

`packages/desktop/src/main.ts` 只做这几件事：

- 起本地服务，挑一个空闲端口，然后加载 `http://127.0.0.1:<port>`
- 单实例：已经在跑就激活原窗口。系统层面还设了 `LSMultipleInstancesProhibited`，防止从 dmg 和「应用程序」各起一个
- 记窗口位置和大小，下次打开还原；首次打开取工作区的 80%，宽度限制在 1000～1400 之间
- 中文菜单，多设备同步的开关和目录选择都挂在「文件」下
- 关窗即退出（不驻留托盘）

## 签名与分发

未签名的包第一次打开需要右键「打开」。要给别人用又不想让对方看到安全提示，就得有 Apple Developer ID 签名并公证，`npm run dist:mac` 走这条路，需要钥匙串里已经有证书。
