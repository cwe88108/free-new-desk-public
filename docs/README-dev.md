# Free New Desk

Free New Desk 是一个面向 **Windows 11 x64** 的 TVBox / FongMi 风格桌面影音播放器。软件本身**不内置任何第三方影视源**，只提供用户自有或已获授权配置的导入、解析、直播、节目表与播放能力。

## V1.4.9 功能与兼容增强

- 直播主播放操作统一进入嵌入式播放器，页内播放明确标记为预览；点播、直播和搜索页面支持短时状态恢复。
- PlayerHost 异步接受媒体加载请求，媒体打开期间仍可查询状态、停止播放和同步原生窗口，并导出首帧、缓冲与 P95 性能指标。
- 打包 UI 验证使用本地真实媒体，覆盖 PlayerHost HWND 的显示、尺寸、隐藏、释放以及重复离开/进入播放器生命周期。

- 内置豆瓣回退源：当豆瓣类 JAR 来源的 Spider 类不在 JAR 中（ClassNotFoundException）时，来源引擎自动回退到内置豆瓣适配器（浏览 / 搜索 / 详情 / 官方预告片播放），并在来源审计报告中显示回退说明。
- Windows 11 / Fluent 风格 x64 桌面界面，Electron Renderer 与原生播放器、来源执行环境保持隔离。
- 可直接粘贴 TVBox / FongMi 配置 URL、原始 `sites` / `lives` JSON，也可选择本地配置文件导入；支持相对路径和常见注释 / 尾逗号配置。
- CMS XML / JSON、Type4（标准 GET + Base64 `ext`）、T4、JS / Node Spider、Drpy、XYQ、XBPQ、AList，以及可选 JVM Spider / Plugin Host 执行路径。
- 兼容 FongMi 常见 Spider 生命周期：`homeContent`、`homeVideoContent`、`categoryContent`、`detailContent`、`searchContent`、`playerContent`，并标准化 TVBox 原始 `class/list/vod_*` 返回。
- 点播支持分类、筛选、分页、搜索、详情、收藏、播放历史、播放线路和剧集列表；`searchable=0` 只关闭搜索，不会误停整个来源。
- 来源页按接口、规则 / 网盘、Spider / 可执行来源和直播来源分组；支持整组启用 / 停用、来源健康检测、Source Audit 与 JSON 审计报告导出。
- 站点级 `header` 会贯穿来源请求和最终播放；直播支持 `#EXTVLCOPT`、`#EXTHTTP`、JSON Header 和 `URL|User-Agent=...&Referer=...` 等常见请求头写法。
- M3U / TXT / JSON 直播，重复频道自动归并为多线路；支持 XMLTV / gzip EPG、后台刷新、最近刷新状态、当前节目、节目预约和直播收藏。
- HTTP(S) 直播线路支持预检测速、启动前优选与播放失败线路回退；RTMP / RTSP / UDP 保留原协议交给 libmpv。
- 独立 C++ `PlayerHost` + 动态 LGPL libmpv，原生视频窗口按 Player 页面的视频区域嵌入 Electron 主窗口，而不是作为独立播放器窗口显示。
- 播放器支持 H.264 / HEVC / HLS / DASH / MPEG-TS 等 libmpv 可解码媒体，以及 Header、字幕、音轨、硬件解码、全屏、PiP、暂停、Seek、音量、倍速、音视频延迟、画面比例和截图。
- 播放历史会保存可重播所需的来源、线路、episodeId、海报和剧集快照；播放器支持带缩略图的最近观看队列、点击继续、保存 / 清空队列，以及基于真实剧集快照的上一集 / 下一集。
- 设置页提供稳定版 / 每日更新通道、最近更新检查时间、分项缓存统计和单项清理、日志 / 临时目录入口、JVM / Plugin / libmpv 运行信息和最近诊断事件。
- 自动更新只检查本仓库 `cwe88108/free-new-desk-public` 的 GitHub Releases；稳定版使用正式 Release，每日通道可检查预发布版本。
- 可选 JVM SpiderHost：独立 Java Sidecar，支持纯 JVM 常见 JAR Spider 反射调用；**不承诺依赖 Android Context / DexClassLoader 的 JAR 100% 兼容**。
- Plugin SDK / Plugin Host：本地插件清单、网络权限白名单、独立进程 + `vm` 隔离；不包含插件市场。

