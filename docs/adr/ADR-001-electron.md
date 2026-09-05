# ADR-001 — Electron + Vue 3 + TypeScript

## Status
Accepted.

## Context
The product is a Windows-first desktop media platform requiring a mature desktop shell, strong web UI productivity, controlled IPC, native sidecars and GitHub Actions packaging.

## Decision
Use Electron for the application shell, Vue 3 for Renderer UI and TypeScript for contracts/services. Renderer runs without Node integration and reaches privileged capabilities only through Preload IPC.

## Consequences
Electron Main remains orchestration-only; heavy source parsing and untrusted execution are moved to isolated processes. The application accepts Electron's memory cost in exchange for faster Windows delivery and mature tooling.
