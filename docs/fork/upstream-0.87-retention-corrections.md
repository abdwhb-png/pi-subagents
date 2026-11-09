# Retained-authority review corrections

Date: 2026-11-09. Both findings from the [local review](upstream-0.87-review.md) are corrected in the uncommitted candidate on `integration/upstream-0.87.0-tool-admission`.

## Corrections

The protected workflow launch record now stores the complete admission catalogue, including `[]`. Its reader validates and freezes the catalogue with the existing snapshot parser. `PreparedWorkflowResume` carries that authority separately from public launch parameters, and the executor restores it through the existing internal resume carrier before considering current registrations. A resumed workflow saves the same catalogue for its next restart. Existing records without a catalogue retain the established absent-legacy semantics.

The retained catalogue reader now reads directly and treats only `ENOENT` as absence. Permission, I/O and parsing errors propagate into the existing failure path. Both the sidecar catalogue and the workflow launch authority use the existing private atomic writer, preserving mode 0600 on POSIX.

No new registry, configuration option, public workflow parameter, module or compatibility shim was introduced. These are corrections to the existing persistence and resume owners.

## Regression evidence

RED was observed for all four combinations of empty/populated catalogue and manual/automatic whole-workflow resume with a new executor and changed registrations. The corrected tests pass, verify the actual restarted child launch, assert that authority stays outside public parameters, and inspect the subsequent protected launch record. Missing legacy records remain distinct from an explicit empty catalogue.

RED was also observed for access denial on an existing catalogue, launch-record readers dropping the new catalogue, and workflow records initially using general file permissions. The corrected unit tests verify `EACCES`, malformed snapshot rejection, frozen empty/populated catalogues, legacy absence and private POSIX permissions.

The existing exact launch-record expectations were updated to include `requiredExtensions: []` for raw scripts, named resources and internal launches. The reply-block case explicitly checks it too. Exact shape assertions remain in place.

## Validation

All checks used existing Node 24.18.0 and the pinned project dependencies. Full suites ran on a byte-verified source snapshot based directly on upstream, avoiding the entire uncommitted merge in Git-inspecting tests.

| Check | Result |
| --- | --- |
| Full unit suite | 4,421 passed, three failed, zero cancelled, 16 skipped; 4,440 total |
| Focused record, resume and catalogue units | 16 passed |
| Focused automatic-resume, native admission and new restart integration cases | 18 passed |
| New whole-workflow restart regression group | Four passed |
| Corrected exact launch-record expectations | Six passed |
| Project TypeScript check under Node 24 | Passed |
| Changed-file lint compared with the pre-correction candidate | Zero additional diagnostics; existing lint debt remains |
| Staged and unstaged whitespace checks | Passed |

The three unit failures are unchanged from the separately verified upstream baseline: package-agent shadowing/disabling in `agent-eject-disable.test.ts`, and linked-worktree root detection in `agent-memory.test.ts`.

The full integration run recorded 1,322 passed, three failed and 10 skipped, with zero cancellations. Its three failures were the old exact launch-record expectations identified above. Those assertions were corrected and their complete six-test group passed. The full integration suite was not repeated after that test-only change. This is full-run evidence plus a focused correction, not a claim of a single green full integration run.

Raw RED/GREEN logs, lint comparison, full suite output and exit statuses are retained locally in the ignored `tmp/tool-admission-review/corrections/` directory. The original review evidence is preserved separately.

## Completion boundary

Both reproduced review findings are closed by the scoped corrections and executable regressions. This is local verification, not an independent delegated re-review. The upstream unit baseline failures and existing lint debt remain visible. No commit, push, CI, release, paid model call, remote qualification, session interruption, daily installation or Pi-core change occurred.