## V2 影视仓兼容状态

V1.4.7 完成 V2 方案的纯 Windows 收口：Playback Resolver 会区分媒体直链与网页/解析地址，并对 mpv -17 做一次安全回退；TVBox 导入保留 playUrl/playerType，支持明文、base64-star、普通 hex、已确认的 hex-dollar AES-CBC 与 ;pk; AES-ECB 配置协议；未知加密壳明确拒绝，不再轮猜密钥算法。JAR Inspector 会区分 JVM/DEX/native/Android-required，并基于真实 Census 触发 Gate C：WebView/JNI/动态 DEX 来源不在 Windows JVM 内模拟。

| 类型 | V1.4.7 状态 |
| --- | --- |
| 明文 TVBox JSON | Fully supported |
| base64-star / 普通 hex | Supported |
| hex-dollar AES-CBC / ;pk; AES-ECB | Supported（确定协议） |
| 未知加密壳 | Detected / Unsupported |
| Type-1 CMS 直链 | Fully supported |
| Type-1 CMS 网页可嗅探 | Supported |
| DRM / 登录鉴权线路 | Limited |
| 纯 JVM Spider | Supported（需 Java 17+） |
| 纯 DEX Spider | Limited（Gate C 后保持受限） |
| JNI .so / WebView / 动态二级 DEX | Android required |

详见 `docs/compatibility-v2-status.md`。

## 安全边界

- Renderer：`nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true`。
- JS Spider、JAR Spider、Plugin 均不得进入 Renderer；可执行来源按 Level B 处理并默认不自动启用。
- 来源网络统一经 RequestBroker，Cookie 按 `sourceId + host` 隔离，站点默认 Header 按 `sourceId` 隔离。
- 本地代理只绑定 `127.0.0.1` 随机端口并使用随机 Bearer Token。
- 日志不输出 Cookie、Authorization、Token 或完整敏感播放地址。
- 软件不内置第三方影视源，也不从旧 Free-Desk / FreeBox 项目继承更新地址。

## 开发与验证

要求 Node.js 24。JVM SpiderHost 的编译需要 JDK 17；运行 JAR 来源时本机需要可用的 Java 17+，也可以通过 `FREE_NEW_DESK_JAVA` 指定 `java.exe`。

```bash
npm ci
npm run verify
```

对外部 TVBox / FongMi 配置做结构兼容烟测（不会自动执行未知 JAR）：

```bash
node scripts/source-compat-smoke.mjs <config-url> [more-config-urls...]
```

Windows x64 原生播放器与发行包：

```powershell
cmake -S native/player-host -B native/player-host/build -A x64
cmake --build native/player-host/build --config Release
powershell -ExecutionPolicy Bypass -File scripts/prepare-mpv.ps1
powershell -ExecutionPolicy Bypass -File scripts/test-player-host.ps1
npm audit --omit=dev --audit-level=high
npm run package:win
npm run smoke:packaged
powershell -ExecutionPolicy Bypass -File scripts/test-packaged-ui.ps1
```

`package:win` 会先构建全部 workspace，再运行 `prepare-runtime-workspaces.mjs`，将内部 `@free-new-desk/*` 包复制到发行 staging 的标准 `node_modules` 布局。Windows GitHub Actions 会编译 x64 PlayerHost、准备固定来源的 LGPL libmpv 运行时、执行 Named Pipe 测试、打包 Setup / Portable、真实启动打包后的应用，并通过 DOM 导航依次渲染和截图首页、点播、直播、搜索、播放器、收藏、历史、来源、设置共 9 个主要页面。只有这些发布门通过后，`main` 才发布 Windows x64 EXE。

## 发布与更新

应用只检查并打开本仓库自己的 Releases：`cwe88108/free-new-desk-public`。当前公共版本为 **v1.4.9**；发布标签使用 SemVer，例如 `v1.4.9`。公共版发行包在本地 Windows 环境编译后上传到对应 GitHub Release。

## 许可证与第三方组件

本仓库自身许可证见 `LICENSE`。第三方组件与 libmpv 构建来源见 `THIRD_PARTY_NOTICES.md` 和 `third_party/mpv/win-x64/SOURCE.txt`（构建时生成）。
