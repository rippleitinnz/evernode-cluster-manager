# Evernode Cluster Manager — Changelog


## v3.0.0 (in progress)


### Client (cluster-manager.js)

- **`submitInput` + `pollUntil`** — replaced `sendInput` with fire-and-forget submission plus state polling. No more relying on contract output events which closed connection prematurely.
- **`opUpdateContract`** — polls `getContractVersion` until version matches instead of waiting for output. Shows current version before asking for new.
- **`opAddNode`** — completely rewritten. No longer bundles/deploys contract. Uses `EV_HP_INIT_CFG_PATH` at acquire time — HP syncs contract code, state, and config automatically from existing cluster. Only 2 steps: Acquire + Add to UNL.
- **`opRemoveNode`** — polls until UNL count decreases. Saves to cluster-nodes.json immediately after acceptance. Calls `removePeer` after removal to clean stale peer connections.
- **`opStatus`** — UNL nodes now show domain alongside truncated pubkey.
- **Connection fallback** — on project load, tries each node in cluster-nodes.json until one connects.
- **Host filter** — API filter now returns hosts with `availableInstances >= 1 && <= minSlots` to avoid evdevkit chunk-size bug.

### Contract (src/index.js)

- **`removePeer` handler** — new handler calls `ctx.updatePeers([], [peer])` to remove stale peer connections.
- **Backup path fixed** — `mkdir -p ../${backup}` moves backup outside state directory, preventing state hash divergence and fork.
- **`post_exec.sh` tmp path** — changed to `/tmp/hp-patch-tmp.cfg` to avoid relative path issues.
- **`post_exec.sh` log level** — patches both `patch.cfg` and `hp.cfg` to set `log_level: dbg` so `hp.log` is generated on all nodes after upgrade.
- **`contract.config` log** — writes `log: { log_level: 'dbg' }` to `contract.config` during upgrade.

### Key discoveries

- HP syncs contract code, state, and config automatically from existing cluster — no bundle/deploy needed for addNode.
- `EV_HP_INIT_CFG_PATH` at acquire time is the correct way to bootstrap a new node.
- Backup inside state (`./`) causes state hash divergence and unrecoverable fork — must use `../`.
- `hp.log` only created at `dbg` level. Sashimono default template sets `err`. External hosts can't be changed from tenant side except via `post_exec.sh` patching `hp.cfg` directly.
- `/etc/sashimono/contract_template/cfg/hp.cfg` is the source template for all new instances on a host.
- `submitContractInput` closes connection after submission — contract output never arrives. Solution: poll `getStatus` for state changes instead.

## v2.x (previous)

- Initial cluster manager with bundle/deploy approach for addNode.
- `sendInput` with sleep-based waiting for contract output.
- Backup inside state causing fork issues.

### Additional changes (v3.0.0 continued)

- **`readLog` handler** — new contract handler reads `hp.log`, `rw.stdout.log`, or `rw.stderr.log` from inside the container. Supports configurable line count.
- **Option 8: Read node log** — new menu option connects to any UNL node and retrieves logs remotely. Supports auto-refresh (tail mode) every 5 seconds. No SSH access required.
- **Host finder diversity** — deduplicates results by root domain, max 3 per operator. Fetches 10x targetCount from API then slices after dedup for diverse results.
- **Host API fix** — removed hardcoded `minXah=5&minEvr=1` defaults from cluster manager API query. Now uses `minXah=1&minEvr=0.01` to include low-EVR operators like bisdak.
- **api.onledger.net fix** — removed default `minXah=5&minEvr=5` filters from `/hosts` endpoint. Now returns all hosts by default, filters are opt-in.
- **`readContractLog`** — contract handler for reading `rw.stdout.log` and `rw.stderr.log`.

### Cleanup and fixes (v3.0.0 continued)

