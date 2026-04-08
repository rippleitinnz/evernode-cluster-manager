# Evernode Cluster Manager

A single tool for deploying and managing multiple HotPocket smart contract clusters on Evernode. No host access required.

## What It Does

- Manages multiple independent cluster projects from one tool
- Deploys multi-node HotPocket contract clusters on Evernode hosts
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
node client/cluster-manager.js
```

That's it. The tool handles everything from there.

## How It Works

Everything runs from a single command:

```bash
node ~/evernode-cluster-manager/client/cluster-manager.js
```

On first run it shows a project selector. Each project is an independent cluster with its own credentials, contract code and node tracking.

```
╔══════════════════════════════════════════════════════╗
║          Evernode Cluster Manager                   ║
╚══════════════════════════════════════════════════════╝

  Select a project:

    1. my-game             contract: 6664322e… | nodes tracked: 3
    2. defi-app            contract: 9396fdf2… | nodes tracked: 4
    3. nft-platform        no cluster yet
    4. Create new project
    5. Exit
```

### Creating a new project

Select "Create new project" and the tool will ask for:
- Project name
- HotPocket user keys (or generate new ones)
- XRPL tenant credentials
- HotPocket settings (round time, threshold, log level)
- Default node count and life moments

### Management menu

After selecting a project:

```
  What would you like to do?
    1. Check status
    2. Update contract
    3. Add a node
    4. Remove a node
    5. Check node expiry
    6. Extend node lease
    7. Find available hosts
    8. Switch project
    9. Exit
```

**Option 1 — Check status**

Shows vote status, UNL nodes with time remaining, peers and LCL. `voteStatus: synced` confirms healthy consensus.

**Option 2 — Update contract**

Enter a new version string (e.g. `v1.0.1`). Bundles and deploys live across all nodes. No restarts, consensus maintained.

**Option 3 — Add a node**

Optionally find available hosts first, then enter an external host XRPL address. The tool acquires the instance with the correct contract ID, bundles with the correct UNL and peer config, deploys, adds to the running cluster and waits to confirm sync.

**Option 4 — Remove a node**

Select a node by index or pubkey. Will not remove if cluster would drop below 3 nodes.

**Option 5 — Check node expiry**

Shows time remaining for each tracked node. All nodes are tracked automatically — both from initial deployment and any nodes added via option 3.

**Option 6 — Extend node lease**

Select a node by index or "all" to extend all nodes. Specify how many additional moments (hours) to add.

**Option 7 — Find available hosts**

Scans the Evernode network for active hosts with available slots, RAM, location and pricing.

**Option 8 — Switch project**

Returns to the project selector without exiting.

## Project Storage

Projects are stored in `~/.evernode-clusters/projects/` — one folder per project:

```
~/.evernode-clusters/
└── projects/
    ├── my-game/
    │   ├── .env                <- credentials and settings
    │   ├── contract/           <- contract code
    │   ├── cluster-nodes.json  <- node lease tracking
    │   └── hp-init.cfg         <- acquisition config
    └── defi-app/
        ├── .env
        ├── contract/
        └── ...
```

Each project is completely independent — different credentials, different contract code, different cluster.

## Key Concepts

**Consensus threshold:** Default 66% — with 3 nodes you need 2 votes, with 4 nodes you need 3. This allows rolling node additions without losing consensus.

**Vote status:** `voteStatus: synced` confirms healthy consensus. In HP logs `Vote status: 3` with 4 nodes is correct — it counts votes from OTHER nodes, self is not included.

**Adding nodes:** The new node is automatically acquired with the correct contract ID. The tool handles the full flow end-to-end.

**Life moments:** Each moment is approximately 1 hour. Minimum 3 moments recommended.

**Node tracking:** Nodes added via option 3 are saved to `cluster-nodes.json` with their lease details. Stale entries are removed automatically when they leave the UNL.

## Contract Interface Specification

For the cluster manager to fully manage a cluster, the deployed contract must implement the following input handlers. Contracts that do not implement these handlers can still be deployed and monitored, but live updates, node addition and node removal will not be available.

### Required handlers

All handlers receive a JSON input from the authorized user public key and must respond with a JSON output.

**`status`**

Returns current contract state. No timestamp or non-deterministic values — all nodes must produce identical output.

Input:
```json
{ "type": "status" }
```

Output:
```json
{
  "type": "status",
  "version": "v1.0.0",
  "lclSeqNo": 100,
  "unlCount": 3,
  "unl": ["ed123...", "ed456...", "ed789..."]
}
```

**`updateContract`**

Receives a base64-encoded zip bundle and extracts it over the current contract files. New code is active from the next round.

Input:
```json
{
  "type": "updateContract",
  "newVersion": "v1.0.1",
  "bundle": "<base64 encoded zip>"
}
```

Output:
```json
{
  "type": "updateContract",
  "version": "v1.0.0",
  "lclSeqNo": 100,
  "status": "ok"
}
```

**`addNode`**

Adds a new pubkey to the UNL and initiates a peer connection. No restart required.

Input:
```json
{
  "type": "addNode",
  "pubkey": "ed...",
  "ip": "host.example.com",
  "peerPort": 22861
}
```

Output:
```json
{
  "type": "addNode",
  "addedPubkey": "ed...",
  "newUnlCount": 4,
  "lclSeqNo": 100
}
```

**`removeNode`**

Removes a pubkey from the UNL. Minimum 2 nodes must remain after removal.

Input:
```json
{
  "type": "removeNode",
  "pubkey": "ed..."
}
```

Output:
```json
{
  "type": "removeNode",
  "removedPubkey": "ed...",
  "newUnlCount": 3,
  "lclSeqNo": 100
}
```

### Critical rules

- **No timestamps in outputs** — `new Date()` or any non-deterministic value in contract outputs will cause output hash mismatches across nodes and break consensus
- **Authorization** — all management handlers must verify the sender's public key against an authorized key stored in the contract state
- **Version field required** — `ctx.updateConfig()` requires the `version` field to be present at the top level of the config object
- **`forceTerminate: true`** — pass `true` as the third argument to `hpc.init()` to ensure clean round exit after config changes

### Reference implementation

The default contract template at `contract/index.js` in this repository is a fully working reference implementation of all four handlers.

## Important Notes

- Always delete old instances before deploying a new cluster to the same host — running clusters can corrupt the UNL of new nodes during the sync window
- Never put `new Date()` or any non-deterministic value in contract outputs — all nodes must produce identical outputs for consensus
- The `.env` file in each project contains private keys — never commit it to git

## File Structure

```
evernode-cluster-manager/       <- clone this repo once
├── client/
│   └── cluster-manager.js      <- single entry point for everything
├── contract/
│   ├── index.js                <- HotPocket contract template
│   └── package.json
└── config/
    └── .env.example            <- example config for reference
```
