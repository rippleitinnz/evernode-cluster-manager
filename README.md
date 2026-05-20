# Evernode Client Cluster Manager

A single tool for deploying and managing multiple HotPocket smart contract clusters on Evernode. No host filesystem access required.

## What It Does

- Manages multiple independent cluster projects from one tool
- Deploys multi-node HotPocket contract clusters on Evernode hosts
- Updates contract code live without restarting nodes or losing consensus
- Adds external nodes to a running cluster — bootstrap peer is displayed and selectable before acquire
- Removes nodes cleanly with stale peer entry cleanup from patch.cfg, live hpcore flush, and on-chain lease termination
- Reads logs and config remotely from any node (hp.log, stdout, stderr, hp.cfg, patch.cfg, env.vars) — no SSH required
- Monitors cluster health, consensus status and vote state per node — LCL hash comparison, weaklyConnected status, safe-to-remove assessment
- Detects weakly connected nodes and offers automatic cluster repair
- Tracks node lease expiry with accurate to-the-second display — chain-confirmed after first extension
- Extends leases with full on-chain confirmation — only updates local records when blockchain confirms success
- Discovers available Evernode hosts with operator diversity filtering and heartbeat quality validation
- Reports broken hosts to exclude them from future searches
- Auto-prunes stale non-UNL nodes from cluster state after 5 moments of inactivity
- Maintains full peer mesh in `patch.cfg` across all nodes — cold restarts always find live peers
- Auto-failover to any reachable node when the primary peer is unreachable
- Live cluster configuration via Cluster Settings — active peer, bootstrap peer, round time
- Emergency recovery via Tools menu — deploy recovery contract, destroy cluster, reset credentials

## What's new in v3.4.1

**Roundtime safety cap in Cluster Settings.** Changing round time via option 10 → option 3 now enforces a hard maximum based on the cluster's current `mesh.idle_timeout` and `stage_slice`. With default settings (`mesh.idle_timeout=120000ms`, `stage_slice=25%`) the safe maximum is **480000ms**. Exceeding this causes peers to disconnect during stage waits, leading to permanent consensus failure with no recovery path. The safe maximum is displayed in the prompt and values above it are refused. To use longer roundtimes, `mesh.idle_timeout` must be set higher at node acquire time — a hpcore PR ([EvernodeXRPL/hpcore#414](https://github.com/EvernodeXRPL/hpcore/pull/414)) has been raised to make this dynamically changeable on a running cluster without restart.

## What's new in v3.4.0

**Price stability in host finder.** The host table now shows a `Price Stability` column. Stable hosts show `✓ price stable Nd`. Hosts that changed price show direction, magnitude and recency — `▲ +70%  3d ago` or `▼ -15%  12d ago  (2x/30d)`. Data sourced from the `/hosts/:address/price-history` endpoint on the Host Discovery API.

**Lease prices always shown in EVR.** Previously small prices displayed as `10drops` or `100drops`, which is confusing — `10drops` looks cheaper than `0.0010 EVR` but is actually 100× cheaper. All prices are now shown in EVR with consistent decimals.

**Acquire price tracking.** When a node is acquired, the price paid (`acquiredLeaseDrops`) is stored in `cluster-nodes.json`. At extend time, the current price is compared against this baseline — independent of the 30-day stability window. A host that raised its price 31 days ago and has been stable since will still show `▲ +900% vs 0.000010 EVR at acquire`.

**Extend lease price check.** Before extending, the tool shows current price, stability, and total EVR cost per node. Always asks confirmation. Warns explicitly when any host is charging more than the original acquire price.

## What's new in v3.3.0

**Auto-failover when primary peer is unreachable.** Every operation now uses `getActivePeer()` instead of a fixed connection. On failure it tries `PREFERRED_PEER` first, then falls back through all nodes in `cluster-nodes.json` in order until one responds. The active peer updates automatically and is saved for the next session. Previously a dead primary node would block all operations.

**Cluster Settings (option 10).** New sub-menu for live cluster configuration:
- **Change active peer** — select from all cluster nodes by number or enter `domain:port`. Saves as `PREFERRED_PEER` and takes effect immediately.
- **Change bootstrap peer** — select the preferred peer for new node acquisitions. Saves as `PREFERRED_BOOTSTRAP`.
- **Change round time** — enter a new roundtime in ms (1000–3600000). Deploys a config-only bundle upgrade to all nodes. Takes effect within one consensus round without a version bump.

