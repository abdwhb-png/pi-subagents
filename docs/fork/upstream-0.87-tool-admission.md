# Upstream 0.87 integration and child-tool admission

Status: the two local review findings are corrected. See [the correction record](upstream-0.87-retention-corrections.md) for current validation and remaining qualification limits.

## Candidate and ownership

The candidate integrates upstream `52e68e9ef0e563d5c97b28519f9999f1b5fbbbea` (0.87.0) into fork `cf4b3ede` (0.77.0+fork.4). It is an uncommitted local candidate, not an installed or published release. Pi-core and the personal harness are unchanged.

Upstream now owns the builtin user/project override merge and the newer SDK compatibility fixes. The retained fork delta owns effective discovery through the host tool resolver, runtime-agent selector expansion without changing registration ownership, conditional required-extension callbacks, and complete provider-catalogue propagation. The host addon still owns tool-group policy and global file-provider discovery. No second discovery or provider registry is introduced.

## Native registration and admission

SDK-created children compose Pi's public tool-search factory alongside codemode and selected MCP. Native tool search follows the effective allowlist, exclusions and extension ceiling and remains replaceable by an explicitly loaded provider. Pi 1.2 exports this factory; older or incomplete hosts that cannot provide a requested tool fail the ordinary availability contract.

The shared local child factory waits for extension startup and selected MCP readiness, then evaluates required tools against `session.getAllTools()`. It records the existing diagnostic and awaits shutdown before rejecting an invalid child. Foreground and background callers cannot prompt, steer or follow up with a child the factory did not admit. The `agent_start` hook remains observational and refreshes diagnostics without throwing; extension-handler exceptions are not a cancellation boundary.

Upstream remote admission remains separate: it checks the remote bridge's acknowledged active tools before the first prompt. Mandatory providers and selected conditional local providers retain placement restrictions; unused conditional catalogue entries do not block placement.

## Protected provider retention

The retained provider catalogue is executable launch authority. Its sidecar now lives in the existing parent-owned launch-record directory returned by `runLaunchDir`, beside recovery records rather than inside the child-writable run folder. The existing private atomic writer preserves mode 0600 on POSIX. Internal readers and writers receive a trusted runs root and run ID. They do not derive authority from a requested directory. Existing upstream nested-run isolation limits remain unchanged.

The entire catalogue, including `[]`, remains in descendant runtime configuration and recovery descriptors. Only the selected provider subset loads into a child. Fresh root admission captures a callback once; later registration changes do not rewrite retained authority. A missing catalogue remains distinct from an explicit empty snapshot.

## Activation and recovery

Activation is a separate operation. Before activation, inventory existing sessions and runs, preserve their transcripts and artifacts, and account for any active work without interrupting it. Upstream 0.85 introduced protected recovery records: older runs cannot resume under this candidate. Do not synthesize trusted recovery records from old child-writable files or automatically relaunch workflows. Any deliberate relaunch or reuse of old outputs requires operator direction.

No commit, push, CI, release, daily package installation, session interruption or paid model qualification is part of this candidate change.

## Validation

The real-SDK regression imports production launch builders and the default factory. Its scripted provider is the only model substitute; registration, hooks, admission, foreground execution, background runner execution, retained-session reopening, nested delegation and synchronous/detached workflows are real. Invalid children must make zero model calls, report the missing tool and run shutdown hooks. It runs against the package's Pi 1.2 SDK and the promoted Pi 1.5 SDK using isolated user state. No provider network request is needed.

RED evidence separately reproduced missing native tool search, missing awaited admission, and acceptance of a child-rewritten provider catalogue. Focused runtime, command, remote placement and recovery tests and retained-workflow catalogue tests cover the integration corrections. Full suites use two concurrent test files, with the concurrency option before test paths. See the accompanying validation record for exact results and remaining limits; a focused pass does not imply full-suite or live deployment qualification.
