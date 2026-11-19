# Security Policy

## 核心安全边界

1. Renderer 必须保持 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true`。
2. 不可信 Spider 代码不得进入 Electron Main 或 Renderer。
3. Source Engine 与未来 Spider Worker 采用独立进程隔离。
4. 本地代理只允许绑定 `127.0.0.1`，并使用随机会话令牌。
5. 日志不得输出 Cookie、Authorization、Token、密码或完整敏感源地址。
6. 第三方 JS/Drpy 兼容层采用 clean implementation，不通过开放 Node 原生 `fs` / `child_process` 来换兼容性。

安全问题请使用 GitHub 仓库的私密漏洞报告功能（若维护者已启用）。不要在公开 Issue 中提交令牌、私人来源地址、诊断包或可利用细节。