- **Header comment** — updated from v2.5.0 to v3.0.0
- **`opStatus`** — UNL nodes now show domain alongside truncated pubkey (consistent with `opRemoveNode`)
- **`opUpdateContract`** — removed redundant `waitForSync` call after `pollUntil` confirmation. Fixed `\n` to `\r` in version polling output.
- **`findHostsViaAPI`** — removed stale `// Fetch balances` comment
- **Host deduplication** — improved operator detection to handle numbered subdomains (e.g. `n1234.bisdaknode1051-1100.ovh` correctly groups as `bisdaknode` operator). Now works correctly in both `opDeploy` and `opFindHosts`.
- **Future ideas logged** — auto-extend leases when nodes within 24h of expiry; local web server UI; bring-your-own-contract module; pre-flight host check before acquiring

### Documentation (v3.0.0 continued)

- **README.md** — completely rewritten for v3.0.0. Updated all menu options, addNode flow (EV_HP_INIT_CFG_PATH approach), removed outdated bundle/deploy references, added Option 8 Read node log, updated contract handler table, added host discovery API section pointing to public api.onledger.net, added Xahau public node default.
- **layout.md** — new file documenting the full contract upgrade process in detail including ncc build, evdevkit bundle, post_exec.sh flow and consensus integrity.
- **Bring your own contract** — new README section explaining how to add custom business logic alongside the management handlers, critical rules (no non-deterministic outputs, keep all 8 handlers, version constant required), and future module approach.

### UX fixes (v3.0.0 continued)

- **Node expiry display** — renamed `Moments` column to `Purchased` showing `Xh total` to clarify it is the total lease duration, not time remaining
- **Expiry alert monitor** — added background check every 30 minutes, alerts when nodes with >= 12 purchased moments have less than 6 hours remaining. Configurable via `ALERT_HOURS` and `ALERT_MIN_MOMENTS` in project `.env`


### Cross-platform compatibility (v3.0.0)

- **Absolute path fallbacks** — `ws` and `evernode-js-client` now try local `node_modules` first, falling back to evdevkit global path. Works on both standard Linux installs and systems without global evdevkit.
- **Optional dependencies** — added `ws` and `evernode-js-client` as `optionalDependencies` in `client/package.json` for systems that need local installs.

### Windows compatibility (v3.0.0)

- **Removed all bash dependencies** — replaced all `bash -c 'set -a; source ...'` calls with direct `execSync` using `process.env`. No bash required on any platform.
- **Platform-aware sudo** — added `const sudo` helper that uses `sudo -E` on Linux/Mac and empty string on Windows.
- **All env vars loaded via `loadProjectEnv()`** — credentials no longer need to be sourced via bash subshell, they are already in `process.env` when needed.

### Host heartbeat filter (v3.0.0)

- **`lastHeartbeatTime` field** — added to host discovery API, populated only when a real heartbeat is received (not during full scans)
- **`minLastHeartbeat` filter** — new API parameter filters hosts by minutes since last heartbeat. Default in cluster manager: 60 minutes
- **Host finder** — now only returns hosts that have sent a heartbeat in the last 60 minutes, reducing chances of acquiring an unresponsive host

### Host discovery improvements (v3.0.0 continued)

- **Heartbeat filter** — host finder now only returns hosts that have sent a heartbeat in the last 3 moments (180 minutes). Filters out stale/inactive hosts that may have good reputation scores but are no longer actively running.
- **Public API default** — new projects now default to `HOST_API_URL=https://api.onledger.net` so users who clone the repo get fast cached host lookups out of the box without any additional configuration.
- **`ALERT_HOURS` and `ALERT_MIN_MOMENTS`** — now included in default project `.env` template.

### Cluster health detection and auto-repair (v3.0.0)

- **`weaklyConnected` detection** — status now shows `⚠ WEAKLY CONNECTED` when HP reports a node cannot reach all UNL peers
- **Unreachable node identification** — compares UNL against peer list to identify which node is unreachable
- **Auto-repair flow** — when weakly connected, offers to replace the unreachable node automatically: adds new node, waits 2 roundtimes for stabilisation, then removes the dead node
- **Vote participation display** — UNL nodes show ✓/✗ reachability status when cluster is weakly connected

### Auto-repair improvements (v3.0.0 continued)

