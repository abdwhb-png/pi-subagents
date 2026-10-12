# Host tool selection

This fork resolves configured-agent tool selections after native discovery and overrides. Set a global `subagents.toolSelectionResolver` file path in the Pi agent settings. Home-relative paths expand at the filesystem boundary and relative paths resolve against the agent directory. Project settings cannot choose executable provider code, including in project-only agent scope.

The provider exports synchronous `resolveTools({cwd, agentDir, scope, projectTrusted, selections})`. Each selection contains `agentName` and `selectors`. It returns an ordered array with identical cardinality: `{ok:true, selectors:string[]}` or `{ok:false, error:string}`. The public contract types and existing effective `discoverAgents` reader are exported through `pi-subagents/agents`.

Only the loaded callable is cached by canonical path. Providers must re-read configuration for each batch. Jiti uses `fsCache:false`, `moduleCache:false` and `tryNative:false`; the published Pi SDK is loaded natively to avoid SDK retranspilation. Undefined and empty selections retain their native semantics without calling the provider.

Errors become agent discovery diagnostics carrying canonical, local and alias identities. Affected effective agents are omitted, preventing fresh launches. Raw declaration views remain unchanged. Existing recovery descriptors still supply persisted tools when the current agent cannot be resolved. Runtime-registered agents are unchanged and continue to use concrete lists. Invalid global resolver settings are diagnosed even in project-only scope because the executable provider is a global setting.

The host is responsible for group policy. This fork does not import private harness modules, scan a second agent tree or generate settings overrides. Native launch planning, availability, ceilings, MCP authorization and resume retain their owners.
