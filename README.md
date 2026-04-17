# Evernode Client Cluster Manager

A single tool for deploying and managing multiple HotPocket smart contract clusters on Evernode. No host filesystem access required.

## What It Does

- Manages multiple independent cluster projects from one tool
- Deploys multi-node HotPocket contract clusters on Evernode hosts
- Updates contract code live without restarting nodes or losing consensus
- Adds external nodes to a running cluster — new nodes sync automatically, no manual bundle/deploy required
- Removes nodes cleanly including stale peer cleanup
- Reads logs remotely from any node in the cluster (hp.log, stdout, stderr) — no SSH required
- Monitors cluster health, consensus status and vote state
- Detects weakly connected nodes and offers automatic cluster repair
- Discovers available Evernode hosts with operator diversity filtering and heartbeat quality validation
- Tracks node lease expiry and extends leases
- Reports broken hosts to exclude them from future searches

## Requirements

- Node.js v20+
- `evdevkit` installed globally: `npm i evdevkit -g`
- An XRPL/Xahau wallet funded with XAH and EVR tokens (tenant account)

> **Note:** The tool attempts to use locally installed `ws` and `evernode-js-client` packages first, falling back to the evdevkit global installation. If you encounter module not found errors, run `npm install` in the `client/` directory:
> ```bash
> cd client && npm install
> ```

## Quick Start

```bash
git clone https://github.com/rippleitinnz/evernode-cluster-manager
cd evernode-cluster-manager
node client/cluster-manager.js
```

On first run the tool will prompt for credentials and create your first project. `HOST_API_URL=https://api.onledger.net` is written to your global credentials file automatically.

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
  9. Switch project
  0. Exit
```

### Option 1 — Check Status

Shows contract version, HP version, vote status, LCL, round time, UNL nodes with domain and time remaining, and connected peers. `Vote Status: synced` confirms healthy consensus. In HP debug logs, `Vote status: 3` is the synced state code — not a node count.

If the cluster is weakly connected (one or more nodes unreachable), the status will show `⚠  WEAKLY CONNECTED` and identify the unreachable node(s). You will be offered the option to automatically replace them — the tool adds a new node, waits for stabilisation, then offers to remove the dead one.

### Option 2 — Update Contract

Enter a new version string. The tool bumps the version, rebuilds via `npm run build` (using `@vercel/ncc` to produce a single `dist/index.js`), bundles with `evdevkit bundle`, sends to the cluster as a consensus input, and polls until all nodes confirm the new version. No restarts required.

> **Consensus threshold note:** The default threshold is **66%** — not Evernode's default 80%. With 3 nodes at 66%, only 2 of 3 must agree, meaning one node can be temporarily offline and upgrades still succeed. At 80% with 3 nodes all three must agree, giving zero fault tolerance. For clusters of 5+ nodes, 80% becomes more viable.

### Option 3 — Add a Node

The tool writes a minimal `hp-init.cfg` with the contract ID, one peer address, one UNL pubkey, consensus settings and log level, then acquires the instance using `EV_HP_INIT_CFG_PATH`. HotPocket automatically syncs contract code, state and config from the existing cluster. No bundle or deploy step required. The new pubkey is then added to the UNL via consensus input and the tool polls until the cluster is synced.

### Option 4 — Remove a Node

Select a node by index or pubkey. Removes from UNL and automatically cleans up the stale peer connection. Will not remove if cluster would drop below 3 nodes.

### Option 5 — Check Node Expiry

Shows time remaining for each tracked node with expiry timestamp in UTC. The `Purchased` column shows total lease duration bought — `Remaining` shows how much is left.

### Option 6 — Extend Node Lease

Select a node by index or `all` to extend all nodes. Specify how many additional moments (1 moment = 1 hour) to add.

### Option 7 — Find Available Hosts

Queries the Host Discovery API for active hosts. Results are deduplicated by operator — maximum 3 hosts per operator — so no single operator dominates the list. Only hosts with a proven heartbeat in each of the last 3 hourly windows are returned.

After viewing results you can report a broken host by entering its full XRPL address. Always use the complete address — many hosts share similar prefixes. Reported hosts are excluded from searches for 7 days.

### Option 8 — Read Node Log

Select any node and choose which log to read: `hp.log` (HotPocket consensus/network), `rw.stdout.log` (contract stdout), or `rw.stderr.log` (contract stderr). Specify line count and optionally enable auto-refresh every 5 seconds. No SSH access required — logs are retrieved via the contract's read request mechanism.

> **Note:** `hp.log` is only created when the HP log level is set to `dbg`. The cluster manager patches `hp.cfg` to `dbg` on every contract upgrade. New nodes added via Option 3 receive `dbg` log level at acquire time.

## Built-in Contract Handlers

| Handler | Type | Purpose |
|---------|------|---------|
| `status` | readonly | Returns version, contractId, publicKey, lcl |
| `readCfg` | readonly | Returns current patch.cfg contents |
| `readLog` | readonly | Returns hp.log lines |
| `readContractLog` | readonly | Returns rw.stdout.log or rw.stderr.log |
| `upgrade` | consensus | Handles contract bundle upgrade via post_exec.sh |
| `addNode` | consensus | Adds pubkey to UNL and peer connection |
| `removeNode` | consensus | Removes pubkey from UNL and peer connection |
| `removePeer` | consensus | Removes a stale peer connection |

## Project Storage

```
~/.evernode-clusters/
├── .env                        <- global credentials (shared across all projects)
└── projects/
    └── my-project/
        ├── .env                <- project settings
        ├── contract/           <- contract files for bundling
        ├── cluster-nodes.json  <- node lease tracking
        └── hp-init.cfg         <- acquisition bootstrap config
