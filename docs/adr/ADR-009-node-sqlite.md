# ADR-009: Use Node 24 built-in SQLite for V0.1 persistence

## Status

Accepted during V0.1 Windows x64 validation.

## Context

Architecture v1.1 selected SQLite and preferred `better-sqlite3`. The first V0.1 implementation used `better-sqlite3` 13.0.3 and passed Linux CI. On the GitHub-hosted Windows runner with Node 24.19, npm reported no matching Windows x64 prebuilt binary, fell back to node-gyp/MSVC, and failed compiling the bundled SQLite amalgamation with MSVC C2026 (`string too big, trailing characters truncated`). The Visual Studio toolchain and Python discovery themselves succeeded.

Electron 44 embeds Node.js 24.18.1. Node 24 provides the built-in `node:sqlite` module and synchronous `DatabaseSync` API needed by the single-machine Data Service.

## Decision

Keep SQLite as the storage engine but replace the external `better-sqlite3` native addon with Node/Electron's built-in `node:sqlite` implementation.

The Data Service remains the only owner of database access. Renderer, Source Engine adapters and PlayerHost boundaries are unchanged.

## Alternatives considered

1. Keep rebuilding `better-sqlite3` from source on every Windows build. Rejected because the current Windows toolchain fails inside the dependency's SQLite amalgamation and would keep V0.1 coupled to a fragile native-addon build.
2. Run CI on an older Node version. Rejected because Electron 44 embeds Node 24 and this would not validate the actual runtime boundary.
3. Switch to JSON persistence. Rejected because it would abandon the architecture's SQLite data model, transactions and migration path.

## Impact

- Removes one external native npm dependency and Electron ABI rebuild risk.
- Keeps the schema, SQLite files and Data Service API unchanged.
- Requires Node/Electron 24+, already part of the project baseline.
- `node:sqlite` is release-candidate stability in Node 24, so database behavior remains covered by integration tests and can be revisited in a later ADR if needed.

## Migration

This decision occurs before a public V0.1 release. Existing development `app.db` files remain standard SQLite and require no schema migration.
