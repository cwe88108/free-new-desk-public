# ADR-008 — Trust levels and privileged boundaries

## Status
Accepted.

## Decision
Declarative CMS/T4/XYQ/XBPQ/M3U/AList sources are Level A. Executable JS/Node/Drpy/JAR/plugin sources are Level B and are imported disabled until the user explicitly trusts/enables them.

Renderer has `nodeIntegration=false`, `contextIsolation=true`, `sandbox=true`, `webSecurity=true`. IPC senders are validated. External navigation is allowlisted. Remote images use the `fnd-image://` cache/proxy protocol rather than direct Renderer networking.
