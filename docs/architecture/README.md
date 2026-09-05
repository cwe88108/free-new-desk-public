# Free New Desk 工程落地架构

本仓库按《Windows TVBox 桌面播放器软件架构设计 v1.1》初始化。正式目标为 Windows 11 22H2+ x64，技术主线为 Electron 44.x + Vue 3 + TypeScript + Node.js Source Engine + Native C++20 PlayerHost + libmpv。

## 进程边界

```text
Vue Renderer (sandbox)
        │ preload narrow API
        ▼
Electron Main ───────────────► player-host.exe x64 ─► libmpv/D3D11
        │                            Named Pipe
        ▼
Source Engine utilityProcess
        │
        ├─ SourceAdapter / CMS JSON/XML
        └─ CatVod Runtime Shim（后续 Spider Worker）
```

四条硬约束：UI 与 Spider 分离；Spider 与 Player 分离；不可信远程脚本绝不进入 Electron Main/Renderer；V1.0 只做 Windows 11 x64。

## V0.1 本次实现

- npm workspaces Monorepo；Electron Main / Preload / Vue Renderer；Windows 11 Fluent 风格导航与 Mica；
- Renderer 安全边界；Source Engine 独立 utilityProcess；Contracts、RequestBroker、CMS JSON/XML、CatVod Runtime Shim 基线；
- C++20 player-host.exe、Windows Named Pipe、libmpv 运行时动态加载；
- Unit / Integration fixture tests；CI、Windows x64 Build、Release 三条 GitHub Actions。

## 暂不宣称完成

正式 Source Manager/SQLite、CMS 完整协议、TVBox config、Live/EPG、T4/Drpy/Node Spider、XYQ/XBPQ/AList、Sniffing/Proxy、固定来源与 SHA-256 的 libmpv 二进制以及 PlayerHost 嵌入窗口继续按 v1.1 分阶段实现。

## CI Definition of Done

初始化提交要求 architecture lint、strict typecheck、CMS JSON/XML 单测、Source Engine integration、Vite build、Windows x64 CMake PlayerHost build 和 Electron x64 package build 全绿。
