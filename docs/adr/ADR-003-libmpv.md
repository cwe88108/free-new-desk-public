# ADR-003 — libmpv native playback

## Status
Accepted.

## Decision
Playback is provided by an independent C++20 PlayerHost using pinned Windows x64 `libmpv-2.dll`, D3D11 and a Named Pipe protocol. HTML5 video is not the sole playback engine.

## Consequences
PlayerHost can crash/restart independently of Electron. libmpv upgrades are pinned and require playback regression testing and license review.
