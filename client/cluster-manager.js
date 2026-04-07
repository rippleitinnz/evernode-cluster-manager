#!/usr/bin/env node
/**
 * v3.0 — cluster-manager.js
 *
 * Interactive CLI for managing a HotPocket cluster as a tenant.
 * No host access required.
 *
 * Usage: node cluster-manager.js <ip> <user_port> <contract_id>
 */

'use strict';

require('dotenv').config({ path: '/home/chris/v3.0/.env' });
const HotPocket  = require('hotpocket-js-client');
const AdmZip     = require('adm-zip');
const readline   = require('readline');
const { execSync } = require('child_process');
const fs         = require('fs');
const path       = require('path');

const [,, ip, port, contractId] = process.argv;
if (!ip || !port || !contractId) {
    console.error('Usage: node cluster-manager.js <ip> <user_port> <contract_id>');
    process.exit(1);
}

const CONTRACT_DIR = '/home/chris/v3.0/contract';
const PROJECT_DIR  = '/home/chris/v3.0';
const ENV          = '/home/chris/v3.0/.env';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = () => new Date().toISOString().replace('T',' ').replace(/\..+/,'');

const getKeyPair = async () => HotPocket.generateKeys(process.env.EV_USER_PRIVATE_KEY);

// ── HP Client Helpers ─────────────────────────────────────────────────────────

const getStatus = async (targetIp, targetPort) => {
    const keyPair = await getKeyPair();
    const client = await HotPocket.createClient(
        [`wss://${targetIp}:${targetPort}`], keyPair,
        { protocol: HotPocket.protocols.json }
    );
    const connected = await client.connect();
    if (!connected) throw new Error(`Cannot connect to ${targetIp}:${targetPort}`);
    const stat = await client.getStatus();
    await client.close().catch(() => {});
    return stat;
};

const waitForSync = async (targetIp, targetPort, expectedUnlCount, timeoutMs = 90000) => {
    const start = Date.now();
    console.log(`\n  Waiting for cluster to sync (up to ${timeoutMs/1000}s)...`);
    while (Date.now() - start < timeoutMs) {
        try {
            const stat = await getStatus(targetIp, targetPort);
            const synced = stat.voteStatus === 'synced';
            const correctSize = !expectedUnlCount || stat.currentUnl.length === expectedUnlCount;
            process.stdout.write(`  ${fmt()} | voteStatus=${stat.voteStatus} | unl=${stat.currentUnl.length}\r`);
            if (synced && correctSize) {
                console.log(`\n  ✓ Synced! UNL=${stat.currentUnl.length}`);
                return stat;
            }
        } catch(e) {
            process.stdout.write(`  ${fmt()} | waiting... (${e.message})\r`);
        }
        await sleep(3000);
    }
    throw new Error('Timed out waiting for sync');
};

const sendInput = async (targetIp, targetPort, msg, expectedType, waitMs = 15000) => {
    const keyPair = await getKeyPair();
    const client = await HotPocket.createClient(
        [`wss://${targetIp}:${targetPort}`], keyPair,
        { protocol: HotPocket.protocols.json }
    );
    return new Promise(async (resolve, reject) => {
        let result = null;
        client.on(HotPocket.events.contractOutput, (r) => {
            for (const o of r.outputs) {
                try {
                    const parsed = JSON.parse(o);
                    if (parsed.type === expectedType || parsed.type === 'error') result = parsed;
                } catch {}
            }
        });
        client.on(HotPocket.events.disconnect, () => {});
        const connected = await client.connect();
        if (!connected) { reject(new Error('Connection failed')); return; }
        const submission = await client.submitContractInput(JSON.stringify(msg));
        const inputStatus = await submission.submissionStatus;
        if (inputStatus.status !== 'accepted') {
            await client.close().catch(() => {});
            reject(new Error(`Input rejected: ${inputStatus.reason}`));
            return;
        }
        await sleep(waitMs);
        await client.close().catch(() => {});
        if (!result) reject(new Error('No response received'));
        else if (result.type === 'error') reject(new Error(result.message));
        else resolve(result);
    });
};

// ── Operations ────────────────────────────────────────────────────────────────

