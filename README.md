# Evernode Client Cluster Manager

A single tool for deploying and managing multiple HotPocket smart contract clusters on Evernode. No host filesystem access required.

## What It Does

- Manages multiple independent cluster projects from one tool
- Deploys multi-node HotPocket contract clusters on Evernode hosts
- Updates contract code live without restarting nodes or losing consensus
- Adds external nodes to a running cluster — bootstrap peer is displayed and selectable before acquire
- Removes nodes cleanly with stale peer entry cleanup from patch.cfg and live hpcore flush
- Reads logs and config remotely from any node (hp.log, stdout, stderr, hp.cfg, patch.cfg, env.vars) — no SSH required
- Monitors cluster health, consensus status and vote state per node — LCL hash comparison, weaklyConnected status, safe-to-remove assessment
- Detects weakly connected nodes and offers automatic cluster repair
- Tracks node lease expiry with accurate to-the-second display — chain-confirmed after first extension
- Extends leases with full on-chain confirmation — only updates local records when blockchain confirms success
- Discovers available Evernode hosts with operator diversity filtering and heartbeat quality validation
- Reports broken hosts to exclude them from future searches
- Auto-prunes stale non-UNL nodes from cluster state after 5 moments of inactivity
- Maintains full peer mesh in `patch.cfg` across all nodes — cold restarts always find live peers

## What's new in v3.2.0

**Bootstrap peer selection is now visible and overridable.** Before acquire, `opAddNode` displays all available peers and highlights the cluster-recommended one. Press Enter to accept or select a different peer by number. Previously the peer was selected silently with no visibility or ability to override.

**MATURED flow fixed end-to-end.** New nodes now reliably join the UNL. The root cause was a dynamic `require('hotpocket-js-client')` inside `checkAndSendMatured` that ncc could not statically bundle — the module was silently absent from the compiled output and the function failed every round. Fixed in npm package 1.3.0.

**Full peer mesh in `patch.cfg`.** After every node addition, removal, or promotion, all nodes receive the complete UNL peer list in `patch.cfg` `mesh.known_peers`. Previously nodes only had their single bootstrap peer, meaning a cold restart with a dead bootstrap peer left the node isolated.

**`cluster.info` now contains the full UNL.** The bootstrap file deployed to new nodes previously contained only one anchor node. It now contains all current UNL nodes, giving new nodes multiple peers to try when sending MATURED.

**Stale `cluster.info` cleanup.** `opDeploy` now deletes any leftover `cluster.info` from `contract/dist/` before bundling. Previously a file from a prior `opAddNode` run could be bundled into a fresh cluster deploy, giving every node stale peer data from a different cluster.

**Poll condition fixed.** Step 4 of `opAddNode` now polls for `UNL >= expectedUnl` instead of `UNL === expectedUnl`. If multiple pending nodes are promoted simultaneously the UNL count can jump past the expected value — the strict equality check would then never resolve and always time out.

**Timeout error message fixed.** A poll timeout in step 4 now correctly reports "Timed out waiting for node to join UNL" instead of the misleading "Bundle deploy failed".

**Blake3 warning suppressed.** All `npm install` calls now pass `BLAKE3_FORCE_WASM=1`, suppressing the native binding download warning that appeared on every install.

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

const VERSION = '1.2.0';

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
- **Keepalive NPL broadcast every 15 ledgers** — `ctx.unl.send()` pushes an empty NPL message through the Node Protocol Layer. This forces regular peer-to-peer traffic via the consensus channel even when there's no business logic activity. Useful for diagnostic visibility (NPL packets appear in `hp.log` and confirm peer responsiveness) and for ensuring the consensus engine keeps observable activity on otherwise-idle clusters. At the default 8-second roundtime this fires every ~2 minutes. Harmless to remove if your contract has continuous activity from another source.
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

Pick this and the tool uses the contract shipped in `contract/dist/`. Nothing else to do — proceed straight to deployment. Use this when you only need the cluster management features (status, log access, node add/remove, live upgrades) without custom business logic.

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
    "evernode-client-cluster-manager": "^1.2.2"
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

**What the tool does when you pick option 2:**

