# Evernode Cluster Manager

A tenant-side toolkit for deploying and managing HotPocket smart contract clusters on Evernode. No host access required.

## What It Does

- Deploys a multi-node HotPocket contract cluster on Evernode hosts
- Updates contract code live without restarting nodes or losing consensus
- Adds external nodes to a running cluster without restarting
- Removes nodes from a running cluster
- Monitors cluster health and consensus status

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

setup.sh will ask for your credentials and preferences, generate all config files, and install dependencies.

## Usage

### Deploy a cluster
```bash
bash <project_dir>/client/deploy.sh
```

### Manage the cluster
```bash
node <project_dir>/client/cluster-manager.js <ip> <user_port> <contract_id>
```

Options:
1. Check status
2. Update contract live
3. Add a node (full end-to-end: acquire, bundle, deploy, add to UNL)
4. Remove a node
5. Exit

## Key Concepts

**Consensus threshold:** Default 66% — with 3 nodes you need 2 votes, with 4 nodes you need 3. This allows rolling node additions without losing consensus.

**Vote status:** Use the cluster manager status check which shows `voteStatus: synced` for true confirmation.

**Adding nodes:** Option 3 handles everything — just provide the external host address and the manager does the rest.

**Contract updates:** Option 2 updates the version string automatically and deploys live. No restarts needed.

## Important Notes

- Always delete old instances before deploying a new cluster to the same host
- Never put `new Date()` or any non-deterministic value in contract outputs
- The `.env` file contains your private keys — never commit it to git

## File Structure
evernode-cluster-manager/
├── setup.sh                    <- run once to configure everything
├── contract/
│   ├── index.js                <- HotPocket contract
│   └── package.json
├── client/
│   ├── deploy.sh               <- deploy a new cluster
│   ├── cluster-manager.js      <- manage running cluster
│   └── package.json
├── config/
│   └── .env.example            <- copy to .env and fill in
└── host/
└── post-deploy-patch.sh    <- optional, only if you own the host