- **Confirmation before remove** — auto-repair now asks before removing the dead node rather than doing it automatically
- **Dead node UNL check** — checks if dead node already left the UNL naturally before attempting removal, avoiding unnecessary `removeNode` calls

### Heartbeat quality filter (v3.0.0 continued)

- **3-bucket heartbeat validation** — host finder now requires hosts to have sent a heartbeat in each of the last 3 hourly windows, not just any single heartbeat within 3 hours. This ensures hosts are consistently active rather than having sent one heartbeat and gone quiet.
- **4,511 qualifying hosts** — down from ~5,400 with single-heartbeat filter, excluding ~900 hosts with gaps in their heartbeat pattern.

### Report a dead host (v3.0.0)

- **`POST /hosts/:address/report`** — new API endpoint to report a broken host. Sets `reported=1` and excludes the host from search results for 7 days.
- **Report from find hosts** — after viewing host list in option 7, enter the full host XRPL address to report it. Always use the full address — many hosts share similar prefixes.
- **Auto-expiry** — reported hosts automatically re-appear after 7 days giving operators time to fix their setup.
- **DB columns added** — `reported`, `reportedAt`, `reportReason` fields added to hosts table.

### Code cleanup (v3.0.0)

- **Duplicate `minLastHeartbeat`** — removed duplicate filter parameter from API URL
- **Cross-platform temp files** — replaced hardcoded `/tmp/` paths with `os.tmpdir()` for Windows/Mac compatibility
- **`HOST_API_URL` template** — removed from project `.env` template entirely, inherited from global `.env`
- **`npm run build` cwd** — replaced `cd && npm run build` with `cwd` option for cross-platform compatibility
- **Dead code removed** — removed unused `waitForSync` and `fmt` functions
- **Auto-repair confirmation** — restored UNL check and confirmation prompt before removing dead node
- **Report host** — changed from index-based (`r3`) to full address only for safety
- **`weaklyConnected` display** — added spacing around warning indicator in status output

### API and fallback cleanup (v3.0.0)

- **Removed fallback network scan** — xrplwin API, fallback scan removed entirely. Will add later if needed.
- **Default HOST_API_URL** — `https://api.onledger.net` is now the default in code, no configuration needed for new users
- **`saveGlobalEnv`** — writes `HOST_API_URL=https://api.onledger.net` to global `.env` on first-time setup
- **`reportHost`** — now uses same default API URL, no longer requires explicit `HOST_API_URL` config
- **Dead code removed** — `checkBalances`, `checkReputation`, `spawnSync`, top-level `https` import all removed along with fallback scan

### Input validation and UX fixes (v3.0.0)

- **`askYesNo` helper** — all yes/no prompts now loop until valid input (`yes`, `y`, or Enter). Any other input re-prompts with a reminder, preventing accidental actions from mistyped input.
- **Main loop fix** — pressing Enter at the deploy prompt now correctly returns to the project selector instead of exiting the tool.
- **`isYes` helper** — centralised yes check used consistently throughout.
- **Single-slot host guarantee** — host finder now always returns at least 10 single-slot hosts at the top of results, clearly labelled as recommended for deployment.
- **cluster-create bug warning** — deploy flow warns about the evdevkit chunk-size bug and explains the single-slot workaround.
- **Icon spacing** — added consistent spacing after all ⚠, ✓, ✗ icons in console output.

### Host slot verification and single-slot enforcement (v3.0.0 continued)

- **`selectHosts` function** — new pre-deploy host selection function that verifies each host's available slot count against the Xahau ledger immediately as the user enters each address. Replaces the simple address entry loop in `opDeploy`.
- **Single-slot first ordering** — after all hosts are entered, hosts are automatically sorted so the host with the fewest available slots (ideally 1) is placed first in the `cluster-create` hosts file. This directly mitigates the evdevkit chunk-size allocation bug.
- **No single-slot warning** — if all entered hosts have 2 or more available slots, the user is warned and prompted to replace one host with a single-slot host. The user can also choose to proceed anyway with an explicit warning that double allocation risk remains.
- **Inactive host rejection** — hosts that are inactive or not found on the Xahau ledger are rejected immediately at entry time, before any money is committed.
- **Post-deploy duplicate host detection** — after `cluster-create` completes, the parsed node list is checked for duplicate host XRPL addresses. If any host received more than one node, a warning is displayed recommending the project be deleted and redeployed.