**`PREFERRED_PEER` and `PREFERRED_BOOTSTRAP`.** Both settings persist in the project `.env` across sessions. `PREFERRED_PEER` is tried first by the auto-failover. `PREFERRED_BOOTSTRAP` is used by `opAddNode` before querying the cluster.

**Tools menu (option 11).** Emergency and administrative operations in a dedicated sub-menu: deploy recovery contract, destroy cluster (terminate all leases), and reset global credentials. Destructive operations require two-step confirmation. Reset global credentials moved here from the project selector.

## What's new in v3.2.1

**Lease termination on node removal.** When a node is removed via option 4, the lease is now terminated on-chain immediately after UNL removal. This burns the URI token and instructs the host to evict the container — regardless of remaining lease time. Prevents removed nodes from continuing to run or attempting reconnection. Falls back gracefully if the instance is already evicted.

**Debug logging.** Set `DEBUG=true` in `~/.evernode-clusters/.env` to mirror all console output to `~/.evernode-clusters/cluster-manager.log` with ISO timestamps and `[INFO]`/`[ERROR]`/`[WARN]` level tags. Log rotates at 2MB. Disabled by default.

**Hash mismatch display fix.** The node health check now only flags `✗ HASH MISMATCH` when two nodes at the same LCL sequence disagree on the ledger hash. Nodes that are 1 ledger behind have a different hash by definition — this is normal network behaviour and is no longer incorrectly flagged as a fork.

**`cluster.info` full UNL.** When adding a node, `cluster.info` now contains all current UNL nodes instead of just the anchor node, giving new nodes multiple peers to try when sending MATURED.

