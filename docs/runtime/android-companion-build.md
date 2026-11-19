# Android Companion fixture build evidence — 2026-11-03

This is a built-in transport/audio fixture, not a third-party Android source runtime. No device, emulator, ART execution, AndroidKeyStore handshake or Windows playback was tested.

## Provenance

SDK license acceptance was explicitly approved by the user before installing Platform 35 or Build Tools. Tools were installed into an isolated development directory, without global PATH, security, virtualization or truststore changes.

| Component | Official origin | Verification |
|---|---|---|
| JDK 17.0.21 | Existing isolated official Eclipse Adoptium installation | javac/java 17.0.21 executed |
| SDK Platform 35 r2 | `https://dl.google.com/android/repository/platform-35_r02.zip` | SHA-1 `0bb560a90a7a2cbd0dd8348224d518b638fe7949` matches Google repository metadata |
| SDK Build Tools 35.0.0 Linux | `https://dl.google.com/android/repository/build-tools_r35_linux.zip` | SHA-1 `2cfaa0bbb2336e9ec18ed3ecea84fa2e2af607bc` matches Google repository metadata |
| Gradle 8.9 | `https://downloads.gradle.org/distributions/gradle-8.9-bin.zip` | SHA-256 `d725d707bfabd4dfdc958c624003b3c80accc03f7037b5122c4b1d0ef15cecab` matches official checksum |

Additional SHA-256 observations (Google metadata published SHA-1, not these SHA-256 values):

- Platform ZIP: `0988cacad01b38a18a47bac14a0695f246bc76c1b06c0eeb8eb0dc825ab0c8e0`.
- Build Tools ZIP: `bd3a4966912eb8b30ed0d00b0cda6b6543b949d5ffe00bea54c04c81e1561d88`.

## Actual results

1. Full Android Java sources compiled against official `platforms/android-35/android.jar`: passed.
2. Four pure-Java helper groups on JDK 17: passed. Covers strict flat JSON grammar (including single-quote/comment deep-nesting bypass attempts), revocation, repeated Start on the same port, and Stop during startup. These are not Android runtime tests.
3. Eight desktop client tests using Node TLS fixtures: passed. These are not Android device tests.
4. Gradle `assembleDebug`: attempted, not passed. Dependency resolution could not establish trusted TLS in the local JDK (`PKIX path building failed`). No certificate validation bypass, insecure repository or truststore edit was used.
5. Offline dependency-free APK pipeline using official tools: passed. `javac → D8 → aapt2 → jar → zipalign → apksigner`; script: `scripts/build-android-companion-fixture.mjs`.
6. APK verification: v2 and v3 signatures pass; one signer. Min SDK 26, target/compile SDK 35, package `org.freenewdesk.companion`, version `0.1.0-fixture`; only INTERNET permission, debuggable. The short-lived fixture signing key was deleted after building. This is not a release signature or an upgrade channel.

Output: `native/android-companion/app/build/outputs/apk/fixture/companion-fixture.apk`.

APK SHA-256: `694b2a3cd27f0ae07f43c81ae83258d1597359bd4d9f876fb8943824ce422113`.

The adjacent `.apk.json` records build scope and explicitly marks device execution `not-run` and third-party sources `unsupported`. Any later source change requires rebuilding and recording a new hash. A build pass cannot substitute for running the procedure in `native/android-companion/README.md` on an authorized dedicated device.

## Windows rebuild — 2026-11-09

The helper now supports Windows executable suffixes, explicit UTF-8 javac source encoding and direct SDK JAR entry points for D8/apksigner. Built on this Windows machine with existing JDK 17 and installed Platform/Build Tools 35, without dependency downloads or truststore changes. APK size: 24983 bytes; SHA-256 f97f9513c4ec678ba81e4a92920e3c9bcb15b63b78797e596d065e1efe335f98. APK v2/v3 verification passed; INTERNET is the only requested permission. This supersedes the earlier Linux APK hash for the new local Windows output, not the historical build record.

Android device installation/execution is still pending explicit device approval and operator pairing. Three local Java helper groups pass; the resource-revocation group fails at a Windows localhost socket connection timeout. The combined helper command remains failed. See optimization-v157-capabilities-20261109.md for scope and remaining gates.
