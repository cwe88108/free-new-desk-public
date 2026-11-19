# Windows same-machine UI observation benchmark

This is test instrumentation, not a production feature or an alternative release.
Keep the original V1.5.2 checkout clean. Prepare separate observation copies for
that checkout and the current candidate with `scripts/prepare-ui-benchmark.mjs`.
Compile each copy with its existing local locked dependencies using
`npm run build:desktop`. Do not install new dependencies during a comparison.

Preparation copies tracked/unignored files, records their hashes and source commit,
changes only the test workload and observation hooks in renderer main, preload and
bootstrap, changes the smoke-only App.vue 100ms navigation assertion into a recorded
over-budget sample, and adds one main-process observer. The production assertion
is unchanged in the original checkout. Runtime modules and built workspace
packages remain those of each selected checkout; the dependency junction target is
recorded. The template and preparation-script hashes must match across versions.
These copies must never be shipped. The original business functions are retained.

Run `scripts/run-ui-benchmark.ps1` with explicit ObservationRoot, fresh RunDir,
fixed ElectronPath and NodePath. It creates a new database with 712 disabled,
declarative simulated sources, a light theme and automatic scheduled update checks
off. Home-page checks still follow each version's existing behavior. No third-party
source code is executed. The existing silent-WAV smoke media is used unchanged.
The process and its children are stopped only after their exact path/profile match.

Use an A-C-C-A order with two complete rounds per version. The 150-operation
sequence is identical. A failure is retained, not retried into the same directory.
Compare complete runs with `scripts/compare-ui-benchmark.mjs`; output must be new.

Measurement version `observed-ui-150-v6` records:

- Route commit timings already emitted by each production App.vue.
- Target page fully visible, followed by two animation frames, with a focusable
  local control. Informational empty pages without local actions must instead
  retain a focusable active navigation button. Local control availability and the
  synchronous readiness-probe cost are recorded; stop at the first visible control.
  This measures the page shell, not completion of all asynchronous network content.
- All 712 actual draggable point-source rows displayed, excluding compatibility
  duplicates, group-heading rows and live-source rows.
- Preload-to-handler playback query settlement timings, including rejections;
  rejection counts are recorded separately. No raw playback or credential payloads.
- Raw animation frame gaps, including gaps above one second; jank ratios must
  agree with raw gaps. Data export occurs after the measurement window is closed.
- Visibility at every navigation step, with bounded frame waits. A hidden window
  or a frame unavailable for two seconds fails with phase/visibility evidence,
  instead of waiting indefinitely. Focus is recorded separately, not forged.
- A scroll step with a deliberate 100ms observation interval, which must not be
  interpreted as input latency. The global frame gaps cover this scroll workload.

Two launches per version do not establish startup P95. Query timing improvements
do not establish universal 2x fluency. Scripted focus is not a replacement for
physical keyboard/remote-control acceptance, and silent WAV does not prove real
video rendering, quality, audio output or source compatibility.

Calibration records are retained: v1 mixed a fixed 250ms settling delay into its
interactive label, so it is not eligible for response-target verification. v2
required local actions on every page, which failed on the empty Live page because
its available header controls were intentionally hidden (zero client rectangles).
v3 records that absence and tests the existing navigation action, without modifying
the application's empty-state layout or adding artificial controls.
The second baseline v3 round hit the existing smoke-only 100ms budget (settings
navigation 109.8ms). That failed round is retained. v4 records rather than throws
this test-only assertion in both observation copies, allowing the actual long tail
to be measured. A completed observation run is not a passing performance gate.
v4 completed four runs, but its readiness probe inspected layout for all 5716 source
page controls. It introduced major observer overhead and cannot establish a product
regression. Those records are retained as calibration data. v5 stops at the first
visible control, avoids full-page innerText layout reads and records probe cost.

For root-cause diagnostics only, preparation accepts `--trace-source-view` to log
source IPC, Vue patch time and capability-calculation cost in a 30-operation run
(`-ExpectedOperations 30`). `--trace-source-view-no-motion` additionally disables
route motion only in that diagnostic copy. These modes are marked diagnostic,
have separate workload identifiers, and are rejected by the formal comparator.
`--trace-source-view-separate-borders` is a separate diagnostic table-layout trial;
its results do not change the shipping stylesheet.