**Extend lease decimal precision (upstream).** Identified root cause of intermittent `TRANSACTION_FAILURE` on multi-moment extensions — JavaScript floating point precision loss. Fix submitted upstream: [EvernodeXRPL/evernode-js-client#244](https://github.com/EvernodeXRPL/evernode-js-client/pull/244). Local workaround in README Known Issues.

## What's new in v3.2.0

**Bootstrap peer selection is now visible and overridable.** Before acquire, `opAddNode` displays all available peers and highlights the cluster-recommended one. Press Enter to accept or select a different peer by number.

**MATURED flow fixed end-to-end.** New nodes now reliably join the UNL. Fixed in npm package 1.3.0.

**Full peer mesh in `patch.cfg`.** After every node addition, removal, or promotion, all nodes receive the complete UNL peer list in `patch.cfg` `mesh.known_peers`.

**`cluster.info` now contains the full UNL.** The bootstrap file deployed to new nodes now contains all current UNL nodes.

**Poll condition fixed.** Step 4 of `opAddNode` now polls for `UNL >= expectedUnl` instead of `UNL === expectedUnl`.

## Requirements

- Node.js v20+
- `evdevkit` installed globally with host deduplication patch applied (see Known Issues)
- A Xahau wallet funded with XAH and EVR tokens (tenant account)

## Contract npm Package

The cluster management contract handlers are available as a standalone npm package for use in your own HotPocket contracts:

```bash
npm install evernode-client-cluster-manager
```

The contract this repo ships with is intentionally tiny — most of the heavy lifting is in the npm package. Below is the actual deployed source (`contract/src/index.js`):

```js
'use strict';
const HotPocket      = require('hotpocket-nodejs-contract');
const ClusterManager = require('evernode-client-cluster-manager');

const VERSION = '1.2.1';

const contract = async (ctx) => {
    if (await ClusterManager.init(ctx, VERSION)) return;
    if (ctx.readonly) return;
    if (ctx.lclSeqNo % 15 === 0) {
        await ctx.unl.send(JSON.stringify({ type: 'keepalive', lcl: ctx.lclSeqNo }));
    }
};

const hpc = new HotPocket.Contract();
hpc.init(contract);
```

**What this contract does:**

- **`ClusterManager.init(ctx, VERSION)`** — the npm package handles all 14 management input types and the autonomous round logic (MATURED promotion, stale node pruning). If it returns `true` a management input was processed; the contract returns early so business logic is skipped that round.
- **`if (ctx.readonly) return;`** — readonly requests are answered inside `ClusterManager.init()`; the contract has nothing else to do for those rounds.
- **Keepalive NPL broadcast every 15 ledgers** — `ctx.unl.send()` pushes an empty NPL message through the Node Protocol Layer. This forces regular peer-to-peer traffic via the consensus channel even when there's no business logic activity. At the default 8-second roundtime this fires every ~2 minutes. Harmless to remove if your contract has continuous activity from another source.
- **`VERSION`** — the string `opUpdateContract` polls to confirm an upgrade succeeded. Bump it on every change so the cluster manager can verify deployment.

See [evernode-client-cluster-manager on npm](https://www.npmjs.com/package/evernode-client-cluster-manager) for the package's full handler documentation.

## Quick Start

```bash
git clone https://github.com/rippleitinnz/evernode-cluster-manager
cd evernode-cluster-manager
node client/cluster-manager.js
```

On first run the tool prompts for credentials and creates your first project. `HOST_API_URL=https://api.onledger.net` is written to your global credentials file automatically.

## Using Your Own Contract

When creating a project, the tool prompts:

```
── Contract Source ───────────────────────────────────
  1. Use default cluster management contract (recommended)
  2. Use my own contract directory
```

### Option 1 — Default contract

Pick this and the tool uses the contract shipped in `contract/dist/`. Nothing else to do — proceed straight to deployment.

### Option 2 — Your own contract

Point the tool at any directory containing your contract files. The directory must contain:

```
my-contract/
├── package.json     ← must declare evernode-client-cluster-manager as a dependency
└── index.js         ← must require it and call ClusterManager.init() first
```

**Required `package.json`:**

```json
{
  "name": "my-contract",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "hotpocket-nodejs-contract": "0.7.4",
    "evernode-client-cluster-manager": "^1.3.1"
  }
}
```

**Required `index.js` skeleton:**

```js
'use strict';
const HotPocket      = require('hotpocket-nodejs-contract');
const ClusterManager = require('evernode-client-cluster-manager');

const VERSION = '1.0.0';

const contract = async (ctx) => {
    if (await ClusterManager.init(ctx, VERSION)) return;
    if (ctx.readonly) return;

    // Your business logic here
};

const hpc = new HotPocket.Contract();
hpc.init(contract);
```

**Constraints:**

- **Flat layout only.** The CLI does not recursively copy subdirectories.
- **Your `package.json` must declare `evernode-client-cluster-manager`.** Without it, `npm install` creates no `node_modules/` directory.
- **Run `npm init -y` before `npm install` when building a fresh contract directory from scratch.**

### Critical rules for any custom contract

- **Call `ClusterManager.init()` first.**
- **No non-deterministic values in outputs.**
- **Keep a `VERSION` constant** and pass it to `ClusterManager.init()`.
- **Readonly handlers belong inside the `ctx.readonly` block.**

## Management Menu

```
  1. Check status
  2. Update contract
  3. Add a node
  4. Remove a node
  5. Check node expiry
  6. Extend node lease
  7. Find available hosts
  8. Read node log
  9. Report problematic host
 10. Cluster settings
 11. Tools
 12. Switch project
  0. Exit
```

### Option 1 — Check Status

Shows contract version, HP version, vote status, LCL, round time, UNL nodes with domain and time remaining, and connected peers. `Vote Status: synced` confirms healthy consensus.

If the cluster is weakly connected, the status shows `⚠  WEAKLY CONNECTED` and identifies the unreachable node(s). You are offered the option to automatically replace them.

A parallel health check runs across all nodes showing per-node LCL hash, weaklyConnected status and overall safe-to-remove assessment. Hash mismatches are only flagged when nodes at the same LCL sequence disagree — normal 1-ledger lag is not flagged.

### Option 2 — Update Contract

Enter a new version string. The tool bumps the version, rebuilds via `npm run build`, bundles with `evdevkit bundle`, sends to the cluster as a consensus input, and polls until all nodes confirm the new version. No restarts required.

> **Consensus threshold note:** The default threshold is **65%**. With 3 nodes, only 2 must agree.

### Option 3 — Add a Node

The tool queries the running cluster for the optimal bootstrap peer. The available peers are displayed and you can select a different one if needed. If `PREFERRED_BOOTSTRAP` is set in the project `.env`, it is used first.

After acquire, the tool registers the new node in the cluster via consensus, writes `cluster.info` containing all current UNL nodes, rebuilds the bundle and deploys it. The new node connects to the mesh, syncs state, and sends a MATURED signal — the cluster promotes it to UNL automatically after a stability threshold.

### Option 4 — Remove a Node

Select a node by index or pubkey. Removes from UNL and cluster state via consensus, waits for the cluster to resync, then cleans up the stale peer entry from patch.cfg and flushes hpcore's retry queue. Will not remove if cluster would drop below 3 nodes.

After removal, the lease is terminated on-chain via `tenant.terminateLease()`. This burns the URI token and instructs the host to evict the container immediately — regardless of how much lease time remains. Both user and peer ports will close within seconds of termination.

### Option 5 — Check Node Expiry

Shows time remaining for each tracked node with expiry timestamp in UTC, accurate to the second. Warns when any node is within 6 hours of expiry.

> **⚠ Staggering warning:** Never allow more than `UNL_count − ceil(UNL_count × threshold)` nodes to expire simultaneously.

### Option 6 — Extend Node Lease

Select nodes by index, comma-separated indices, or `all`. Uses `tenant.extendLease()` directly for full on-chain confirmation.

> **Note:** When extending multiple instances on the same host, extend them one at a time to avoid sequence number conflicts.

### Option 7 — Find Available Hosts

Queries the Host Discovery API for active hosts. Results are deduplicated by operator — maximum 3 hosts per operator. Only hosts with a proven heartbeat in each of the last 3 hourly windows are returned.

### Option 8 — Read Node Log

Select any node and choose which log to read:

| # | File | Contents |
|---|------|---------|
| 1 | hp.log | HotPocket consensus and network log |
| 2 | rw.stdout.log | Contract stdout |
| 3 | rw.stderr.log | Contract stderr |
| 4 | hp.cfg | Full running HotPocket config |
| 5 | patch.cfg | Contract override config |
| 6 | env.vars | Host environment (ports, quotas, security config) |
| 7 | cluster.json | Contract cluster state — node membership, statuses, promotion history |
| 8 | authorized_pubkey.txt | Authorized management key for this node |

Specify line count and optionally enable auto-refresh every 5 seconds. No SSH access required.

### Option 9 — Report Problematic Host

Report any host by its full Xahau address. Reported hosts are excluded from host discovery searches for 7 days.

### Option 10 — Cluster Settings

Sub-menu for live cluster configuration:

| # | Setting | Description |
|---|---------|-------------|
| 1 | Change active peer | Select preferred node for all operations. Saved as `PREFERRED_PEER` in project `.env`. Auto-failover still applies if unreachable. |
| 2 | Change bootstrap peer | Select preferred peer for new node acquisitions. Saved as `PREFERRED_BOOTSTRAP` in project `.env`. |
| 3 | Change round time | Update `consensus.roundtime` across all nodes via a config-only bundle upgrade. Takes effect within one consensus round. |
| 0 | Back | Return to main menu. |

### Option 11 — Tools
Emergency and administrative operations:

| # | Action | Description |
|---|--------|-------------|
| 1 | Deploy recovery contract | Deploys a minimal contract with no dependency on `evernode-client-cluster-manager`. Use when the main contract cannot load. Immediately follow with option 2 to restore the real contract. |
| 2 | Destroy cluster | Terminates ALL leases on-chain, burns URI tokens, evicts all containers. Two-step confirmation required. Cannot be undone. |
| 3 | Reset global credentials | Overwrites shared tenant credentials used by all projects. Two-step confirmation required. |
| 0 | Back | Return to main menu. |

### Option 12 — Switch Project

Return to the project selector without exiting the tool.

## Cluster Resilience

When deploying a cluster, avoid placing more than one node on the same Evernode host. If that host goes offline you lose multiple UNL nodes simultaneously.

> **⚠ Expiry staggering:** At a 65% threshold with 8 nodes you can afford to lose at most 2 nodes simultaneously. Extend nodes in batches — never extend all nodes by the same amount at the same time if they already share an expiry moment.

## Built-in Contract Handlers

| Handler | Type | Purpose |
|---------|------|---------|
| `status` | readonly | Returns version, contractId, publicKey, lcl |
| `readCfg` | readonly | Returns full running hp.cfg |
| `readPatchCfg` | readonly | Returns contract override config |
| `readEnvVars` | readonly | Returns host environment variables |
| `readLog` | readonly | Returns hp.log lines |
| `readContractLog` | readonly | Returns rw.stdout.log or rw.stderr.log |
| `getBootstrapPeer` | readonly | Returns optimal bootstrap peer for new node acquisition |
| `readClusterJson` | readonly | Returns cluster.json — node membership and promotion state |
| `readAuthorizedPubkey` | readonly | Returns authorized_pubkey.txt — management key |
| `upgrade` | consensus | Handles contract bundle upgrade via post_exec.sh |
| `addNode` | consensus | Registers new node as non-UNL pending MATURED. Writes full peer list to patch.cfg |
| `removeNode` | consensus | Removes node from UNL and cluster state, updates patch.cfg peer list, flushes hpcore req_known_remotes |
| `removePeer` | consensus | Removes stale peer from patch.cfg and flushes from req_known_remotes — manual cleanup for orphan entries |
| `matured` | consensus | Receives MATURED signal from new non-UNL node |

## Autonomous Contract Behaviour

The contract runs autonomous logic every consensus round regardless of user input:

- **`checkAndPromoteMatured`** — promotes acknowledged nodes to UNL after stability threshold. Writes full peer list to `patch.cfg` and broadcasts to all nodes via `ctx.updatePeers()`. Also auto-prunes nodes stuck in `status: created` for more than 5 moments.
- **`checkAndSendMatured`** — runs on non-UNL nodes. Reads `cluster.info` (full UNL peer list) to find existing nodes, connects and sends MATURED signal when synced. Retries up to 3 times.

## Node Expiry Tracking

Expiry is tracked in `cluster-nodes.json` per node:

- **Before first extension:** `createdTimestamp + lifeMoments × 3600` — accurate to the second
- **After first extension:** `expiryMoment` stored from on-chain response — accurate to the Evernode moment boundary

Evernode moment constants (mainnet, stable as of May 2026):
- `MOMENT_BASE_IDX = 1702531862` (Evernode epoch, unix seconds)
- `MOMENT_SIZE = 3600` (seconds per moment)

## Project Storage

```
~/.evernode-clusters/
├── .env                        ← global credentials (shared across all projects)
└── projects/
    └── my-project/
        ├── .env                ← project settings, CONTRACT_ID, PREFERRED_PEER, PREFERRED_BOOTSTRAP
        ├── contract/           ← contract files for bundling
        ├── cluster-nodes.json  ← node lease tracking
        └── hp-init.cfg         ← acquisition bootstrap config
```

### cluster-nodes.json schema

```json
{
  "pubkey": "ed...",
  "name": "ABC123...",
  "host": "rXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "domain": "host.example.com",
  "userPort": 26203,
  "peerPort": 22863,
  "createdTimestamp": 1777871676677,
  "lifeMoments": 3,
  "expiryMoment": 21091,
  "acquiredLeaseDrops": 100
}
```

## Repository Structure

```
evernode-cluster-manager/
├── client/
│   └── cluster-manager.js       ← single entry point, run directly with node
├── contract/
│   ├── src/
│   │   └── index.js             ← contract source (edit this)
│   ├── dist/
│   │   └── index.js             ← compiled output (deployed to cluster)
│   └── package.json
├── config/
│   └── .env.example             ← configuration reference
├── CHANGELOG.md
└── README.md
```

## Build Process

**If you changed `evernode-client-cluster-manager-pkg/src/index.js`:**
```bash
cd /home/chris/evernode-client-cluster-manager-pkg && npm run build
cd /home/chris/evernode-cluster-manager/contract && npm run build
# Then update contract via option 2
```

**If you changed only `contract/src/index.js`:**
```bash
cd /home/chris/evernode-cluster-manager/contract && npm run build
# Then update contract via option 2
```

**If you changed only `client/cluster-manager.js`:**
```bash
# No build needed — runs directly with node
node client/cluster-manager.js
```

## Key Concepts

**`acquiredLeaseDrops`** — lease price in drops at the time the node was acquired. Used at extend time to detect price changes vs the originally agreed price, independent of the 30-day stability window. Populated automatically on `opAddNode` and `opDeploy`. Null on nodes acquired before v3.4.0.

**Auto-failover:** `getActivePeer()` tries `PREFERRED_PEER` first, then falls back through `cluster-nodes.json` in order. The active peer updates automatically on failover and is saved as `LAST_NODE`.

**Consensus threshold:** Default 65%. Deliberately lower than Evernode's default 80% to allow nodes to be offline during upgrades.

**Bootstrap peer selection:** `PREFERRED_BOOTSTRAP` is used first. Falls back to `getBootstrapPeer` cluster recommendation, then `stat.peers[0]`.

**Memo size limit:** Xahau transactions have a hard 1KB memo limit. 1 UNL pubkey and max 2 peers in override configs, 1 peer in init configs. `cluster.info` is a bundle file with no size constraint.

**Full peer mesh:** After every node addition, removal, or promotion, all nodes receive the complete UNL peer list in `patch.cfg` `mesh.known_peers` via `ctx.updateConfig()`.

**Stale node pruning:** Nodes registered as non-UNL that never send MATURED within 5 moments are automatically removed from `cluster.json`.

**Ghost peer cleanup:** `removeNode` atomically cleans the UNL, `patch.cfg.known_peers`, and hpcore's `req_known_remotes` using FORCE-mode `ctx.updatePeers([], [peerStr])`.

**Vote status:** `synced` = healthy consensus. In HP debug logs `Vote status: 3` is the synced state code.

**Config-only upgrades:** Round time changes deploy a bundle without bumping the contract version. The `post_exec.sh` applies changes to `patch.cfg` via `jq`. hpcore reads `consensus.roundtime` dynamically — takes effect within one consensus round.

## Host Discovery API

Host lookups use `api.onledger.net` by default — no configuration required.

To use your own instance or a local Xahau node, add to `~/.evernode-clusters/.env`:

```env
HOST_API_URL=http://your-api:3001
XAHAU_WS=ws://localhost:6008
```

## Known Issues

### Extend lease decimal precision bug (upstream)

`extendLease` fails with `TRANSACTION_FAILURE` when extending by more than 1 moment on hosts with certain leaseAmount values (e.g. `0.00007`). JavaScript floating point multiplication produces imprecise results — `23 * 0.00007 = 0.0016099999999999999` — which exceeds Xahau's decimal precision limit. Single-moment extensions always succeed.

Fix submitted upstream: [EvernodeXRPL/evernode-js-client#244](https://github.com/EvernodeXRPL/evernode-js-client/pull/244).

**Local workaround:**
```bash
sed -i 's/moments \* uriInfo\.leaseAmount/parseFloat((moments * uriInfo.leaseAmount).toFixed(8))/' /usr/lib/node_modules/evdevkit/node_modules/evernode-js-client/index.js
```

### Log level change requires hpcore update

Changing log level via Cluster Settings writes to `patch.cfg` correctly but does not take effect on the running hpcore process — hpcore reads log level only at startup. A fix has been submitted upstream: [EvernodeXRPL/hpcore](https://github.com/EvernodeXRPL/hpcore). The log level menu option will be re-added once the fix is merged and deployed to Evernode hosts. Round time changes are not affected — hpcore reads `consensus.roundtime` dynamically.

### evdevkit cluster-create host deduplication bug

There is a known bug in `evdevkit cluster-create` where the chunk-size allocation algorithm can place two nodes on the same host when that host has more than 1 available slot. The cluster manager mitigates this by:

1. Verifying each host's slot count against the Xahau ledger as you enter addresses
2. Warning when no single-slot host is selected
3. Detecting duplicate host assignments post-deploy and warning immediately

A patch for `evdevkit` is available in the `patches/` directory of this repository. Apply with:

```bash
cd patches && bash apply-patch1.sh
```

### Peer port compliance

Not all Evernode hosts have their peer port open to inbound connections from unknown nodes. The cluster manager mitigates this by using the `getBootstrapPeer` handler to select a known-good peer from the running cluster.

## Important Notes

- The `.env` files contain private keys — never commit them to git (gitignored by default)
- Never use non-deterministic values in contract outputs — all nodes must produce identical outputs
- Always ensure the cluster is `synced` before performing upgrade or node operations
- Minimum viable cluster size is 3 nodes
- Backups of contract state are created automatically before each upgrade (last 5 kept)
- If an upgrade fails, `post_exec.sh` automatically rolls back `patch.cfg`
- When managing large clusters (7+ nodes), stagger lease expiry times to protect consensus against simultaneous node loss
- Set `DEBUG=true` in `~/.evernode-clusters/.env` to enable debug logging to `~/.evernode-clusters/cluster-manager.log`. Log rotates at 2MB.