1. Copies every **top-level file** from your directory into the project's `contract/` folder. Subdirectories and `node_modules` are skipped.
2. Runs `npm install --prefix <project>/contract` to install your declared dependencies.
3. Overwrites `node_modules/evernode-client-cluster-manager` with the ncc-bundled copy from the tool's own `contract/dist/`. This guarantees the deployed handler code matches what the CLI was tested against — your declared version in `package.json` only needs to exist for npm to populate `node_modules/`, the actual bytes get replaced.
4. If `index.js` contains `const CONTRACT_VERSION = '...'`, the tool updates it to the version you entered at project setup.

**Constraints:**

- **Flat layout only.** The CLI does not recursively copy subdirectories. Keep all contract source files at the top level. If you need to factor code, do it as multiple `.js` files alongside `index.js`, not as a folder tree.
- **Your `package.json` must declare `evernode-client-cluster-manager`.** Without it, `npm install` creates no `node_modules/` directory, and `ensureNccBundle` has nowhere to write — the deploy will fail.
- **Run `npm init -y` before `npm install` when building a fresh contract directory from scratch.** Without a `package.json` in the directory, npm walks up to a parent and silently installs nothing.

### Critical rules for any custom contract

- **Call `ClusterManager.init()` first.** It handles all management inputs and the autonomous round logic. If it returns `true`, a management input was processed — your business logic must not run that round.
- **No non-deterministic values in outputs.** Never use `new Date()`, `Math.random()`, or any value that differs between nodes. All nodes must produce identical output for consensus.
- **Keep a `VERSION` constant** and pass it to `ClusterManager.init()`. The CLI's `Update contract` flow polls this string to confirm deployment succeeded.
- **Readonly handlers belong inside the `ctx.readonly` block.** `ClusterManager.init()` handles its own readonly handlers internally — any of your own readonly handlers must check `ctx.readonly` and run in that path.

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
 10. Switch project
  0. Exit
