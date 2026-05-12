# Evernode Client Cluster Manager

A single tool for deploying and managing multiple HotPocket smart contract clusters on Evernode. No host filesystem access required.

## What It Does

- Manages multiple independent cluster projects from one tool
- Deploys multi-node HotPocket contract clusters on Evernode hosts
- Updates contract code live without restarting nodes or losing consensus
- Adds external nodes to a running cluster — cluster selects the optimal bootstrap peer automatically
- Removes nodes cleanly with stale peer entry cleanup from patch.cfg
- Reads logs and config remotely from any node (hp.log, stdout, stderr, hp.cfg, patch.cfg, env.vars) — no SSH required
- Monitors cluster health, consensus status and vote state per node — LCL hash comparison, weaklyConnected status, safe-to-remove assessment
- Detects weakly connected nodes and offers automatic cluster repair
- Tracks node lease expiry with accurate to-the-second display — chain-confirmed after first extension
- Extends leases with full on-chain confirmation — only updates local records when blockchain confirms success
- Discovers available Evernode hosts with operator diversity filtering and heartbeat quality validation
- Reports broken hosts to exclude them from future searches
- Auto-prunes stale non-UNL nodes from cluster state after 5 moments of inactivity

## Requirements

- Node.js v20+
- `evdevkit` installed globally with host deduplication patch applied (see Known Issues)
- A Xahau wallet funded with XAH and EVR tokens (tenant account)

## Contract npm Package

The cluster management contract handlers are available as a standalone npm package for use in your own HotPocket contracts:

```bash
npm install evernode-client-cluster-manager
```

```js
const ClusterManager = require('evernode-client-cluster-manager');
const VERSION = '1.0.0';

const contract = async (ctx) => {
    if (await ClusterManager.init(ctx, VERSION)) return;
    // your business logic here
};

const hpc = new HotPocket.Contract();
hpc.init(contract);
```

