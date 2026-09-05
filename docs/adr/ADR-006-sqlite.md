# ADR-006 — SQLite local persistence

## Status
Accepted; implementation detail updated by ADR-009.

## Decision
Use SQLite as the single local persistence layer for settings, sources, history, live data, EPG, reservations, favorites, health metrics and migrations.

## Note
The original design considered `better-sqlite3`; ADR-009 records the later decision to use Node 24 `node:sqlite` while preserving the same persistence boundary.
