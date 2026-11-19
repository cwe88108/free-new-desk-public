# Android Companion: built-in fixture vertical slice

**Development-only, APK built with official SDK tools; device execution is unverified. Not an Android source runtime.** This project is not part of the desktop installer or normal SourceEngine routing. Existing A2–A4 rejection stays in place.

## What the code implements

- Native Android activity and AndroidKeyStore TLS server, bound **only to 127.0.0.1:18765**. Nothing starts until the operator presses Start. No LAN listener, automatic adb, install, account login or security-setting changes.
- A fresh random 256-bit pairing token and SHA-256 certificate pin shown on the device. Desktop authenticates that exact pin before sending any token or RPC. Tokens and pins never go into URLs, logs, saved preferences or diagnostics. Pairing is revoked after ten minutes, Stop, activity backgrounding or restart. `FLAG_SECURE` prevents ordinary screenshots of the pairing screen.
- One two-minute session bound to the built-in profile, source ID and config revision. Re-init replaces the previous session. `destroy`, re-init and lease expiry close registered media streams and invalidate their random handles. Startup is serialized so repeated Start cannot leave an old listener competing for the new port. Requests have five-second deadlines, bounded headers/bodies, two workers and two queued slots.
- Built-in home/category/search/detail/play results and a generated two-second 440 Hz WAV. Media is exposed by an opaque session-bound handle with single byte ranges; no arbitrary URL, device file or localhost forwarding API exists.
- Node client and a probe exercising pinned TLS → init → fixture catalog → play → complete media digest → Range → destroy. No credentials/resources are included in probe output.

## Intentionally absent

This does **not** load external JAR/DEX, execute TVBox/FongMi Spiders, use WebView/JNI, fetch remote media, rewrite HLS, implement a general proxy, or integrate with libmpv. `externalCode`, `webview`, `jni` and `hls` are reported false. The built-in tone is an original test fixture, not a licensed third-party source.

Android app UID isolation is **not** plugin isolation. No untrusted code is allowed in this process. Before adding external code, implement a separately reviewed isolated worker, bounded broker, exact executable/dependency digest approval, resource leases and source corpus verification. A successful fixture probe does not meet those requirements or justify enabling A2–A4 routing.

The protocol deliberately has no external artifact upload. Its profile string identifies an installed fixture, not cryptographic authorization of a third-party executable. Verify the APK/build provenance separately. The pin proves possession of the paired local key, not the identity or integrity of a remote Android device.

## Build prerequisites and manual verification