const opStatus = async () => {
    console.log('\n  Fetching cluster status...');
    try {
        const stat = await getStatus(ip, port);
        console.log('\n── Cluster Status ───────────────────────────────────');
        console.log(`  HP Version   : ${stat.hpVersion}`);
        console.log(`  Vote Status  : ${stat.voteStatus}`);
        console.log(`  LCL          : ${stat.ledgerSeqNo}`);
        console.log(`  Round Time   : ${stat.roundTime}ms`);
        console.log(`  Contract ID  : ${contractId}`);
        console.log(`  UNL Count    : ${stat.currentUnl.length}`);
        console.log('  UNL Nodes    :');
        stat.currentUnl.forEach((pk, i) => console.log(`    [${i}] ${pk}`));
        console.log('  Peers        :');
        stat.peers.forEach(p => console.log(`    ${p}`));
        console.log('─────────────────────────────────────────────────────\n');
        return stat;
    } catch(e) {
        console.error(`  ✗ ${e.message}`);
    }
};

const opUpdateContract = async () => {
    console.log('\n── Update Contract ──────────────────────────────────');
    console.log('  Checking cluster is synced...');
    let stat;
    try {
        stat = await getStatus(ip, port);
        if (stat.voteStatus !== 'synced') { console.error('  ✗ Cluster not synced. Aborting.'); return; }
        console.log(`  ✓ Synced. UNL=${stat.currentUnl.length}`);
    } catch(e) { console.error(`  ✗ ${e.message}`); return; }

    const newVersion = (await ask('  New version string (e.g. v3.0.2): ')).trim();
    if (!newVersion) { console.log('  Cancelled.'); return; }

    // Update version in index.js automatically
    const indexPath = path.join(CONTRACT_DIR, 'index.js');
    let contractCode = fs.readFileSync(indexPath, 'utf8');
    const currentVersion = (contractCode.match(/const CONTRACT_VERSION\s+=\s+'([^']+)'/) || [])[1];
    if (currentVersion) {
        contractCode = contractCode.replace(
            `const CONTRACT_VERSION       = '${currentVersion}'`,
            `const CONTRACT_VERSION       = '${newVersion}'`
        );
        fs.writeFileSync(indexPath, contractCode);
        console.log(`  Updated CONTRACT_VERSION: ${currentVersion} → ${newVersion}`);
    }

    console.log(`  Building bundle from ${CONTRACT_DIR}...`);
    const zip = new AdmZip();
    zip.addLocalFolder(CONTRACT_DIR);
    const buf = zip.toBuffer();
    console.log(`  Bundle: ${(buf.length/1024).toFixed(1)} KB`);

    try {
        const result = await sendInput(ip, port, {
            type: 'updateContract', newVersion, bundle: buf.toString('base64')
        }, 'updateContract', 20000);
        console.log(`\n  ✓ Contract updated.`);
        console.log(`    Was     : ${result.version}`);
        console.log(`    Now     : ${newVersion}`);
        console.log(`    LCL     : ${result.lclSeqNo}`);
        await waitForSync(ip, port, stat.currentUnl.length);
    } catch(e) {
        // Revert version on failure
        if (currentVersion) {
            contractCode = contractCode.replace(
                `const CONTRACT_VERSION       = '${newVersion}'`,
                `const CONTRACT_VERSION       = '${currentVersion}'`
            );
            fs.writeFileSync(indexPath, contractCode);
            console.error(`\n  ✗ Update failed: ${e.message}. Version reverted to ${currentVersion}.`);
        }
    }
    console.log('─────────────────────────────────────────────────────\n');
};

