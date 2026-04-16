# Updating a Live HotPocket Contract — Full Process

## Overview

This document explains how to update a smart contract running on a live HotPocket cluster without losing consensus and without restarting any nodes.

## Prerequisites

- node and npm installed on your dev machine
- evdevkit installed globally: npm install -g evdevkit
- @vercel/ncc installed globally: npm install -g @vercel/ncc
- A running HotPocket cluster managed by the Evernode Cluster Manager
- Your contract package.json must include a build script (see below)

## Why ncc?

HotPocket runs your contract as a Node.js process inside a Docker container. The container has Node.js but not npm or node_modules. Your contract and all its dependencies must be compiled into a single self-contained file. @vercel/ncc handles this — it bundles src/index.js and all required packages into one dist/index.js file, typically 50-100KB.

## Why No Node Restart?

1. New contract code lands in the state directory via consensus — all nodes agree simultaneously
2. post_exec.sh runs after the ledger closes but before the next ledger starts — HP executes it automatically
3. The next ledger runs the new index.js — no restart needed

## Required package.json

{
  "dependencies": {
    "hotpocket-nodejs-contract": "0.7.4"
  },
  "devDependencies": {
    "@vercel/ncc": "latest"
  },
  "scripts": {
    "build": "ncc build src/index.js -o dist"
  }
}

## Step by Step

### Step 1 — Bump the version
const VERSION = 'v1.0.1';

### Step 2 — Build
npm run build
Output: dist/index.js — single self-contained file

### Step 3 — Copy to project
cp dist/index.js ~/.evernode-clusters/projects/my-project/contract/index.js

### Step 4 — Bundle
evdevkit bundle ~/.evernode-clusters/projects/my-project/contract <unl_pubkey> /usr/bin/node -a index.js
Output: bundle/bundle.zip containing index.js, hp.cfg.override, authorized_pubkey.txt

### Step 5 — Send to cluster
The cluster manager base64 encodes the zip and sends it as a consensus input:
{ "type": "upgrade", "bundle": "<base64>" }
All nodes receive the same input in the same ledger.

### Step 6 — Contract handles the upgrade
The running contract extracts the bundle into state and writes post_exec.sh.

### Step 7 — post_exec.sh runs
[ -f "contract.config" ] && jq -s '.[0] * (.[1] | del(.unl))' patch.cfg contract.config > /tmp/hp-patch-tmp.cfg && mv /tmp/hp-patch-tmp.cfg patch.cfg
jq '.log.log_level = "dbg"' /contract/cfg/hp.cfg > /tmp/hp-cfg-tmp.cfg && mv /tmp/hp-cfg-tmp.cfg /contract/cfg/hp.cfg

### Step 8 — Next ledger runs new code
All nodes upgraded simultaneously. No downtime, no restart, consensus never broken.

## What Keeps Consensus Intact

- Bundle sent as consensus input — all nodes process it in the same ledger
- del(.unl) in post_exec merge — UNL entries preserved
- ncc single file build — identical execution on all nodes
- No restart required — HP detects new index.js at next ledger start

## Built-in Management Handlers

| Handler | Type | Purpose |
|---------|------|---------|
| status | readonly | Returns version, contractId, publicKey |
| readCfg | readonly | Returns current patch.cfg |
| readLog | readonly | Returns hp.log lines |
| readContractLog | readonly | Returns rw.stdout.log or rw.stderr.log |
| upgrade | consensus | Handles contract bundle upgrade |
| addNode | consensus | Adds pubkey to UNL and peer |
| removeNode | consensus | Removes pubkey from UNL and peer |
| removePeer | consensus | Removes stale peer connection |

## Notes

- post_exec.sh runs outside state — changes to patch.cfg and hp.cfg are persistent
- Backups created automatically before each upgrade (backup-<timestamp>/)
- Maximum backups kept: 5
- If upgrade fails, post_exec.sh rolls back patch.cfg automatically
