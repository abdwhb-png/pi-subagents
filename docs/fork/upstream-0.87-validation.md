# Local validation of the upstream 0.87 candidate

Latest disposition: both local review findings are corrected. The [correction record](upstream-0.87-retention-corrections.md) contains final Node 24 results, the unchanged three upstream unit failures, and the integration expectation corrections. The results below remain the original implementation-stage evidence.

Date: 2026-11-09. Candidate branch: `integration/upstream-0.87.0-tool-admission`. Starting fork: `cf4b3ede`. Integrated upstream: `52e68e9ef0e563d5c97b28519f9999f1b5fbbbea`.

The candidate is implemented with all merge conflicts resolved, but remains uncommitted and uninstalled. The daily package remains 0.77.0+fork.4. The harness checkout and Pi-core were not modified. See [the implementation record](upstream-0.87-tool-admission.md) for ownership, retained fork contracts and activation requirements.

## Executed checks

| Check | Result |
| --- | --- |
| Project `npm run typecheck` | Passed after final production changes |
| Full integration suite, two concurrent files | 1,321 passed, zero failed, 10 skipped |
| Focused unit contracts: providers, runtime, command integration, remote placement and recovery | 193 passed |
| Retained workflow provider/catalogue scenarios, synchronous and asynchronous | Six passed |
| Final protected catalogue tests, including tampering and POSIX mode 0600 | Eight passed |
| Native admission on Pi 1.2 | Two scenario tests passed |
| Native admission on promoted Pi 1.5 SDK | Two scenario tests passed |
| Native admission under Bun | Two scenario tests passed |
| Native tool-activation smoke | Two passed |
| Lifecycle tests in an identical source snapshot based on upstream | 25 passed |
| Lint of new native tests and fixtures | Zero diagnostics |
| Changed-owner lint scan | 1,129 diagnostics; not a clean lint gate |
| Staged and unstaged whitespace checks | Passed |
| Remaining merge conflicts | None |

Native scenario tests cover native `codemode` and `tool_search` registration, awaited rejection, shutdown, foreground execution, runner execution, reopening a retained session, real nested delegation and synchronous/detached workflows. Only model responses are scripted. Invalid children record zero model invocations; the valid supervisor consumes the nested child's missing-tool result. Tests use temporary agent configuration, not personal settings.

RED evidence separately demonstrated missing native registration, generation continuing despite the old event-handler exception, child-writable catalogue replacement, and loss of private permissions when initially using a general atomic writer. The existing private atomic writer now preserves mode 0600 on POSIX.

## Full unit result and corrections

The full unit run recorded 4,438 tests: 4,410 passed, nine failed, three cancelled and 16 skipped. It ran during implementation and is not a green final full-suite result. Affected tests were rerun after subsequent corrections rather than repeating the entire suite.

Six failures were corrected: the retained recovery fixture now writes through the protected recovery path; two runtime tests observe diagnostics without expecting cancellation from an event exception; two command-factory fixtures expose the actual registered tools; and one remote-placement test expects upstream's current required-extension diagnostic. The focused 193-test rerun passes.

Three failures reproduce on untouched upstream 0.87 with the same dependencies: `agent-eject-disable.test.ts` fails its package-agent shadowing and disabling scenarios, and `agent-memory.test.ts` fails the linked-worktree Git-root scenario. They were left outside this change.

Three foreground lifecycle tests exceeded their timeout in the large uncommitted merge worktree. All 25 tests in that file pass against the same source changes applied to a worktree based directly on upstream, where Git inspection sees only the retained fork delta. This supports the large merge-diff explanation; the original cancellations remain recorded.

## Evidence and limits

Raw results are retained locally in the ignored `tmp/tool-admission-validation/` directory, including RED logs, focused checks, full suite logs, lint output and upstream comparisons. The full suites ran with Node 26.12.1; Node 24 and cross-platform CI were not executed. The Pi 1.5 SDK was exercised locally, without promoting or changing its runtime. The native Bun checks use the package's development SDK.

Dependency restoration used Socket Firewall and the upstream npm lockfile with lifecycle scripts disabled. Package metadata and lockfile match the pinned upstream release. npm reported two moderate vulnerabilities during restoration; no unrelated audit fix or dependency upgrade was attempted.

No real provider call, actual remote host, standalone installation/sandbox qualification, paid evaluation, CI, commit, push, publication or daily activation was performed. Those remain separate operations. Existing sessions were not interrupted. Activation must account for upstream's incompatible recovery format before changing the installed package.
