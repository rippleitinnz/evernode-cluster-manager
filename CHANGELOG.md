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
