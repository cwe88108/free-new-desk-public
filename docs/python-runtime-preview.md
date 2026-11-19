# Python Spider trusted-code preview

## Status and security boundary

`T3_PY` is an explicit source type. TVBox type 3 entries whose API or ext is an HTTP(S) `.py` URL are no longer sent to the Type4 HTTP adapter. Imports remain disabled and Level B until the existing exported-code review and content-hash approval flow is completed. Explicit type 4 configurations remain HTTP Type4, including Python-backed HTTP services.

This is **trusted code execution, not an OS security sandbox**. CPython has the user's file, network and process privileges. `-I -S`, a temporary working directory and an environment allowlist reduce accidental inheritance; they do not prevent malicious scripts from reading files, accessing the network, spawning processes or downloading new executable code. Approval covers the downloaded entry and source configuration, not code the source may dynamically retrieve. Only review and run single-file sources that do not fetch or import additional executable dependencies beyond the bundled compatibility module. The exact bundled `base.spider` bytes appear as a dependency in the exported review and approval digest; old entry-only approvals must be renewed. This is dependency pinning for this small built-in profile, not arbitrary Python package support. Untrusted execution is not offered.

The preview is off by default. A user who understands this boundary can install CPython 3.10+ from its official distribution, then set `FND_PYTHON_TRUSTED_RUNTIME=1` before launching the desktop app. `FND_PYTHON_COMMAND` may name a locally trusted interpreter (default `python` on Windows, `python3` elsewhere). On Windows the app skips Microsoft Store execution aliases and checks the selected interpreter with a bounded CPython version probe. Interpreter options are fixed by the application and are not read from source configuration. No Python distribution or package installer is bundled or automatically downloaded. Missing or incompatible interpreters produce setup guidance. A changed entry, configuration revision or revoked approval cannot start a new host with the old approval.

On Windows, close the running app before launching it from the same PowerShell session as these settings. Substitute the full path to your trusted `python.exe` and the installed app path.

```powershell
$env:FND_PYTHON_COMMAND = 'C:\path\to\python.exe'
$env:FND_PYTHON_TRUSTED_RUNTIME = '1'
& 'C:\path\to\Free New Desk.exe'
```

## Exact supported ABI: `python-catvod-stdlib-v3`

One UTF-8 remote `.py` entry defines a no-argument `Spider` class using Python standard-library dependencies and optionally `from base.spider import Spider`. The compatibility module is independently authored for this project; no GPL or unlicensed CatVod implementation is copied. An optional `init(ext)` receives the source ext string, or an empty string if ext was the entry URL. These methods are required:

- `homeContent(filter: bool)`
- `categoryContent(tid: str, pg: str, filter: bool, extend: dict)`
- `detailContent(ids: list[str])`
- `searchContent(key: str, quick: bool, pg: str)`; legacy two-argument and keyword-only `pg` forms are also supported
- `playerContent(flag: str, id: str, vipFlags: list)`

Optional `homeVideoContent()` supplies recommendations when homeContent has no list. Methods return JSON-serializable TVBox/CMS dictionaries or JSON strings consumed by the existing result normalizers. Search binds the callable signature before invocation, preferring three arguments, then keyword-only `pg`, then the legacy two-argument form. A method is invoked only once; an internal `TypeError` is never retried. Legacy two-argument sources have no host-supplied pagination. `playerContent` results pass through existing V2 conversion. Direct play requires HTTP(S); parser results still require the desktop resolver.

### Bundled base.spider subset

The fixed module supplies default `init`, `getName`, `getDependence` (empty), `homeVideoContent`, `destroy`, `manualVideoCheck`, and `isVideoFormat`; required data methods must be implemented by the source. `getDependence()` returning dependencies fails explicitly instead of importing or fetching them. The host terminates on disposal rather than relying on a source `destroy()` callback.

Helpers: `fetch` and `post`, JSON string/dict conversion, UTF-8 base64 encoding/decoding, MD5, redirected logging, and source-process-local `getCache`/`setCache`/`delCache`. Cache dictionary `expires` values are absolute Unix timestamps in seconds. Cache disappears when the process closes, with no writes to user directories.

