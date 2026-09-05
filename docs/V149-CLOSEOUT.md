# V1.4.9 DoD closeout

This release closes the remaining V1.4.8 enhancement-plan gaps.

- Primary Live playback routes to Player; page-local playback is explicitly Preview.
- Search main UI renders successful results only; failed and timed-out sources remain diagnostic-only and do not create retry chips in results.
- Player/Live native surfaces await release on route leave and enforce a 200 ms packaged-smoke budget.
- Main navigation enforces a 100 ms packaged-smoke budget; playback navigation is instrumented against 150 ms.
- Runtime diagnostics aggregate latest/P95 navigation, playback, first-frame, buffering and native-surface timings.
- Native PlayerHost media load is accepted immediately, exposes `load-status`, and keeps query/control responsive while libmpv opens media.
- Windows Named Pipe validation uses locally generated media and enforces <=200 ms load acceptance, query and stop response budgets, plus asynchronous failure-state validation.
- GitHub Windows runners do not expose a normal audio device. The null audio output is therefore available only through the explicit `--test-audio-output null` PlayerHost launch option. The desktop passes it only when `FND_UI_SMOKE=1`; normal production launches do not change the audio output backend.
- VOD, Live and Search keep a bounded in-memory Pinia page snapshot so short route round-trips restore state without immediately re-fetching third-party sources.
- The bulk-source integration gate executes a single SQLite transaction across 500 VOD/live sources and requires the transaction itself to complete within two seconds.
- Packaged UI validation loads real local media through PlayerHost and repeats Live -> Player -> Search -> Player while checking embedded PlayerHost HWND visibility, geometry and release at 100%, 125% and 150% DPI (including high-contrast mode).

## Local validation

- GPT desk Linux validation: `npm run verify` passed with architecture lint, workspace type checks, JVM SpiderHost JAR compilation, 116/116 unit and integration tests, production renderer build, and packaged renderer path verification.
- Production dependency audit: `npm audit --omit=dev --audit-level=high` reported 0 vulnerabilities.
- Windows-only PlayerHost compilation, EXE packaging, real-media HWND smoke, multi-DPI and high-contrast screenshots still require a Windows x64 environment and are not represented by the Linux result above.
