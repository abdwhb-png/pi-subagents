# Code Review Report: upstream 0.87 candidate

Date: 2026-11-09. Initial verdict: **REQUEST CHANGES**.

Correction follow-up: both findings are fixed and verified locally. See [the correction record](upstream-0.87-retention-corrections.md) for the implementation, tests and remaining qualification limits. The findings below describe the reviewed pre-correction state.

## Scope and method

Local, sequential review of the retained fork delta against upstream `52e68e9ef0e563d5c97b28519f9999f1b5fbbbea`, focusing on native child admission, discovery ownership, provider selection and protected recovery. Correctness, security, interface continuity and architecture were inspected together. No independent reviewer or delegated review lane ran. This is not an exhaustive audit of every upstream commit integrated since 0.77.

Production source was not changed during this review. The Node 24 validation snapshot was byte-compared against the candidate. Reviewed source hashes and failing probes are retained in the ignored `tmp/tool-admission-review/` directory.

Summary: zero critical findings, one high finding, one medium finding. The existing shared factory and provider registry remain the appropriate owners; no new abstraction or registry is needed. The candidate must not advance to activation while the findings remain unresolved.

## HIGH: whole-workflow restart recaptures the provider catalogue

Locations: `src/runs/foreground/subagent-executor.ts:5475`, `:5654`, `:5819`, `:8419`; `src/workflows/workflow-resume.ts:118`.

An initial workflow captures the complete provider catalogue in process-local state. The protected workflow launch record saves the public launch and admission capability ceiling, but not that catalogue. Resume reconstructs the public request and does not restore a provider snapshot through the internal resume carrier. The newly created executor therefore falls through to `resolveRequiredChildExtensions` and captures current providers.

The deterministic probe launches an async workflow with an explicit empty catalogue, lets its child fail, marks only temporary run status as interrupted by an exited owner, disposes the registration, registers a new conditional provider, and prepares an auto-resume through a new executor. The restarted child actually launches and receives the new provider catalogue instead of `[]`. The probe fails with actual `[{id:"late", ...}]` versus expected `[]`.

This violates the approved retained-authority contract. It can introduce a newly registered provider or lose an originally selected provider on workflow restart even though the original run's catalogue was authoritative. The original tests proved retention inside a running workflow and retained-child recovery, not whole-workflow restart after executor state is lost.

Correction: persist the full captured catalogue, including `[]`, in the existing protected workflow launch authority; validate it through the existing snapshot parser; carry it through `PreparedWorkflowResume` and the internal executor resume metadata before provider capture. Do not put executable provider authority into public workflow parameters or child-writable status files. Preserve the distinction between an absent legacy snapshot and an explicit empty one. Cover populated and empty snapshots through manual and automatic restart with a new executor and changed registrations.

## MEDIUM: unreadable retained authority is treated as absent

Location: `src/shared/required-child-extensions.ts:130`.

The reader calls `fs.existsSync` before reading the protected catalogue. That function returns false when traversal is denied, so an existing catalogue behind an unreadable launch directory returns `undefined`. Append-step then uses the same fallback as a genuinely missing legacy snapshot and can capture current providers instead of reporting the storage failure.

The POSIX probe writes an empty protected catalogue, removes traversal permission from its containing directory, and calls the real reader. Expected: `EACCES`. Actual: no exception. The probe restores permissions in `finally` and uses only a unique temporary directory.

Correction: read directly and treat only `ENOENT` as missing. Propagate access, I/O and parse errors through the existing append-step error path. Test a genuinely absent file separately from an unreadable existing catalogue.

## Node 24 validation

Runtime: existing `/usr/bin/node`, version 24.18.0. No runtime or dependency installation was needed. The full unit run used an isolated worktree based on upstream with the exact candidate source applied, so Git-inspecting tests did not measure the entire uncommitted upstream merge.

| Check | Result |
| --- | --- |
| Full unit suite | 4,419 passed, three failed, zero cancelled, 16 skipped; 4,438 total |
| Same three failing scenarios on untouched upstream with Node 24 | Reproduced |
| Project TypeScript check under Node 24 | Passed |
| Native SDK admission and in-process extension/MCP integration | 51 passed |
| Native tool-activation smoke | Two passed |
| Native tool-search selection, exclusion, extension ceiling and provider replacement probes | All five passed |
| Whole-workflow catalogue restart probe | Failed for the high finding |
| Unreadable catalogue probe | Failed for the medium finding |

The remaining full-unit failures are the two package-agent scenarios in `agent-eject-disable.test.ts` and the linked-worktree root scenario in `agent-memory.test.ts`. None of the earlier implementation failures or lifecycle cancellations remains in this Node 24 unit run. This does not establish a green complete unit suite.

The full integration suite was not repeated under Node 24. Its earlier Node 26 result remains 1,321 passed, zero failed and 10 skipped. The focused Node 24 integration checks above supplement that result. No real provider calls, remote hosts, standalone installation/sandbox qualification, CI, commit, push, publication, session interruption or daily activation occurred.

## Recommendation

**REQUEST CHANGES:** correct the two retained-authority findings in their existing owners, turn the isolated probes into regression tests, and rerun the affected recovery and workflow checks before considering commit or broader qualification. The Node 24 checks resolve the earlier runtime-validation gap; they do not override the two reproduced review defects.
