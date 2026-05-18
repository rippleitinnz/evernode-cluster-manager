# Evernode Cluster Manager — Changelog

---

## v3.2.0 (2026-05-19)

### cluster-manager.js

**Bootstrap peer selection**
- `opAddNode` now displays all available peers before acquire and allows the user to select a different bootstrap peer. Previously the cluster-selected peer was used silently with no visibility or override. The recommended peer is highlighted; pressing Enter accepts it.

**Poll condition fix**
- `opAddNode` step 4 now polls for `UNL >= expectedUnl` instead of `UNL === expectedUnl`. Previously if multiple pending nodes were promoted simultaneously the UNL count would jump past the expected value and the poll would never resolve, always timing out.

**Error message fix**
- Timeout in step 4 now correctly reports "Timed out waiting for node to join UNL" instead of the misleading "Bundle deploy failed".

**Blake3 warning suppressed**
- All `npm install` calls now pass `BLAKE3_FORCE_WASM=1` in the environment, suppressing the native binding download warning on every install.

**`cluster.info` fixes**
- `opDeploy` now deletes stale `cluster.info` from `contract/dist/` before bundling. Previously a `cluster.info` written by a prior `opAddNode` run could be bundled into a fresh cluster deploy, giving every new node stale peer data from a previous cluster.
- `opAddNode` now writes all current UNL nodes to `cluster.info` instead of just one anchor node. No memo size constraint applies — `cluster.info` is a bundle file. Gives new nodes multiple peers to try when connecting.

**`TOOL_VERSION`** bumped to `v3.2.0`.

### npm package (evernode-client-cluster-manager@1.3.0)

- MATURED flow fixed — `hotpocket-js-client` moved to top-level static require so ncc bundles it correctly
- Full peer mesh maintenance via `patch.cfg` `mesh.known_peers` using `ctx.updateConfig()`
- `cluster.info` written with full UNL peer list
- `checkAndPromoteMatured` updates full peer list via `ctx.updatePeers` after promotion

