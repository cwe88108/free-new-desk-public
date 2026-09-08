# Third-Party Notices

Free New Desk is a clean implementation. Third-party dependencies retain their own licenses.

| Name | Version | License | Source | Bundled |
| --- | --- | --- | --- | --- |
| Electron | 44.0.0 | MIT | https://github.com/electron/electron | Yes |
| Vue | 3.5.20 | MIT | https://github.com/vuejs/core | Yes |
| Pinia | 3.0.3 | MIT | https://github.com/vuejs/pinia | Yes |
| Vue Router | 4.5.1 | MIT | https://github.com/vuejs/router | Yes |
| Zod | 3.25.76 | MIT | https://github.com/colinhacks/zod | Yes |
| music-metadata | 11.15.0 | MIT | https://github.com/Borewit/music-metadata | Yes |
| mpv / libmpv | commit `182fa6ca49` | LGPL-2.1-or-later build; bundled FFmpeg declared LGPLv3 by provider | https://github.com/zhongfly/mpv-winbuild/releases/tag/2026-08-28-182fa6ca49 | Windows package |

SQLite persistence uses the `node:sqlite` module embedded in Node.js/Electron. It does not add a separate npm native addon to the package.

The Windows package currently bundles `mpv-dev-lgpl-x86_64-20260828-git-182fa6ca49.7z` from `zhongfly/mpv-winbuild`. The archive SHA-256 recorded by the source manifest is `66e75ef9db1be87dcfc140632456fb0475a94694686391fbbcde8cb523ee4070`; the bundled `libmpv-2.dll` SHA-256 is `cb67e96c08bbcd0efd60949e7562f034f5dba2e0bc6838cb4161ee5636c33145`. See `third_party/mpv/win-x64/SOURCE.txt` for the pinned provider and upstream commit.

Source adapters are independently implemented from documented protocol behavior. No FongMi/TV or zyfun source code is copied into this repository.

## Compatibility protocol references

TVBox configuration shell compatibility is independently implemented from observable public protocol behavior. No third-party TVBox source code is bundled or copied into Free New Desk; the implementation uses Node.js built-in crypto primitives only.
