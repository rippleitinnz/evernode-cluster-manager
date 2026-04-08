# Evernode Cluster Manager

A tenant-side toolkit for deploying and managing HotPocket smart contract clusters on Evernode. No host access required.

## What It Does

- Deploys a multi-node HotPocket contract cluster on Evernode hosts
- Updates contract code live without restarting nodes or losing consensus
- Adds external nodes to a running cluster without restarting
- Removes nodes from a running cluster
- Monitors cluster health and consensus status
- Discovers available Evernode hosts with pricing

## Requirements

- Node.js v20+
- evdevkit installed globally: `npm i evdevkit -g`
- An XRPL wallet funded with EVR tokens (tenant account)
- One or more Evernode host XRPL addresses to deploy to

## Quick Start
```bash
git clone https://github.com/rippleitinnz/evernode-cluster-manager
cd evernode-cluster-manager
bash setup.sh
```

`setup.sh` asks for your credentials and preferences, generates all config files, and installs dependencies. At the end it shows you the exact commands to run next.

## Step by Step

### 1. Run setup
```bash
bash setup.sh
```

Creates your project directory (e.g. `~/evernode_client`) with all config files generated from your answers.

### 2. Find available hosts (optional but recommended)

Scans the Evernode network for active hosts with available slots and pricing:
```bash
# Find 20 hosts with at least 1 available slot (default)
node ~/evernode_client/client/find-hosts.js

# Find 10 hosts with at least 3 available slots
node ~/evernode_client/client/find-hosts.js 3 10
```

Copy host addresses from the results to use when deploying.

### 3. Deploy a cluster
```bash
bash ~/evernode_client/client/deploy.sh
```

Prompts you for the number of nodes (minimum 3), host XRPL addresses, and life moments (~1 hour each). At the end it prints your **contract ID** — save this.

### 4. Manage the cluster
```bash
node ~/evernode_client/client/cluster-manager.js <ip> <user_port> <contract_id>
```

Example:
```bash
node ~/evernode_client/client/cluster-manager.js evernode.onledger.net 26202 6664322e-2779-490e-97ff-9435ffdc7e88
```

Shows current cluster status on startup then presents a menu:
```
  What would you like to do?
    1. Check status
    2. Update contract
    3. Add a node
    4. Remove a node
    5. Check node expiry
    6. Extend node lease
    7. Exit
```

**Option 1 — Check status**

Shows vote status, UNL nodes, peers and LCL.

**Option 2 — Update contract**

Enter a new version string (e.g. `v1.0.1`). Bundles and deploys live across all nodes. No restarts, consensus maintained.

**Option 3 — Add a node**

Enter an external host XRPL address. The manager acquires, bundles, deploys and adds the node to the running cluster automatically, then waits to confirm sync.

**Option 4 — Remove a node**

Select a node by index or pubkey. Will not remove if cluster would drop below 3 nodes.

**Option 5 — Check node expiry**

Shows time remaining for each node in the cluster. Nodes added via the cluster manager are tracked in `cluster-nodes.json` with their creation timestamp and life moments.

**Option 6 — Extend node lease**

Select a node by index or enter "all" to extend all nodes. Specify how many additional moments (hours) to add. Updates the local node records automatically.

## Key Concepts

**Consensus threshold:** Default 66% — with 3 nodes you need 2 votes, with 4 nodes you need 3. This allows rolling node additions without losing consensus.

**Vote status:** `voteStatus: synced` confirms healthy consensus. In HP logs `Vote status: 3` with 4 nodes is correct — it counts votes from OTHER nodes, self is not included.

**Adding nodes:** The new node is automatically acquired with the correct contract ID. The cluster manager handles the full flow.

**Life moments:** Each moment is approximately 1 hour. Minimum 3 moments recommended.

## Important Notes

- Always delete old instances before deploying a new cluster to the same host — running clusters can corrupt the UNL of new nodes during the sync window
- Never put `new Date()` or any non-deterministic value in contract outputs — all nodes must produce identical outputs for consensus
- The `config/.env` file contains your private keys — never commit it to git (it is in `.gitignore` by default)
- Node lease details are tracked in `config/cluster-nodes.json` — this file is auto-updated when nodes are added, removed or extended. It is reconciled against the live UNL on every startup.

## File Structure
```
evernode-cluster-manager/
├── setup.sh                <- run once to configure everything
├── contract/
│   ├── index.js            <- HotPocket contract
│   └── package.json
├── client/
│   ├── find-hosts.js       <- discover available Evernode hosts
│   ├── deploy.sh           <- deploy a new cluster
│   ├── cluster-manager.js  <- manage running cluster
│   └── package.json
└── config/
└── .env.example        <- template, setup.sh generates the real .env
```
## Your Project Directory

After running `setup.sh`, your project directory (e.g. `~/evernode_client`) contains:
```
evernode_client/
├── config/
│   ├── .env            <- your credentials and settings (never commit)
│   ├── hp-init.cfg     <- applied at node acquisition
│   └── hp.cfg.override <- applied when bundling
├── contract/           <- your contract code
└── client/             <- deploy and management tools
```
