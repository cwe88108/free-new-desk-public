# ADR-004 — Source and Spider process isolation

## Status
Accepted.

## Decision
Source orchestration runs in an Electron utility process. Executable JS/Drpy sources run in dedicated Spider worker processes with timeout, memory limits and a centralized HTTP broker. Workers are created on demand, limited to four active executable adapters, and reclaimed when idle.

## Security
Executable sources are Level B trust and must not execute in Renderer or Electron Main.