### Additional changes (v3.0.0 continued — 2026-04-18)

- **HP client logging suppressed** — `HP.setLogLevel(1)` added at startup to suppress connection noise (Connecting/Connected/Closing messages). Errors still shown.
- **Node health check** — new `checkClusterHealth()` function queries all nodes in parallel. Displays per-node pubkey (truncated), LCL hash, weaklyConnected status and overall safe-to-remove assessment in `opStatus`.
- **LCL hash mismatch detection** — health check compares LCL hashes across all reachable nodes. Flags mismatches as possible fork.
- **Pubkey in health display** — each node row now shows truncated pubkey alongside domain, allowing identification of duplicate-domain nodes.
- **Read node log expanded** — `opReadLog` now offers 6 options:
  - 1. hp.log (unchanged)
  - 2. rw.stdout.log (unchanged)
  - 3. rw.stderr.log (unchanged)
  - 4. hp.cfg — reads full running HP config directly from `/contract/cfg/hp.cfg`
  - 5. patch.cfg — reads contract override config via `ctx.getConfig()`
  - 6. env.vars — reads host environment variables from `/contract/env.vars` (external ports, quotas, security config)
- **`readCfg` contract handler fixed** — was using `ctx.getConfig()` (returns contract override only). Now reads `/contract/cfg/hp.cfg` directly for the full running config including mesh, user, node sections and `known_peers`.
- **`readPatchCfg` contract handler** — new handler returns the contract override config via `ctx.getConfig()`.
- **`readEnvVars` contract handler** — new handler reads and returns `/contract/env.vars` as raw text.
- **Contract version** — bumped to `13.0.0`.

### Key discoveries (2026-04-18)

- **Host security layer peering issue** — some Evernode hosts implement a custom inbound security layer on their peer port that blocks unauthenticated connections. Other nodes time out attempting outbound connections to these hosts. Consensus can still function because the secured host connects outbound to others, but the cluster topology becomes fragile — the secured host acts as a hub and the remaining nodes become dependent on it as a relay. Two such hosts in a 3-node cluster means the third node is a single point of failure for inter-node communication. The `env.vars` file (now readable via option 6) exposes `INTERNAL_SECURITY` which reveals whether a host has this layer enabled.
- **HP self-connection behaviour** — primary nodes (empty `known_peers`) can receive their own address via peer forwarding from connected nodes and attempt to connect to themselves. HP does not filter self-addresses before attempting connections.
- **Duplicate host detection** — post-deploy warning correctly catches when `cluster-create` assigns multiple nodes to the same host (evdevkit chunk-size bug). Recovery: add a good node first, then remove the duplicate.
- **weaklyConnected threshold** — confirmed from HP source: `connected_peer_count < UNL_count * 0.7`. In a 3-node cluster requires 3 connected UNL peers (including self) to be strongly connected.
- **Failed peers with peer_discovery disabled** — HP never removes failed peers from `req_known_remotes` when `peer_discovery.enabled=false`. Retries continue indefinitely.

### Additional changes (v3.0.0 continued — 2026-04-19)

- **Report problematic host** — new menu option 9 allows reporting any host to the API, excluding it from future searches for 7 days. Also offered automatically after removing a node via option 4.
- **Switch project** — moved to option 10 to accommodate new report option.
- **opReadLog expanded** — options 5 (patch.cfg) and 6 (env.vars) added. env.vars gracefully handles hosts without the file (standard Sashimono installations).
- **Cluster resilience guidance** — README updated with warnings about placing multiple nodes on the same host and recovery procedures.
- **Contract version** — bumped to 13.1.0 (env.vars ENOENT fix).
- **npm package** — bumped to 1.1.2 (env.vars ENOENT fix, readPatchCfg and readEnvVars handlers added).
