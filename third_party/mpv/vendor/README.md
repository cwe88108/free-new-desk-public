# Retained LGPL runtime archive

The exact provider archive is checked in because zhongfly/mpv-winbuild retains
only 30 days of builds. A clean checkout must not depend on an Actions cache or
a rolling release still being present. Do not replace this file in place without
updating SOURCE.txt and verifying both the archive and extracted DLL hashes.

Source: https://github.com/zhongfly/mpv-winbuild/releases/tag/2026-11-03-8ca245f213
Provider declaration and retention policy: https://github.com/zhongfly/mpv-winbuild/blob/main/README.md
Build evidence: https://github.com/zhongfly/mpv-winbuild/actions/runs/41615657033
mpv source: https://github.com/mpv-player/mpv/tree/8ca245f2133773f9a7fe59e4c5bcc53f1af4407c

The provider declares this variant LGPL-2.1-or-later, with statically linked
FFmpeg under LGPLv3, and explicitly does not guarantee that every incompatible
component has been disabled. The archive itself contains headers, an import
library, and the DLL; it has no standalone license notices. This retained copy
is for this private repository's reproducible builds. Public redistribution
requires separate source, license-notice, and dependency-compliance review.
This change does not authorize or perform a public release.