```

### Option 1 — Check Status

Shows contract version, HP version, vote status, LCL, round time, UNL nodes with domain and time remaining, and connected peers. `Vote Status: synced` confirms healthy consensus. In HP debug logs `Vote status: 3` is the synced state code.

If the cluster is weakly connected, the status shows `⚠  WEAKLY CONNECTED` and identifies the unreachable node(s). You are offered the option to automatically replace them — the tool adds a new node, waits for stabilisation, then offers to remove the dead one.

A parallel health check runs across all nodes showing per-node LCL hash, weaklyConnected status and overall safe-to-remove assessment. Hash mismatches are flagged as a possible fork.

### Option 2 — Update Contract

Enter a new version string. The tool bumps the version, rebuilds via `npm run build` (using `@vercel/ncc` to produce a single bundled `dist/index.js`), bundles with `evdevkit bundle`, sends to the cluster as a consensus input, and polls until all nodes confirm the new version. No restarts required.

> **Consensus threshold note:** The default threshold is **65%**. With 3 nodes, only 2 must agree, meaning one node can be temporarily offline and upgrades still succeed. For production clusters of 7+ nodes, consider whether a higher threshold is appropriate for your use case.

### Option 3 — Add a Node

The tool queries the running cluster for the optimal bootstrap peer — the cluster selects the most stable node based on `cluster.json` state (original deploy nodes first, then promoted nodes by seniority). The available peers are then displayed and you can select a different one if needed. The selected peer is written into the acquire init config as a single peer entry to stay within the Xahau memo size limit.

After acquire, the tool registers the new node in the cluster via consensus, writes `cluster.info` containing all current UNL nodes, rebuilds the bundle and deploys it. The new node connects to the mesh, syncs state, and sends a MATURED signal — the cluster promotes it to UNL automatically after a stability threshold.

### Option 4 — Remove a Node

Select a node by index or pubkey. Removes from UNL and cluster state via consensus, waits for the cluster to resync, then cleans up the stale peer entry from patch.cfg and flushes hpcore's retry queue. Will not remove if cluster would drop below 3 nodes. Offers to report the host after removal.

### Option 5 — Check Node Expiry

Shows time remaining for each tracked node with expiry timestamp in UTC, accurate to the second. The `Source` column shows `chain` (confirmed from on-chain extension response) or `local` (calculated from `createdTimestamp + lifeMoments × 3600`, accurate until first extension). Warns when any node is within 6 hours of expiry.

> **⚠ Staggering warning:** When managing clusters of 5+ nodes, ensure lease expiry times are staggered across nodes. Never allow more than `UNL_count − ceil(UNL_count × threshold)` nodes to expire simultaneously — simultaneous expiry of too many nodes will destroy consensus and may be unrecoverable. Extend nodes in batches with at least 1 moment offset between batches.

### Option 6 — Extend Node Lease

Select nodes by index, comma-separated indices, or `all`. Uses `tenant.extendLease()` directly for full on-chain confirmation. `cluster-nodes.json` is only updated when the blockchain confirms success — silent failures are impossible. The confirmed `expiryMoment` from the chain response is stored for accurate future expiry display. Failed extensions are reported per-node with the chain error reason.

> **Note:** When extending multiple instances on the same host, extend them one at a time. Extending two instances on the same host in the same session can cause transaction failures due to sequence number conflicts. This will be fixed in a future release.

### Option 7 — Find Available Hosts

Queries the Host Discovery API for active hosts. Results are deduplicated by operator — maximum 3 hosts per operator. Only hosts with a proven heartbeat in each of the last 3 hourly windows are returned. Hosts can be reported as broken directly from this view.

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

### Option 10 — Switch Project

Return to the project selector without exiting the tool.

## Cluster Resilience

When deploying a cluster, avoid placing more than one node on the same Evernode host. If that host goes offline you lose multiple UNL nodes simultaneously — in a 3-node cluster losing 2 nodes makes consensus unrecoverable.

The `evdevkit cluster-create` command has a known chunk-size bug that can assign multiple nodes to the same host when that host has more than 1 available slot. The cluster manager detects this post-deploy and warns you. To minimise risk, prefer hosts with exactly 1 available slot — the tool identifies and surfaces these automatically.

> **⚠ Expiry staggering:** As your cluster grows, always stagger lease expiry times. At a 65% threshold with 8 nodes you can afford to lose at most 2 nodes simultaneously. If 3 or more nodes expire in the same moment, consensus is broken. Extend nodes in batches — never extend all nodes by the same amount at the same time if they already share an expiry moment.

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

- **`checkAndPromoteMatured`** — promotes acknowledged nodes to UNL after stability threshold. Writes full peer list to `patch.cfg` and broadcasts to all nodes via `ctx.updatePeers()`. Also auto-prunes nodes stuck in `status: created` for more than 5 moments (never acknowledged, definitively failed).
- **`checkAndSendMatured`** — runs on non-UNL nodes. Reads `cluster.info` (full UNL peer list) to find existing nodes, connects and sends MATURED signal when synced. Retries up to 3 times.

## Node Expiry Tracking

Expiry is tracked in `cluster-nodes.json` per node:

- **Before first extension:** `createdTimestamp + lifeMoments × 3600` — accurate to the second, matches `evernode list` exactly
- **After first extension:** `expiryMoment` stored from on-chain chain response — `MOMENT_BASE_IDX + (expiryMoment × 3600)` — accurate to the Evernode moment boundary

The `Source` column in option 5 shows which method is in use. Both are accurate — `chain` is preferred.

Evernode moment constants (mainnet, stable as of May 2026):
- `MOMENT_BASE_IDX = 1702531862` (Evernode epoch, unix seconds)
- `MOMENT_SIZE = 3600` (seconds per moment)

## Project Storage

```
~/.evernode-clusters/
├── .env                        ← global credentials (shared across all projects)
└── projects/
    └── my-project/
        ├── .env                ← project settings and CONTRACT_ID
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
  "expiryMoment": 21091
}
```

`expiryMoment` is populated after the first confirmed on-chain extension. Before that, expiry is calculated from `createdTimestamp + lifeMoments × 3600`.

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
├── CHANGELOG.md
└── README.md
```

## Build Process

When making changes, always follow this order:

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

**Consensus threshold:** Default 65%. Deliberately lower than Evernode's default 80% to allow nodes to be offline during upgrades without blocking operations.

**Bootstrap peer selection:** When adding a node, the running cluster is queried via `getBootstrapPeer` to select the most stable peer. Original deploy nodes are preferred over promoted nodes. The available peers are displayed and can be overridden. The selected peer is used as the single `known_peers` entry in the acquire init config to stay within the Xahau memo size limit.

**Memo size limit:** Xahau transactions have a hard 1KB memo limit. The cluster manager enforces: 1 UNL pubkey and max 2 peers in override configs, 1 peer in init configs. `cluster.info` is a bundle file with no size constraint and contains the full UNL peer list.

**Full peer mesh:** After every node addition, removal, or promotion, all nodes receive the complete UNL peer list in `patch.cfg` `mesh.known_peers` via `ctx.updateConfig()`. This ensures cold restarts can always find live peers regardless of which bootstrap peer was originally used.