const opAddNode = async () => {
    console.log('\n── Add Node ─────────────────────────────────────────');

    // Pre-flight sync check
    console.log('  Checking cluster is synced...');
    let stat;
    try {
        stat = await getStatus(ip, port);
        if (stat.voteStatus !== 'synced') { console.error('  ✗ Cluster not synced. Aborting.'); return; }
        console.log(`  ✓ Synced. Current UNL=${stat.currentUnl.length}`);
    } catch(e) { console.error(`  ✗ ${e.message}`); return; }

    // Step 1 — Acquire
    console.log('\n  ── STEP 1: Acquire the new node ──────────────────');
    const extHost = (await ask('  External host XRPL address: ')).trim();
    const moments = (await ask('  Life moments (default 3)  : ')).trim() || '3';
    if (!extHost) { console.log('  Cancelled.'); return; }

    console.log(`\n  Acquiring on ${extHost} for ${moments} moments with contract ID ${contractId}...\n`);

    let acquireOutput;
    try {
        acquireOutput = execSync(
            `bash -c 'set -a; source ${ENV}; set +a; unset EV_HP_OVERRIDE_CFG_PATH; sudo -E evdevkit acquire ${extHost} -m ${moments} -c ${contractId}'`,
            { encoding: 'utf8' }
        );
        console.log(acquireOutput);
    } catch(e) {
        console.error(`  ✗ Acquire failed: ${e.message}`);
        return;
    }

    // Parse acquire output
    const pubkeyMatch  = acquireOutput.match(/pubkey['":\s]+['"]?(ed[a-f0-9]{64})['"]?/);
    const peerMatch    = acquireOutput.match(/peer_port['":\s]+['"]?(\d+)['"]?/);
    const userMatch    = acquireOutput.match(/user_port['":\s]+['"]?(\d+)['"]?/);
    const domainMatch  = acquireOutput.match(/domain['":\s]+['"]?([a-zA-Z0-9._-]+\.[a-zA-Z]{2,})['"]?/);

    if (!pubkeyMatch || !peerMatch || !userMatch || !domainMatch) {
        console.error('  ✗ Could not parse acquire output. Check output above.');
        return;
    }

    const newPubkey   = pubkeyMatch[1];
    const newPeerPort = peerMatch[1];
    const newUserPort = userMatch[1];
    const newDomain   = domainMatch[1];

    console.log('  ── Acquired node details ─────────────────────────');
    console.log(`  Pubkey    : ${newPubkey}`);
    console.log(`  Domain    : ${newDomain}`);
    console.log(`  User port : ${newUserPort}`);
    console.log(`  Peer port : ${newPeerPort}`);

    // Step 2 — Build override config
    console.log('\n  ── STEP 2: Building override config ──────────────');
    const allPubkeys = [...stat.currentUnl, newPubkey];
    const overrideCfg = {
        contract: {
            bin_path: '/usr/bin/node',
            bin_args: 'index.js',
            consensus: { roundtime: 5000, threshold: 66 },
            unl: allPubkeys
        },
        mesh: {
            peer_discovery: { enabled: false },
            known_peers: stat.peers
        }
    };
    const overridePath = `${PROJECT_DIR}/node-override-temp.cfg`;
    fs.writeFileSync(overridePath, JSON.stringify(overrideCfg, null, 2));
    console.log(`  ✓ Override config: ${allPubkeys.length} nodes in UNL, ${stat.peers.length} known peers`);

    // Step 3 — Bundle
    console.log('\n  ── STEP 3: Building bundle ───────────────────────');
    try {
        execSync(
            `bash -c 'set -a; source ${ENV}; set +a; export EV_HP_OVERRIDE_CFG_PATH=${overridePath}; sudo -E evdevkit bundle ${CONTRACT_DIR} ${newPubkey} /usr/bin/node -a index.js'`,
            { encoding: 'utf8', cwd: PROJECT_DIR }
        );
        console.log('  ✓ Bundle created.');
    } catch(e) {
        console.error(`  ✗ Bundle failed: ${e.message}`);
        fs.unlinkSync(overridePath);
        return;
    }

    // Step 4 — Deploy
    console.log('\n  ── STEP 4: Deploying to new node ─────────────────');
    let deployOutput;
    try {
        deployOutput = execSync(
            `bash -c 'set -a; source ${ENV}; set +a; sudo -E evdevkit deploy ${PROJECT_DIR}/bundle/bundle.zip ${newDomain} ${newUserPort}'`,
            { encoding: 'utf8' }
        );
        console.log(deployOutput);
        if (!deployOutput.includes('Contract bundle uploaded')) {
            console.error('  ✗ Deploy may have failed.');
            fs.unlinkSync(overridePath);
            return;
        }
        console.log('  ✓ Bundle deployed.');
    } catch(e) {
        console.error(`  ✗ Deploy failed: ${e.message}`);
        fs.unlinkSync(overridePath);
        return;
    }

    fs.unlinkSync(overridePath);

    // Step 5 — IMMEDIATELY addNode
    console.log('\n  ── STEP 5: Adding node to cluster UNL ────────────');
    console.log('  Submitting addNode immediately...');
    try {
        const result = await sendInput(ip, port, {
            type    : 'addNode',
            pubkey  : newPubkey,
            ip      : newDomain,
            peerPort: parseInt(newPeerPort)
        }, 'addNode', 15000);

        console.log(`\n  ✓ Node added.`);
        console.log(`    Added   : ${result.addedPubkey}`);
        console.log(`    UNL     : ${result.newUnlCount}`);
        console.log(`    LCL     : ${result.lclSeqNo}`);

        await waitForSync(ip, port, result.newUnlCount, 90000);

        const finalStat = await getStatus(ip, port);
        console.log('\n  ── Final verification ────────────────────────────');
        console.log(`  Vote Status : ${finalStat.voteStatus}`);
        console.log(`  UNL Count   : ${finalStat.currentUnl.length}`);
        console.log(`  Peers       : ${finalStat.peers.join(', ')}`);

    } catch(e) {
        console.error(`\n  ✗ Add node failed: ${e.message}`);
    }
    console.log('─────────────────────────────────────────────────────\n');
};

