# V1.4.8 release checklist

> 所有项目仅在最终产品提交对应的 CI / Windows 运行成功后勾选；临时补丁 workflow 的运行结果不作为发布验收证据。

- [ ] source bulk controls pass
- [ ] playback navigation/state pass
- [ ] native surface owner/generation pass
- [ ] PlayerHost concurrent command/query pass
- [ ] progressive search success-only pass
- [ ] failed source retry remains available outside the main result groups
- [ ] VOD resolved-playback TTL cache and stale-cache retry pass
- [ ] LIVE last-known-good route and fallback pass
- [ ] VOD/LIVE mpv cache profiles pass on real PlayerHost media load
- [ ] performance-runtime diagnostics export pass
- [ ] Windows x64 package pass
- [ ] packaged lifecycle and recovery pass
- [ ] 100/125/150% DPI and high contrast pass
- [ ] GPT screenshot review pass
- [ ] final main CI and Windows release build pass
- [ ] v1.4.8 Setup/Portable release assets verified
