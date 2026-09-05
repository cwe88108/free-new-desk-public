# Security Policy

## 核心安全边界

1. Renderer 必须保持 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true`。
2. 不可信 Spider 代码不得进入 Electron Main 或 Renderer。
3. Source Engine 与未来 Spider Worker 采用独立进程隔离。
4. 本地代理只允许绑定 `127.0.0.1`，并使用随机会话令牌。
5. 日志不得输出 Cookie、Authorization、Token、密码或完整敏感源地址。
6. 第三方 JS/Drpy 兼容层采用 clean implementation，不通过开放 Node 原生 `fs` / `child_process` 来换兼容性。

安全问题请通过仓库私有 Issue 报告，不要在公开渠道披露可利用细节。