const opRemoveNode = async () => {
    console.log('\n── Remove Node ──────────────────────────────────────');
    console.log('  Checking cluster status...');
    let stat;
    try {
        stat = await getStatus(ip, port);
        if (stat.voteStatus !== 'synced') { console.error('  ✗ Cluster not synced. Aborting.'); return; }
        console.log(`  ✓ Synced. UNL=${stat.currentUnl.length}:`);
        stat.currentUnl.forEach((pk, i) => console.log(`    [${i}] ${pk}`));
    } catch(e) { console.error(`  ✗ ${e.message}`); return; }

    if (stat.currentUnl.length <= 3) {
        console.error('  ✗ Cannot remove — minimum safe cluster size is 3 nodes.');
        return;
    }

    const input = (await ask('\n  Pubkey or index to remove: ')).trim();
    if (!input) { console.log('  Cancelled.'); return; }

    let targetPubkey = input;
    if (/^\d+$/.test(input)) {
        const idx = parseInt(input);
        if (idx >= 0 && idx < stat.currentUnl.length) {
            targetPubkey = stat.currentUnl[idx];
            console.log(`  Selected: ${targetPubkey}`);
        } else {
            console.error('  ✗ Invalid index.');
            return;
        }
    }

    const confirm = (await ask(`  Confirm remove ${targetPubkey.slice(0,20)}…? (yes/y): `)).trim();
    if (confirm !== 'yes' && confirm !== 'y') { console.log('  Cancelled.'); return; }

    try {
        const result = await sendInput(ip, port, {
            type  : 'removeNode',
            pubkey: targetPubkey
        }, 'removeNode', 15000);

        console.log(`\n  ✓ Node removed. UNL=${result.newUnlCount} LCL=${result.lclSeqNo}`);
        await waitForSync(ip, port, result.newUnlCount);
    } catch(e) {
        console.error(`\n  ✗ Remove failed: ${e.message}`);
    }
    console.log('─────────────────────────────────────────────────────\n');
};

// ── Main Menu ─────────────────────────────────────────────────────────────────

const main = async () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║          v3.0 — Cluster Manager                     ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(`  Node    : ${ip}:${port}`);
    console.log(`  Contract: ${contractId}`);
    console.log('');

    await opStatus();

    while (true) {
        console.log('  What would you like to do?');
        console.log('    1. Check status');
        console.log('    2. Update contract');
        console.log('    3. Add a node');
        console.log('    4. Remove a node');
        console.log('    5. Exit');
        console.log('');
        const choice = (await ask('  Choice: ')).trim();
        console.log('');

        switch (choice) {
            case '1': await opStatus(); break;
            case '2': await opUpdateContract(); break;
            case '3': await opAddNode(); break;
            case '4': await opRemoveNode(); break;
            case '5':
                console.log('  Goodbye.\n');
                rl.close();
                process.exit(0);
            default:
                console.log('  Invalid choice.\n');
        }
    }
};

main().catch(e => {
    console.error('Fatal:', e.message);
    rl.close();
    process.exit(1);
});