HTTP helpers use CPython urllib. A small, independently authored `requests` compatibility facade (not the third-party requests package) provides module-level `get/post/request` and `Session.get/post/request` over the same bounded helpers. Its response object provides `status_code`, `headers`, `url`, `encoding`, `content`, `text`, `json()` and `raise_for_status()`. They support query params, explicit headers/cookies, form and JSON POST, redirect control, verified TLS, bounded timeout and a 4 MiB response body limit. Cross-origin redirects drop Cookie/Authorization headers. The facade supports per-session headers and simple cookie dictionaries, but not connection pooling, persistent response cookies, environment proxies, automatic response decompression, adapters, or streaming. `verify=False`, `stream=True`, non-HTTP(S) URLs and proxy callbacks fail explicitly. Sources can still bypass all helper limits with arbitrary Python: this is not a security boundary, permission broker or network sandbox.

Not supported: pip dependencies such as lxml/bs4/crypto, executable dependency manifests, arbitrary Python ecosystem compatibility, requests adapters/streaming/multipart/auth, proxy/localProxy callbacks, runtime-proxy playback, Android services, WebView, JNI, persistent cache or broker-enforced networking/cookies. A pure standard-library source may perform network requests itself, outside RequestBroker. This bypass is part of the trusted-code boundary, not an approved untrusted mode.

## Lifecycle and limits

SourceEngine uses its normal serialized runtime queue, executable capacity limit, revision reconciliation and idle cleanup. Each source gets a separate CPython subprocess and temporary working directory. The code is loaded from the approved fetched bytes, not fetched again inside Python.

Requests time out after 15 seconds; abort or timeout terminates the host and rejects pending requests. Initialization cancellation propagates to entry download and is rechecked before code execution. Disabling, removing or revising a source synchronously revokes its pending initialization; stale requests cannot retry it with the retired configuration. Shared initialization remains alive while another request is waiting; cancellation by its last waiter prevents delayed downloaded code from starting. Reset/re-enable the source after such a terminal error. JSON input and output frames are capped at 4 MiB, entry downloads at 2 MiB, and cumulative stderr at 4 MiB. Source stdout is redirected away from the protocol. Exceptions expose only a fixed error code, not source exception strings. Destruction closes its own pipe handles, waits at most two seconds for process closure after termination (plus a two-second Windows taskkill budget), and removes the working directory. An unconfirmed direct-host exit or failed directory cleanup is reported as an error rather than blocking forever. POSIX uses a process group; Windows uses `taskkill /T /F` with a direct-process kill fallback. This is not strong descendant containment: malicious detached processes can evade it. Windows Job Objects, CPU/memory quotas and OS/network restrictions remain future release gates.

## Verification

`node --test tests/integration/python-spider-adapter.test.mjs` after building contracts, tvbox-config and source-engine exercises import routing, disabled-by-default behavior, approval invalidation, CPython init/home/category/search/detail/V2 play, env canaries, timeout, cancellation (including delayed downloads through SourceEngine and shared initialization waiters), detached descendants holding stdio, confirmed host exit and directory cleanup, output limits, missing interpreter and unsupported direct media targets. It runs only authored fixtures with fake URLs and credentials. Full decoding, first frame, seek, sustained playback, Windows packaging and real third-party source compatibility are not established by these tests.

## Compatibility verification for v2

The integration suite also runs the original `tests/fixtures/python/catvod_spider.py` through init/home/category/search/detail/player, with dict and JSON-string returns. It covers two/three/keyword-only search signatures, no retry after a source TypeError, bundled-dependency approval binding, dependency declaration rejection, and stdlib HTTP helpers against local fixture servers, including cross-origin credential stripping, oversized-response rejection and stalled-body socket timeout. TLS certificate validation is inherited from urllib and has not been exercised with a local HTTPS fixture. No downloaded third-party Python code is executed. The fixture follows the common CatVod method shape; passing it does not establish compatibility with every FongMi source or external dependency. Python and reviewed source code still run with the current user's OS privileges. Tests and helpers neither modify Windows profiles nor migrate existing app data. Windows runtime/package testing remains unperformed here.
