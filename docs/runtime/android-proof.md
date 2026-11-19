# Android runtime readiness: fail-closed preflight, not source compatibility

## Implemented

`android-runtime-plan.ts` is used by `JavaSpiderAdapter.init` **after executable bundle approval and before staging or JVM startup**. It inspects the entry and the reviewed manifest dependency graph, not only the entry JAR.

- A0: no detected Android dependency; retain the existing JVM route. This is a static eligibility decision, not proof that the Spider works or is safe.
- A2: DEX (including hybrid class/DEX archives), Android references, or Android manifest.
- A3: WebView or dynamic DEX loading.
- A4: detected JNI/native libraries or loadLibrary.
- A1 is deliberately not advertised: the shipped JVM host has no verified Android framework shim. Even Base64/Context references cannot be assumed to work.
- A2–A4 fail with `unsupported-runtime: android`, preserving existing `SRC_JAR_NEEDS_ANDROID` / pure-DEX `SRC_JAR_DEX_UNSUPPORTED` codes. No network bridge, automatic adb connection, device installation or code execution is attempted.
- Pure resource dependency JARs remain allowed; malformed directories and uninspectable executable entries fail closed. Diagnostics contain fixed capability names, never source URLs or raw class strings.

The scanner is heuristic and conservative. References in unused code may reject a source. Reflection, obfuscation, native behavior and runtime-generated names are not fully detectable. This guard is neither a sandbox nor an Android emulator. Existing code approval and OS isolation requirements still apply.

## Verification on this development environment

2026-11-03: no `adb` or `emulator` executable was available on PATH; no Android companion project/bridge exists in this repository. No Android device, ART execution, third-party Spider, Android media relay, Windows first frame or seek was tested.

Run after building source-engine:

```
node --test tests/unit/android-runtime-plan.test.mjs tests/unit/jar-inspector-v2.test.mjs tests/unit/executable-jar-manifest.test.mjs tests/unit/jar-spec.test.mjs
```

Fixtures are inert local ZIP bytes for static inspection, not executable Spider samples. Passing these tests establishes routing/rejection only.

## Remaining go/no-go gate for a real optional companion

1. Provide an explicitly authorized, dedicated device/emulator with no private data, plus a reviewed companion build and bounded profile. Record actual Android API level, CPU ABI, WebView version and host/profile version.
2. Establish authenticated pairing, short-lived source/config/digest/lease-bound sessions and an encrypted channel. Do not expose an unauthenticated LAN HTTP listener or persistent public adb TCP port.
3. Validate approved samples through init, home/category/search/detail/play, timeout, cancellation, disconnect and destroy. Native libraries require exact ABI evidence; a successful handshake is not compatibility proof.
4. Device localhost is not desktop localhost. Device-local media must become authenticated, scoped resource handles. Verify HLS relative manifests/keys/segments, Range, seek, expiry and cancellation before enabling playback routing.
5. Measure actual Windows first frame, continuous playback and seek against a fixed authorized corpus. DRM/device attestation/account restrictions remain unsupported unless the legitimate runtime itself provides them.

Until those gates have evidence, Android execution is **unavailable**, not experimental compatibility enabled by default. This patch intentionally does not add a nonfunctional bridge API or claim that a stub can replace ART/Context/WebView/JNI.

## Optional built-in transport slice (2026-11-03)

An independent native project now exists at `native/android-companion`. It implements a foreground-only loopback pinned-TLS fixture, a short-lived source/config-bound session and scoped WAV Range handles. See its README for the exact build, pairing and cleanup procedure. `services/source-engine/src/android-companion-fixture.ts` is an explicitly constructed test client; it is **not** registered with SourceEngine and does not change A2–A4 rejection.

Eight desktop protocol tests passed using Node TLS fixtures, and four pure-Java safety test groups passed on JDK 17.0.21 (startup serialization, stop fencing, resource revocation and JSON limits). This supersedes the earlier statement that there was no companion project, **not** the statement that no Android device/ART/media/Windows playback was tested. An APK was subsequently built with verified official SDK tools and its v2/v3 signature verified; Gradle dependency resolution failed on the environment's JDK certificate-chain trust. See `android-companion-build.md`. No Android device execution has run here. There is no external executable loader, isolated plugin worker, third-party digest approval or HLS relay; the only source is a built-in generated tone. It is a transport proof candidate, not source compatibility.
