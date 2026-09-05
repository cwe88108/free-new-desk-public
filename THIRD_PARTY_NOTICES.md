# Third-Party Notices

Free New Desk is a clean implementation. Third-party dependencies retain their own licenses.

| Name | Version | License | Source | Bundled |
| --- | --- | --- | --- | --- |
| Electron | 44.0.0 | MIT | https://github.com/electron/electron | Yes |
| Vue | 3.5.20 | MIT | https://github.com/vuejs/core | Yes |
| Pinia | 3.0.3 | MIT | https://github.com/vuejs/pinia | Yes |
| Vue Router | 4.5.1 | MIT | https://github.com/vuejs/router | Yes |
| Zod | 3.25.76 | MIT | https://github.com/colinhacks/zod | Yes |
| mpv / libmpv | 0.41.0 | GPL-2.0-or-later by default; LGPL-2.1-or-later for LGPL builds | https://github.com/mpv-player/mpv/releases/tag/v0.41.0 | Windows package |

SQLite persistence uses the `node:sqlite` module embedded in Node.js/Electron. It does not add a separate npm native addon to the package.

The Windows CI retrieves the pinned official mpv v0.41.0 x86_64 MSVC release archive and verifies SHA-256 `4e197f729f5071c6772f35fffd96e0f36e3e8a044bd9479b136bb09b7c6a80ff` before extracting `libmpv-2.dll`. No nightly URL is used.

Source adapters are independently implemented from documented protocol behavior. No FongMi/TV or zyfun source code is copied into this repository.

## Compatibility protocol references

TVBox configuration shell compatibility is independently implemented from observable public protocol behavior. No third-party TVBox source code is bundled or copied into Free New Desk; the implementation uses Node.js built-in crypto primitives only.
