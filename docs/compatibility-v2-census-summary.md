# V2 JAR Census summary

Real-sample decision set: 13 JARs.

| Classification | Count |
| --- | ---: |
| JVM | 0 |
| Clean DEX candidates | 2 |
| Native | 1 |
| Android-required | 8 |
| Invalid/upstream invalid | 2 |

The Android/WebView/JNI/native proportion exceeds the V2 Gate C threshold. Free New Desk therefore keeps formal dex2jar/Android-runtime emulation disabled on Windows and focuses on deterministic detection, diagnostics and safe rejection. `scripts/jar-census.mjs` now also emits Android and CatVod API reference rankings for future sample sets.