**Stale node pruning:** Nodes registered as non-UNL that never send MATURED within 5 moments are automatically removed from `cluster.json` by the contract. This prevents ghost entries accumulating from failed add attempts.

**Adding nodes:** The new node receives a minimal bootstrap config (1 peer, 1 UNL key) at acquire time. It syncs full cluster state automatically from its first peer connection via HotPocket's built-in sync mechanism. `cluster.info` contains the full UNL peer list for the MATURED flow.

**Ghost peer cleanup (resolved as of npm package 1.2.1):** When a node is removed via `opRemoveNode`, the contract atomically cleans three layers on every UNL node: the UNL itself, `patch.cfg.known_peers`, and hpcore's in-memory `req_known_remotes` retry queue. The req_known_remotes flush uses `ctx.updatePeers([], [peerStr])` which routes through hpcore's FORCE-mode update path — surgical, removes only the named peer, safe to fire simultaneously across all UNL nodes during the consensus round. The earlier `purgePeers` handler (OVERWRITE mode via `ctx.updatePeers(peers, "*")`) was removed in npm 1.2.2: it cleared the entire peer table and closed all live sessions, which collapsed the cluster when every UNL node ran it simultaneously. There is no remaining unsafe code path for peer cleanup.

**Vote status:** `synced` = healthy consensus. In HP debug logs `Vote status: 3` is the synced state code.

**Log access:** All logs and configs can be read remotely from any node via contract read handlers — no SSH or host filesystem access needed.

**Expiry alerts:** Option 5 warns when nodes are within 6 hours of expiry. Configure via `ALERT_HOURS` in your project `.env`.

**Heartbeat filter:** The host finder only returns hosts with a proven heartbeat in each of the last 3 hourly windows, ensuring consistently active hosts.

**Reporting bad hosts:** After finding hosts (option 7) or removing a node (option 4), enter the full host Xahau address to report a host that failed to accept a contract or has closed ports. Reported hosts are excluded for 7 days.

## Host Discovery API

Host lookups use `api.onledger.net` by default — no configuration required.

To use your own instance or a local Xahau node, add to `~/.evernode-clusters/.env`:

```env
HOST_API_URL=http://your-api:3001
XAHAU_WS=ws://localhost:6008
```

`XAHAU_WS` is used for host slot verification before committing a lease payment, and for lease extension transactions.

## Known Issues

### Extend lease decimal precision bug (upstream)

`extendLease` fails with `TRANSACTION_FAILURE` when extending by more than 
1 moment on hosts with certain leaseAmount values (e.g. 0.00007). JavaScript 
floating point multiplication produces imprecise results — 
23 * 0.00007 = 0.0016099999999999999 — which exceeds Xahau's decimal 
precision limit. Single-moment extensions always succeed.

A fix has been submitted upstream: [evernode-js-client PR #XXX](link).

**Local workaround:** patch the installed evdevkit:
```bash
sed -i 's/moments \* uriInfo\.leaseAmount/parseFloat((moments * uriInfo.leaseAmount).toFixed(8))/' /usr/lib/node_modules/evdevkit/node_modules/evernode-js-client/index.js
```

What's the PR number from GitHub?
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

Not all Evernode hosts have their peer port open to inbound connections from unknown nodes. The cluster manager mitigates this by using the `getBootstrapPeer` handler to select a known-good peer from the running cluster rather than a random peer from the status output.

Future versions will integrate peer port compliance data from the Host Discovery API to further improve bootstrap peer selection.

## Important Notes

- The `.env` files contain private keys — never commit them to git (gitignored by default)
- Never use non-deterministic values in contract outputs — all nodes must produce identical outputs
- Always ensure the cluster is `synced` before performing upgrade or node operations
- Minimum viable cluster size is 3 nodes
- Backups of contract state are created automatically before each upgrade (last 5 kept)
- If an upgrade fails, `post_exec.sh` automatically rolls back `patch.cfg`
- When managing large clusters (7+ nodes), stagger lease expiry times to protect consensus against simultaneous node loss
- Set `DEBUG=true` in `~/.evernode-clusters/.env` to enable debug logging. All console output is mirrored to `~/.evernode-clusters/cluster-manager.log` with timestamps. Log rotates at 2MB, keeping one previous log as `cluster-manager.log.1`. Remove or set `DEBUG=false` to disable.
