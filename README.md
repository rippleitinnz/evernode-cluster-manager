# Evernode Cluster Manager

A tenant-side toolkit for deploying and managing HotPocket smart contract clusters on Evernode. No host access required.

## What It Does

- Deploys a multi-node HotPocket contract cluster on Evernode hosts
- Updates contract code live without restarting nodes or losing consensus
- Adds external nodes to a running cluster without restarting
- Removes nodes from a running cluster
- Monitors cluster health and consensus status
- Discovers available Evernode hosts with pricing
- Tracks node lease expiry and extends leases

## Requirements

- Node.js v20+
- evdevkit installed globally: `npm i evdevkit -g`
- An XRPL wallet funded with EVR tokens (tenant account)

## Quick Start

```bash
git clone https://github.com/rippleitinnz/evernode-cluster-manager
cd evernode-cluster-manager
bash setup.sh
```

`setup.sh` asks for your credentials and preferences, generates all config files, and installs dependencies. At the end it shows you the exact commands to run next.

## Usage

Everything is managed from a single entry point:

```bash
# First time — deploy a new cluster
node ~/evernode_client/client/cluster-manager.js

# Manage an existing cluster
node ~/evernode_client/client/cluster-manager.js <ip> <user_port> <contract_id>
```

### First time — Deploy mode

When run with no arguments the manager enters deploy mode:

1. Optionally scans for available Evernode hosts with pricing
2. Prompts for number of nodes, host addresses and life moments
3. Deploys the cluster via evdevkit
4. Drops straight into the management menu

### Management menu

```
  What would you like to do?
    1. Check status
    2. Update contract
    3. Add a node
    4. Remove a node
    5. Check node expiry
    6. Extend node lease
    7. Find available hosts
    8. Exit
```

**Option 1 — Check status**

Shows vote status, UNL nodes with time remaining, peers and LCL. `voteStatus: synced` confirms healthy consensus.

**Option 2 — Update contract**

Enter a new version string (e.g. `v1.0.1`). Bundles and deploys live across all nodes. No restarts, consensus maintained.

**Option 3 — Add a node**

Optionally find available hosts first, then enter an external host XRPL address. The manager acquires the instance with the correct contract ID, bundles with the correct UNL and peer config, deploys, adds to the running cluster and waits to confirm sync.

**Option 4 — Remove a node**

Select a node by index or pubkey. Will not remove if cluster would drop below 3 nodes.

**Option 5 — Check node expiry**

Shows time remaining for each tracked node. Nodes are tracked in `config/cluster-nodes.json` when added via option 3.

**Option 6 — Extend node lease**

Select a node by index or enter "all" to extend all nodes. Specify how many additional moments (hours) to add.

**Option 7 — Find available hosts**

Scans the Evernode network for active hosts with available slots, RAM, location and pricing. Use the addresses when adding nodes or deploying.

## Key Concepts

**Consensus threshold:** Default 66% — with 3 nodes you need 2 votes, with 4 nodes you need 3. This allows rolling node additions without losing consensus. Do not set above 80% if you plan to add nodes dynamically.

**Vote status:** `voteStatus: synced` confirms healthy consensus. In HP logs `Vote status: 3` with 4 nodes is correct — it counts votes from OTHER nodes, self is not included.

**Adding nodes:** The new node is automatically acquired with the correct contract ID. The cluster manager handles the full flow end-to-end.

**Life moments:** Each moment is approximately 1 hour. Minimum 3 moments recommended.

**Node tracking:** Nodes added via option 3 are saved to `config/cluster-nodes.json` with their lease details. This file is reconciled against the live UNL on every startup — stale entries are removed automatically.

## Important Notes

- Always delete old instances before deploying a new cluster to the same host — running clusters can corrupt the UNL of new nodes during the sync window
- Never put `new Date()` or any non-deterministic value in contract outputs — all nodes must produce identical outputs for consensus
- The `config/.env` file contains your private keys — never commit it to git (it is in `.gitignore` by default)

## File Structure

```
evernode-cluster-manager/
├── setup.sh                <- run once to configure everything
├── contract/
│   ├── index.js            <- HotPocket contract
│   └── package.json
├── client/
│   ├── cluster-manager.js  <- single entry point for everything
│   ├── find-hosts.js       <- standalone host discovery tool
│   └── package.json
└── config/
    └── .env.example        <- template, setup.sh generates the real .env
```

## Your Project Directory

After running `setup.sh`, your project directory (e.g. `~/evernode_client`) contains:

```
evernode_client/
├── config/
│   ├── .env                <- your credentials and settings (never commit)
│   ├── hp-init.cfg         <- applied at node acquisition
│   ├── hp.cfg.override     <- applied when bundling
│   └── cluster-nodes.json  <- node lease tracking (auto-managed)
├── contract/               <- your contract code
└── client/                 <- management tools
```