See [npm package CHANGELOG](https://github.com/rippleitinnz/evernode-client-cluster-manager/blob/main/CHANGELOG.md) for full details.

### contract/src/index.js

- Version reset to `1.2.0`.

---

## v3.1.2 (2026-05-14)

Source cleanup release — removes unsafe `purgePeers` code path. No functional change to the cluster manager's user-facing operations: `opPurgePeers` was never wired into the menu after v3.1.1 (removed during the May 7 cluster-instability incident).

### cluster-manager.js

- Removed orphan `opPurgePeers` function entirely. Function was unreachable from the menu but still lived in the codebase, calling the dangerous `purgePeers` contract handler. Removing it eliminates the temptation for any future rewire to a menu option.
- `TOOL_VERSION` bumped to `v3.1.2`.
- Moved `inspect-peers.js` diagnostic to new `tools/` directory. Standalone read-only script that dumps per-node and aggregate peer state from `hp.cfg`, `patch.cfg`, and live status. Useful for future peer-state investigations.

### npm package (evernode-client-cluster-manager@1.2.2)

- **Removed `purgePeers` handler entirely.** Used hpcore's OVERWRITE mode via `ctx.updatePeers(peers, "*")`. When every UNL node ran this handler in the same consensus round, every node closed all live peer sessions simultaneously, collapsing the cluster. The handler had no safe usage pattern from a multi-node contract. The ghost-peer use case is fully covered by `removeNode` and `removePeer` (since 1.2.1) which use FORCE mode on a single peer at a time — surgical and safe across simultaneous consensus execution.
- Removed orphan `heartbeat()` function (defined but never called from `init()`).
- Removed unused `HP_CLIENT_TIMEOUT` and `HEARTBEAT_INTERVAL` constants.
- Cleaned `/***N;***/` inline comment artefacts on threshold constants.
- Handler count: 15 → 14 user-facing (9 readonly + 5 consensus). `matured` is consensus but is a node-to-node signal, not a user-facing operation.

### README

- Handler table: removed `purgePeers` row. Updated `removeNode` and `removePeer` rows to reflect their post-1.2.1 behaviour (both now flush `req_known_remotes`).
- Rewrote the "Ghost peer purge" paragraph as "Ghost peer cleanup (resolved as of npm package 1.2.1)" — describes the FORCE-mode flush mechanism, explains why the OVERWRITE-mode `purgePeers` was removed in 1.2.2, confirms no remaining unsafe peer-cleanup code paths.

---

## v3.1.1 (2026-05-10)

Bug fixes and display improvements following live 10-node cluster testing.

### cluster-manager.js

**Safety fixes**
- `opPurgePeers` removed from menu — sending peer_changeset OVERWRITE to all nodes simultaneously caused cluster instability during testing. The handler remains in the codebase for future redesign as a safe single-node-at-a-time operation.
- `opRemoveNode` — removed auto-purge call that fired immediately after node removal while cluster was resyncing. Auto-purge was the root cause of a cluster deadlock incident.
- `reconcileNodes` — now only strips cluster-nodes.json when `voteStatus === 'synced'` AND `currentUnl.length >= 3`. Previously stripped records during unstable cluster states, causing data loss.
- `opPurgePeers` — added 15-second `Promise.race` timeout per node to prevent indefinite hangs on unresponsive nodes.

**Display fixes**
- Node health display — removed `weaklyConnected: false` noise. Now only shows warning when `weaklyConnected: true`.
- Node health display — LCL hash mismatch indicator (`✗ HASH MISMATCH`) only shown when there is an actual mismatch. Previously showed `✗` on every node regardless of hash state.
- Version poll — added padding to `\r` output to prevent leftover characters (e.g. `9.1.1wn`).
- UNL poll — added padding to `\r` output to prevent `syncedd` double-character artifact.
- `checkClusterHealth` — added 10-second `Promise.race` timeout per node. Previously hung indefinitely on nodes that were slow to respond during contract upgrades.

**Log reader additions (option 8)**
- Option 7 — `cluster.json` — reads contract cluster state from any node showing node membership, statuses and promotion history.
- Option 8 — `authorized_pubkey.txt` — reads the authorized management key from any node.

### npm package (evernode-client-cluster-manager@1.2.0)

**New: `readClusterJson` readonly handler**
- Returns `cluster.json` from contract state directory.
- Shows full node membership, isUnl status, createdOnLcl, acknowledgedOnLcl, addedToUnlOnLcl for each node.

**New: `readAuthorizedPubkey` readonly handler**
- Returns `authorized_pubkey.txt` from contract state directory.
- Shows which public key is authorized to submit management inputs.

**Cleanup**
- Removed commented-out OVERWRITE code block from `checkAndPromoteMatured`.

---

## v3.1.0 (2026-05-09)

This release is a complete re-engineering of the cluster manager and npm package. The codebase has been audited, stabilised and extended with a focus on correctness, reliability at scale, and accurate on-chain data sourcing. All changes were developed, tested and verified locally against a live 10-node cluster before being committed.

### cluster-manager.js

**Memo size fixes (Xahau 1KB limit)**
- `initCfg known_peers` — limited to 1 peer entry (goes into Xahau acquire memo). Previously sent all peers, causing `invalidTransaction: memo exceeds maximum allowed size` errors at 7+ nodes.
- `overrideCfg` — limited to 1 UNL pubkey and max 2 peer entries (goes into bundle deploy memo). Previously sent all UNL pubkeys and all peers, failing at 6+ nodes.
- `cluster.info` — limited to anchor node + new node only. Previously sent all UNL nodes, contributing to memo size growth.

**Bootstrap peer selection**
- `opAddNode` now queries the running cluster via `getBootstrapPeer` (readonly contract handler) before writing `initCfg`. The cluster selects the most stable peer based on `cluster.json` state — original deploy nodes preferred, then promoted nodes by seniority (earliest `addedToUnlOnLcl`).
- Falls back to `stat.peers[0]` if the handler is unavailable (older contract versions).
- Eliminates the previous random peer selection which could pick hosts with closed peer ports or custom security layers, causing new nodes to be completely isolated.

**Accurate lease expiry tracking**
- `getExpiryTimestamp()` — uses `expiryMoment` if stored (chain-confirmed, accurate to moment boundary), falls back to `createdTimestamp + lifeMoments × 3600` (accurate to the second, matches `evernode list` exactly).
- `timeRemaining()` — now shows `Xh Xm Xs` format (seconds precision) instead of `Xh Xm`.
- Evernode moment constants added: `MOMENT_BASE_IDX = 1702531862`, `MOMENT_SIZE = 3600` — verified on-chain 6 May 2026.
- Removed misleading `⚠ Could not fetch expiryMoment` warning on acquire — `expiryMoment` is not available from the acquire response (only from extend). Local calculation is used until first extension.

**On-chain lease extension**
- `opExtendLease` — replaced `execSync('evdevkit extend-instance...')` (silent, swallowed output, no failure detection) with `tenant.extendLease()` directly via evernode-js-client.
- `cluster-nodes.json` only updated when blockchain confirms success — per-node pass/fail reporting with chain error reason on failure.
- `expiryMoment` from chain response stored in `cluster-nodes.json` after each confirmed extension.
- `lifeMoments` only incremented on confirmed success.
- Connected/disconnected from Xahau cleanly per operation.

**`opCheckExpiry` improvements**
- Added `Source` column showing `chain` (expiryMoment stored) or `local` (createdTimestamp calculation).
- Seconds-precise remaining time display.
- 6-hour expiry warning shown below table for any expiring nodes.

**Ghost peer handling**
- `opPurgePeers` — added `silent` parameter. When `silent=true` skips confirmation prompt (used for automatic post-remove purge).
- `opRemoveNode` — now calls `opPurgePeers(true)` automatically after successful node removal and UNL resync.
- Per-node pass/fail reporting in purge output.

**Code cleanup**
- Removed `getExpiryMomentFromChain()` — unused after confirming acquire response contains no `expiryMoment`.
- Removed `getCurrentMoment()` — unused dead code.
- Removed double `saveNodes()` call in `opDeploy`.
- Removed orphan `// ── Deploy` and `// ── Operations` section markers.
- Fixed missing closing parenthesis in init config log line.
- `verifyHosts` — added `EV_XAHAUD_SERVER` fallback consistent with other functions.
- XRPL → Xahau rename throughout all user-facing strings and comments.
- `TOOL_VERSION` bumped to `v3.1.0`.

### npm package (evernode-client-cluster-manager@1.2.0)

**New: `getBootstrapPeer` readonly handler**
- Returns the most stable peer for bootstrapping a new node.
- Filters candidates: UNL only, `status: active`, not self, has domain and peerPort.
- Sort order: original deploy nodes first (no `addedToUnlOnLcl`), then promoted nodes by earliest promotion.
- Tested from every node's perspective against live cluster data — correctly excludes self, avoids nodes with closed peer ports.

**New: Stale node auto-pruning in `checkAndPromoteMatured`**
- Runs every consensus round alongside promotion logic.
- Prunes nodes stuck in `status: created` for more than 5 moments without being acknowledged.
- Threshold calculated from `hp.cfg` roundtime — correct for any cluster configuration.
- Safe criteria: only prunes `isUnl: false`, `status: created`, `createdOnLcl` defined. Never prunes `status: acknowledged` (actively maturing) or any UNL node.
- Confirmed working: pruned 2 stale ghost nodes from live cluster on first round after deployment. Logged with pubkey, domain, creation LCL, current LCL and threshold.

**Fix: `checkAndPromoteMatured` OVERWRITE bug**
- After promotion, previously called `ctx.updatePeers(allPeers)` with all peers — this triggered OVERWRITE mode in hpcore, wiping all live peer connections on existing nodes and causing cluster instability.
- Fixed to use targeted add: `ctx.updatePeers([domain:peerPort])` (FORCE mode, single new peer). Existing connections preserved.

**Cleanup**
- Removed commented-out OVERWRITE code block left from the fix.
- `HP_CLIENT_TIMEOUT` constant retained (used by external callers).
- `heartbeat()` function retained (available for user contracts).

### contract/src/index.js

- Version set to `9.0.1` (local versioning — aligns with ongoing cluster testing).
- Keepalive NPL broadcast every 15 ledgers retained.

---

## v3.0.1 (2026-04-26)

### npm package (evernode-client-cluster-manager@1.1.3)

- **Ghost peer fix** — `removeNode` now patches `hp.cfg` `known_peers` directly to remove the departed node's peer address. Previously HotPocket would continue trying to connect to removed nodes indefinitely.

---

## v3.0.0 (2026-04-18)

Complete rewrite of the cluster manager. Key changes from v2.x:

### Architecture

- `submitInput` + `pollUntil` replaced `sendInput` with fire-and-forget submission plus state polling. No more relying on contract output events which closed the connection prematurely.
- `opAddNode` completely rewritten — uses `EV_HP_INIT_CFG_PATH` at acquire time. HotPocket syncs contract code, state and config automatically. No manual bundle/deploy required.
- `opUpdateContract` polls `getContractVersion` until version matches instead of waiting for output.
- `opRemoveNode` polls until UNL count decreases. Calls `removePeer` after removal to clean stale peer connections.

### Contract handlers added

- `removePeer` — removes stale peer connections via `ctx.updatePeers`.
- `readLog` — reads hp.log remotely.
- `readContractLog` — reads rw.stdout.log or rw.stderr.log remotely.
- `readCfg` — reads full hp.cfg directly from `/contract/cfg/hp.cfg`.
- `readPatchCfg` — reads contract override config via `ctx.getConfig()`.
- `readEnvVars` — reads `/contract/env.vars` as raw text.
- `purgePeers` — OVERWRITE clears in-memory peer table.
- `matured` / `checkAndPromoteMatured` / `checkAndSendMatured` — full MATURED node promotion flow.

### Key discoveries

- HP syncs contract code, state and config automatically — no bundle/deploy needed for addNode.
- Backup inside state (`./`) causes state hash divergence and unrecoverable fork — must use `../`.
- `hp.log` only created at `dbg` level — `post_exec.sh` patches `hp.cfg` after every upgrade.
- `/etc/sashimono/contract_template/cfg/hp.cfg` is the source template for all new instances on a host.
- Some Evernode hosts implement `INTERNAL_SECURITY=mid` — acts as a hub, rejects unknown inbound peer connections. Detectable via `env.vars`.
- `weaklyConnected` threshold: `connected_peer_count < UNL_count × 0.7`.

### Features added

- Multi-project management from single tool.
- Global credentials (`~/.evernode-clusters/.env`) shared across projects.
- Node health check — parallel LCL hash comparison, weaklyConnected per node.
- Auto-repair flow for weakly connected clusters.
- Host finder with operator diversity deduplication (max 3 per operator).
- Host heartbeat quality filter (3-bucket validation).
- Host reporting (`POST /hosts/:address/report`, 7-day exclusion).
- Single-slot host detection and enforcement in deploy flow.
- Post-deploy duplicate host detection.
- Remote log reading via contract handlers (options 1–6).
- Expiry alert monitor.
- `askYesNo` validation loop — prevents accidental actions from mistyped input.
- Cross-platform compatibility (no bash dependencies, `os.tmpdir()` for temp files).

---

## v2.x (previous)

- Initial cluster manager with bundle/deploy approach for addNode.
- `sendInput` with sleep-based waiting for contract output.
- Backup inside state causing fork issues.
- Single-project only.
