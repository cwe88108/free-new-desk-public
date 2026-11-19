# Dependency security maintenance (2026-11-03)

## Changes

- Electron 44.7.0 → 44.9.1, the first patched release in the existing major for [GHSA-jr5w-w6x2-84p9](https://github.com/advisories/GHSA-jr5w-w6x2-84p9).
- Zod 3.25.76 → 4.6.7 in all three manifests. [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) requires at least 4.6.6. The code uses Zod 4 directly, not the vulnerable v3 compatibility entrypoint.
- Undici 6.29.0 → 6.29.1 and 7.30.0 → 7.30.1, within each caller's existing compatible semver range.
- fast-uri 3.1.8 → 3.1.9, within the existing compatible range.

No forced audit fix, dependency downgrade or broad major-version override was used. Lockfile changes retain unrelated platform metadata.

## Zod migration compatibility

Four string dictionaries now explicitly declare both key and value schemas. The favorites error formatter accepts Zod 4's `PropertyKey[]` issue paths and explicitly converts segments to strings. Added `tests/unit/contracts-zod4.test.mjs` exercises source/live headers, category filters, IPC unions, optional fields, playback bounds/refinements, favorite timestamp normalization, rename trimming and import limits. Existing favorites tests also remain part of the full suite.

## Audit result and remaining exposure

The full dependency audit reports **0 high, 0 critical and 15 moderate dependency nodes**. The production-only audit reports **0 vulnerabilities**. These counts describe the npm dependency graph, not a guarantee that the application is vulnerability-free.

The remaining moderate nodes are the development-time Electron packaging chain affected by [minimatch GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). The advisory lists `<11.0.1`; dependencies currently require minimatch major versions 3, 5, 9 and 10. In particular, `@electron/asar` calls the old callable default export, which is not interchangeable with modern named exports. A blanket override to 11 could break packaging. npm's suggested downgrade of electron-builder to 20.23.1 is deliberately not applied.

Registry metadata for the newer electron-builder/app-builder-lib 26.18.0 still requires minimatch `^10.2.5`, `@electron/asar` 3.4.1 and `@electron/universal` 2.0.3, so updating that package alone does not resolve this chain.

Keep build configuration/glob inputs trusted and wait for compatible upstream packaging updates, or undertake a separately tested packaging migration. Do not claim an all-severity clean audit or suppress these findings. The existing `npm audit --audit-level=high` gate remains in place.

Windows native packaging, installed-app startup and playback must still be verified on Windows; Linux TypeScript/unit checks do not substitute for those checks.

## Verification

- `npm audit --audit-level=high`: exit 0.
- `npm audit --omit=dev --json`: zero vulnerabilities.
- Full `npm run build` and all-workspace type checking passed (the JVM build requires the configured JDK on `PATH`).
- Full unit/integration suite with JDK on `PATH`: 467 tests, 466 passed, 1 Windows-only test skipped, 0 failed. A prior run concurrent with compilation timed out in the Python detached-descendant test (500 ms request deadline); the final non-concurrent run passed without changing that test.
- Architecture lint, public sanitization and renderer package-path verification passed.