The Gradle toolchain is JDK 17, Gradle 8.9, Android Gradle Plugin 8.7.3, Android SDK platform 35 and Build Tools 35.0.0. There is no vendored Gradle binary/wrapper or SDK. Install official tools and accept required SDK terms before use. For this development run the user explicitly approved the [Android SDK license](https://developer.android.com/studio/terms), and the official Platform 35 r2 and Build Tools 35.0.0 archives were verified against Google metadata. No system security settings were changed. From this directory:

```
gradle --no-daemon :app:assembleDebug
```

The Gradle build was attempted but dependency resolution failed because this JDK does not trust the environment's network certificate chain (PKIX). Certificate checking was not disabled and no truststore was modified.

Because this fixture has no external dependencies, an offline build with the already-verified official SDK tools succeeded:

```
JAVA_HOME=<jdk17> ANDROID_HOME=<sdk> node scripts/build-android-companion-fixture.mjs
```

This helper supports Windows and Unix. It runs javac with explicit UTF-8 encoding, D8 and apksigner through their SDK JARs, plus native aapt2 and zipalign, and writes `app/build/outputs/apk/fixture/companion-fixture.apk` with a companion `.apk.json` evidence file. Its temporary signing key is deleted at completion. Rebuilds therefore have different signing identities: uninstall the previous disposable test app before installing a rebuild. This is not release signing. Do not use it for application updates or production distribution.

A debug APK is only for a dedicated test device without personal data; it is not a safe third-party plugin host. Building and verifying the APK does not establish device execution.

1. Obtain an explicitly authorized dedicated device and already-authorized USB debugging connection. Do not enable public adb TCP. Device installation, pairing and persistent device access require the appropriate operator approval.
2. Build, inspect and install the APK through the normal approved Android workflow. Launch it and press Start. Keep its screen in the foreground.
3. On the chosen desktop, explicitly forward only the dedicated device's loopback port using the already-authorized USB connection: `adb -s <verified-device-serial> forward tcp:18765 tcp:18765`. Do not omit serial selection on multi-device hosts.
4. Transcribe the pin and token into a temporary owner-readable local JSON file, not source control, chat, shell history or a URL:

```
{"port":18765,"certificateSha256":"<64 lowercase hex characters shown on device>","token":"<43 character token shown on device>"}
```

5. Build source-engine, then run from the repository root:

```
node scripts/probe-android-companion.mjs <temporary-pairing.json> <new-result.json>
```

6. Record the output plus device API/ABI, OS version, APK SHA-256, build tool versions and device type (physical or emulator). Protect/redact serial numbers. The script will not overwrite earlier evidence.
7. Negative checks on the actual APK: wrong token/pin; stale/replaced session; Stop/Back/background while a request runs; USB unplug/reconnect; two-minute lease expiry; ten-minute pairing expiry; bad/multi/suffix/out-of-bounds range; oversized/incomplete request; repeated Start/Stop. Check no request crosses into a replacement session and no token reaches logs.
8. Stop the activity, remove only the explicit forwarding with `adb -s <verified-device-serial> forward --remove tcp:18765`, and delete the temporary pairing file. Uninstall the test build when finished. Normal Stop removes the generated keystore alias; process termination can leave an unreachable alias until the app data is cleared/uninstalled. No pairing token is persisted.

Do not record physical-device compatibility, Windows first frame/seek or third-party source support merely because the probe passed. HLS, external code, framework API coverage and playback remain separate release gates.

## Development verification (2026-11-03)

- Source-engine TypeScript build: passed.
- `node --test tests/unit/android-companion-fixture.test.mjs`: 8/8 passed against a local **Node TLS fixture**, not Android.
- Pure-Java helper tests (JDK 17.0.21): four groups passed for strict flat JSON grammar and permissive-parser bypass rejection, in-flight resource revocation/stale snapshots, repeated Start on the same real port, and Stop during startup. These are JVM tests, not Android/ART tests.
- Architecture lint and public-sanitization: passed.
- Complete Java compilation against official API 35 android.jar: passed.
- Offline official-SDK APK build and v2/v3 signature verification: passed. Manifest inspection shows only INTERNET, min API 26, target API 35 and a debuggable fixture app.
- Gradle build: attempted, blocked by JDK network certificate-chain trust; not a pass. No TLS verification bypass or truststore change.
- AndroidKeyStore handshake, ART, physical device/emulator and Windows PlayerHost: **not run**. No device or emulator was connected or started.
- Build provenance: APK SHA-256 `694b2a3cd27f0ae07f43c81ae83258d1597359bd4d9f876fb8943824ce422113`; see adjacent `.apk.json`. Archive hashes and verification details are recorded in `docs/runtime/android-companion-build.md`. Do not silently turn those missing stages into passes.

Test TLS certificates are generated temporarily with OpenSSL and removed. On machines without OpenSSL the seven TLS tests explicitly skip; the input-validation test still runs. Check skip counts in CI.

Run the Java safety helpers with JDK 17+ on PATH or JAVA_HOME:

```
node scripts/test-android-companion-helpers.mjs
```

These tests intentionally use ordinary JVM sockets and do not mock Android classes into an APK pass. A separate APK build and device run are still required.

References: [Android Keystore](https://developer.android.com/privacy-and-security/keystore), [isolated service semantics](https://developer.android.com/guide/topics/manifest/service-element).