See [evernode-client-cluster-manager on npm](https://www.npmjs.com/package/evernode-client-cluster-manager) for full documentation.

## Quick Start

```bash
git clone https://github.com/rippleitinnz/evernode-cluster-manager
cd evernode-cluster-manager
node client/cluster-manager.js
```

On first run the tool prompts for credentials and creates your first project. `HOST_API_URL=https://api.onledger.net` is written to your global credentials file automatically.

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

The tool queries the running cluster for the optimal bootstrap peer — the cluster selects the most stable node based on `cluster.json` state (original deploy nodes first, then promoted nodes by seniority). This is then written into the acquire init config as a single peer entry to stay within the Xahau memo size limit.

After acquire, the tool registers the new node in the cluster via consensus, writes a minimal `cluster.info` bootstrap file (anchor node + new node only), rebuilds the bundle and deploys it. The new node then sends a MATURED signal when synced — the cluster promotes it to UNL automatically after a stability threshold.

### Option 4 — Remove a Node

Select a node by index or pubkey. Removes from UNL and cluster state via consensus, waits for the cluster to resync, then cleans up the stale peer entry from patch.cfg. Will not remove if cluster would drop below 3 nodes. Offers to report the host after removal.

### Option 5 — Check Node Expiry

Shows time remaining for each tracked node with expiry timestamp in UTC, accurate to the second. The `Source` column shows `chain` (confirmed from on-chain extension response) or `local` (calculated from `createdTimestamp + lifeMoments × 3600`, accurate until first extension). Warns when any node is within 6 hours of expiry.

> **⚠ Staggering warning:** When managing clusters of 5+ nodes, ensure lease expiry times are staggered across nodes. Never allow more than `UNL_count − ceil(UNL_count × threshold)` nodes to expire simultaneously — simultaneous expiry of too many nodes will destroy consensus and may be unrecoverable. Extend nodes in batches with at least 1 moment offset between batches.

### Option 6 — Extend Node Lease

Select a node by index or `all`. Uses `tenant.extendLease()` directly for full on-chain confirmation. `cluster-nodes.json` is only updated when the blockchain confirms success — silent failures are impossible. The confirmed `expiryMoment` from the chain response is stored for accurate future expiry display. Failed extensions are reported per-node with the chain error reason.

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
| `addNode` | consensus | Registers new node as non-UNL pending MATURED |
| `removeNode` | consensus | Removes node from UNL and cluster state |
| `removePeer` | consensus | Removes stale peer from patch.cfg |
| `purgePeers` | consensus | OVERWRITE clears in-memory peer table to current UNL |
| `matured` | consensus | Receives MATURED signal from new non-UNL node |

## Autonomous Contract Behaviour

The contract runs autonomous logic every consensus round regardless of user input:

- **`checkAndPromoteMatured`** — promotes acknowledged nodes to UNL after stability threshold. Also auto-prunes nodes stuck in `status: created` for more than 5 moments (never acknowledged, definitively failed).
- **`checkAndSendMatured`** — runs on non-UNL nodes. Connects to UNL nodes and sends MATURED signal when the node has synced. Retries up to 3 times.

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

## Contract Structure

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

## Key Concepts

**Consensus threshold:** Default 65%. Deliberately lower than Evernode's default 80% to allow nodes to be offline during upgrades without blocking operations.

**Bootstrap peer selection:** When adding a node, the running cluster is queried via `getBootstrapPeer` to select the most stable peer. Original deploy nodes are preferred over promoted nodes. The selected peer is used as the single `known_peers` entry in the acquire init config to stay within the Xahau memo size limit.

**Memo size limit:** Xahau transactions have a hard 1KB memo limit. The cluster manager enforces: 1 UNL pubkey and max 2 peers in override configs, 1 peer in init configs, and anchor-node-only in `cluster.info`. This allows clusters to scale beyond 6 nodes without transaction failures.

**Stale node pruning:** Nodes registered as non-UNL that never send MATURED within 5 moments are automatically removed from `cluster.json` by the contract. This prevents ghost entries accumulating from failed add attempts.

**Adding nodes:** The new node receives a minimal bootstrap config (1 peer, 1 UNL key) at acquire time. It syncs full cluster state automatically from its first peer connection via HotPocket's built-in sync mechanism.

**Ghost peer purge:** When a node is removed, its peer address is cleaned from `patch.cfg` via the `removePeer` handler. In-memory peer table cleanup via `purgePeers` (OVERWRITE mode) is available as a manual operation under research — it is not auto-fired as simultaneous OVERWRITE across all nodes can disrupt consensus.

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

## Using Your Own Contract

You can deploy and manage your own contract using the cluster manager. The only requirement is that your contract includes the cluster management npm package:

```bash
npm install evernode-client-cluster-manager
```

```js
'use strict';
const HotPocket      = require('hotpocket-nodejs-contract');
const ClusterManager = require('evernode-client-cluster-manager');
const VERSION        = '1.0.0';

const contract = async (ctx) => {
    if (await ClusterManager.init(ctx, VERSION)) return;

    // Your business logic here
    if (ctx.readonly) return;

    for (const user of ctx.users.list()) {
        for (const input of user.inputs) {
            const buf = await ctx.users.read(input);
            const msg = JSON.parse(buf.toString());
            if (msg.type === 'myAction') {
                await user.send(JSON.stringify({ type: 'myAction', status: 'ok' }));
            }
        }
    }
};

const hpc = new HotPocket.Contract();
hpc.init(contract);
```

### Critical rules

- **Call `ClusterManager.init()` first** — it handles all management inputs and autonomous round logic. If it returns `true` a management input was processed and your code should not run.
- **No non-deterministic values in outputs** — never use `new Date()`, `Math.random()` or any value that differs between nodes. All nodes must produce identical output for consensus.
- **Version constant required** — keep a version string and pass it to `ClusterManager.init()` so the cluster manager can confirm upgrades succeeded.
- **Readonly handlers** — any handler you want callable without consensus must be placed in the `ctx.readonly` block. `ClusterManager.init()` handles this automatically for its own handlers.

## Known Issues

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
- When managing large clusters (7+ nodes), stagger lease expiry times to prevent simultaneous expiry destroying consensus
