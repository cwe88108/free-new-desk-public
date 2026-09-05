# Free New Desk V2 兼容增强完成状态

基线：V1.4.7（Windows 11 x64）

## 阶段状态

- P0 Playback Resolver：完成。HTTP 页面不再按协议名直接视为媒体；Content-Type/Redirect 探测、provider flag、playUrl/playerType、mpv -17 单次 fallback 和脱敏 resolver 日志均已落地。
- S0 Jar Inspector 2.0：完成。真实 Census 已检查 13 个 JAR：JVM 0、可继续研究的纯 DEX 2、native 1、Android-required 8、invalid 2；WebView/JNI/动态加载比例超过 40%，触发 Gate C。
- S1 Config Unshell：完成当前已确认协议。支持 plain、base64-star、普通 hex、hex-dollar AES-CBC，以及 URL ;pk; 显式 key 的 AES-ECB；未知 dollar shell 返回 SRC_CONFIG_DECRYPT_FAIL，不再猜 MD5/SHA256/raw key。
- S2：按 Gate C 收口。正式 dex2jar + Android/CatVod Runtime Shim 不立项；.so/WebView/DexClassLoader 在执行前拒绝，纯 DEX 保持 SRC_JAR_DEX_UNSUPPORTED。
- S3：CI、Windows x64、Packaged Electron、PlayerHost lifecycle、100/125/150% DPI 与高对比度继续作为发布门。诊断包包含 playback-runtime.json 与 jar-runtime.json。

## 运行时边界

Free New Desk 不实现 Android VM、WebView 仿真、JNI .so 或二级动态 DEX。Java Spider 仅运行可在纯 JVM 边界内工作的来源，并要求 Java 17+。设置页会显示实际探测到的 Java 命令路径与版本。

## 配置加密协议依据

V1.4.7 不再使用试探式 AES key 派生。hex-dollar CBC 与 ;pk; ECB 行为依据公开 TVBox 客户端中可观察到的配置协议独立实现；实现只复现协议行为，不复制第三方源代码。

## Census 决策

13 个真实 JAR 的样本结果已满足 V2 的 12–20 样本门槛。由于 Android-required/native 比例显著高于 40%，继续建设“半个 Android Runtime”与 V2 的 Gate C 冲突，因此 DEX Runtime Shim 不作为完成条件。