```

## Contract Structure

```
evernode-cluster-manager/
├── client/
│   └── cluster-manager.js      <- single entry point
├── contract/
│   ├── src/
│   │   └── index.js            <- contract source (edit this)
│   ├── dist/
│   │   └── index.js            <- compiled output (deployed to cluster)
│   └── package.json
├── CHANGELOG.md
└── layout.md                   <- full contract upgrade process documentation
```

## Key Concepts

**Consensus threshold:** Default 66%. With 3 nodes, 2 must agree. Deliberately lower than Evernode's default 80% to allow one node to be offline during upgrades without blocking operations.

**Adding nodes:** New nodes sync everything automatically from the existing cluster via HotPocket's built-in sync mechanism. Only the contract ID, one peer address and one UNL pubkey are needed at acquire time.

**Vote status:** `synced` = healthy consensus. In HP debug logs `Vote status: 3` is the synced state code.

**Log access:** hp.log and contract logs can be read remotely from any node via contract handlers — no SSH or host filesystem access needed.

**Node tracking:** All nodes saved to `cluster-nodes.json` with pubkey, domain, ports, creation timestamp and life moments. Stale entries reconciled automatically against the live UNL.

**Life moments:** Each moment is 1 hour. The `Purchased` column shows total lease duration bought — `Remaining` shows how much is left.

**Expiry alerts:** A background monitor runs every 30 minutes and warns when nodes are close to expiry. Only triggers for nodes with 12 or more purchased moments. Configure via `ALERT_HOURS` (default 6) and `ALERT_MIN_MOMENTS` (default 12) in your project `.env`.

**Heartbeat filter:** The host finder only returns hosts with a proven heartbeat in each of the last 3 hourly windows. This ensures consistently active hosts rather than ones that sent a single heartbeat and went quiet.

**Cluster health:** If a node becomes unreachable, `Vote Status` shows `⚠  WEAKLY CONNECTED`. The tool identifies the unreachable node and offers to replace it automatically.

**Reporting bad hosts:** After finding hosts (option 7), enter the full host XRPL address to report a host that failed to accept a contract or has closed ports. Always use the full address — many hosts share similar prefixes. Reported hosts are excluded from future searches for 7 days.

## Host Discovery API

Host lookups use `api.onledger.net` by default — no configuration required.

To use your own instance, or to point to a local Xahau node for host verification, add to `~/.evernode-clusters/.env`:

```env
# Only needed if running your own Host Discovery API
HOST_API_URL=http://your-api:3001

# Only needed if running a local Xahau node (defaults to wss://xahau.network)
# XAHAU_WS=ws://localhost:6008
```

`XAHAU_WS` is not used for host discovery — it connects to the Evernode registry to verify a specific host's slot availability before committing a lease payment.

## Important Notes

- The `.env` files contain private keys — never commit them to git (gitignored by default)
- Never use `new Date()` or non-deterministic values in contract outputs — all nodes must produce identical outputs
- Always ensure the cluster is `synced` before performing upgrade or node operations
- Minimum viable cluster size is 3 nodes
- Backups of contract state are created automatically before each upgrade (last 5 kept)
- If an upgrade fails, `post_exec.sh` automatically rolls back `patch.cfg`

## Using Your Own Contract

You can deploy and manage your own contract using the cluster manager. The only requirement is that your contract includes the 8 built-in management handlers alongside your own business logic — without them you lose the ability to manage the cluster remotely.

### Step 1 — Start from the template

Use `contract/src/index.js` directly and add your logic to it, or copy it as a starting point:

```bash
cp contract/src/index.js contract/src/my-contract.js
```

### Step 2 — Add your business logic

Open `contract/src/index.js` and add your own handlers inside the existing switch statement. The management handlers must remain intact:

```javascript
const handleMyAction = async (user, msg, ctx) => {
    // your code here
    await send(user, { type: 'myAction', status: 'ok' });
};

// Add alongside existing handlers in the switch statement:
case 'myAction': await handleMyAction(user, msg, ctx); break;
```

### Step 3 — Install your dependencies

Add any packages your contract needs to `contract/package.json`, then:

```bash
npm install --prefix contract
```

### Step 4 — Build

```bash
cd contract && npm run build
```

This compiles your contract and all dependencies into a single `dist/index.js`.

### Step 5 — Deploy

Create a new project in the cluster manager. When asked for the contract source, select option 2 and point it to `contract/dist/`. From there the cluster manager handles everything — deploy, upgrade, add/remove nodes — exactly as with the default contract.

### Critical rules

- **Keep all 8 management handlers** — removing any of them will break cluster management
- **No non-deterministic values in outputs** — never use `new Date()`, `Math.random()` or any value that differs between nodes. All nodes must produce identical output for consensus
- **Version constant required** — keep `const VERSION = 'x.x.x'` and bump it on every upgrade so the cluster manager can confirm the upgrade succeeded
- **Readonly handlers** — any handler you want to call without going through consensus must be placed in the `ctx.readonly` block

### Future — Module approach

A future version will provide an npm package you can simply `require` in your contract:

```javascript
const ClusterManager = require('evernode-cluster-manager');
ClusterManager.init(ctx);
// Your business logic here
```

This is planned but not yet implemented.
