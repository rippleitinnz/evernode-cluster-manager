#!/usr/bin/env node
/**
 * Evernode Cluster Manager
 *
 * Single entry point for deploying and managing HotPocket clusters on Evernode.
 * No host access required.
 *
 * First time (deploy a new cluster):
 *   node cluster-manager.js
 *
 * Manage existing cluster:
 *   node cluster-manager.js <ip> <user_port> <contract_id>
 */

'use strict';

const path         = require('path');
const fs           = require('fs');
const readline     = require('readline');
const https        = require('https');
const { execSync, spawnSync } = require('child_process');
const vm           = require('vm');

// ── Find config ───────────────────────────────────────────────
const SCRIPT_DIR  = __dirname;
const PROJECT_DIR = path.dirname(SCRIPT_DIR);
const ENV_FILE    = path.join(PROJECT_DIR, 'config', '.env');
const NODES_FILE  = path.join(PROJECT_DIR, 'config', 'cluster-nodes.json');

if (!fs.existsSync(ENV_FILE)) {
    console.error(`\n✗ Config not found at ${ENV_FILE}`);
    console.error('  Run setup.sh first.\n');
    process.exit(1);
}

require('dotenv').config({ path: ENV_FILE });

const HotPocket    = require('hotpocket-js-client');
const AdmZip       = require('adm-zip');
const CONTRACT_DIR = path.join(PROJECT_DIR, 'contract');

const MOMENT_SECONDS = 3600; // 1 moment = 1 hour

// ── Args ──────────────────────────────────────────────────────
let [,, ip, port, contractId] = process.argv;
let deployMode = !ip && !port && !contractId;

const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = () => new Date().toISOString().replace('T',' ').replace(/\..+/,'');

// ── Node tracking ─────────────────────────────────────────────

const loadNodes = () => {
    try {
        if (fs.existsSync(NODES_FILE))
            return JSON.parse(fs.readFileSync(NODES_FILE, 'utf8'));
    } catch {}
    return [];
};

const saveNodes = (nodes) => {
    fs.writeFileSync(NODES_FILE, JSON.stringify(nodes, null, 2));
};

const reconcileNodes = (nodes, currentUnl) => {
    return nodes.filter(n => currentUnl.includes(n.pubkey));
};

const timeRemaining = (node) => {
    const createdSec = Math.floor(node.createdTimestamp / 1000);
    const expirySec  = createdSec + (node.lifeMoments * MOMENT_SECONDS);
    const nowSec     = Math.floor(Date.now() / 1000);
    const remaining  = expirySec - nowSec;
    if (remaining <= 0) return { expired: true, text: 'EXPIRED', expirySec };
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    return { expired: false, text: `${h}h ${m}m`, expirySec, remaining };
};

// ── HP Client Helpers ─────────────────────────────────────────

const getKeyPair = async () => HotPocket.generateKeys(process.env.EV_USER_PRIVATE_KEY);

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

const stripAnsi = (str) => str.replace(/\u001b\[[0-9;]*m/g, '');
const parseEvmOutput = (raw) => {
    try {
        const clean = stripAnsi(raw);
        const start = clean.indexOf('[');
        if (start === -1) return null;
        return vm.runInNewContext(`(${clean.slice(start).trim()})`);
    } catch { return null; }
};

// ── Host Finder ───────────────────────────────────────────────

const findHosts = async (minSlots = 1, targetCount = 20) => {
    const batchSize = 15;
    console.log(`\n  Scanning for ${targetCount} active hosts with >= ${minSlots} available slot(s)...\n`);

    const get = (url) => new Promise((resolve, reject) => {
        https.get(url, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
        }).on('error', reject);
    });

    process.stdout.write('  Fetching host list...');
    const data = await get('https://xahau.xrplwin.com/api/evernode/hosts');
    const priceMap = {};
    const allHosts = data.data
        .filter(h => h.leaseprice_evr_drops !== null && h.host)
        .map(h => { priceMap[h.host] = h.leaseprice_evr_drops; return h.host; });
    console.log(` ${allHosts.length} registered hosts found.`);

    const shuffled = allHosts.sort(() => Math.random() - 0.5);
    const found = [];
    const checked = new Set();
    let batchNum = 0;
    let idx = 0;

    while (found.length < targetCount && idx < shuffled.length) {
        const batch = [];
        while (batch.length < batchSize && idx < shuffled.length) {
            if (!checked.has(shuffled[idx])) { batch.push(shuffled[idx]); checked.add(shuffled[idx]); }
            idx++;
        }
        if (batch.length === 0) break;
        batchNum++;
        process.stdout.write(`  Batch ${String(batchNum).padStart(2)} | Checked: ${checked.size} | Found: ${found.length}/${targetCount}\r`);

        const tmpFile = '/tmp/ecm-hosts-batch.txt';
        fs.writeFileSync(tmpFile, batch.join('\n'));
        const result = spawnSync('evdevkit', ['hostinfo', '-f', tmpFile], { encoding: 'utf8', timeout: 60000 });
        try { fs.unlinkSync(tmpFile); } catch {}
        const info = parseEvmOutput(result.stdout || '');
        if (Array.isArray(info)) {
            const active = info.filter(h => h.active && h.availableInstanceSlots >= minSlots);
            active.forEach(h => { h.leasePrice = priceMap[h.address] || null; });
            found.push(...active);
        }
    }

    console.log(`\n  Found ${found.length} active host(s).\n`);
    found.sort((a, b) => b.availableInstanceSlots - a.availableInstanceSlots || (a.leasePrice||0) - (b.leasePrice||0));

    const formatEVR = (drops) => {
        if (!drops) return 'free?';
        const evr = drops / 1000000;
        if (evr < 0.001) return `${drops}drops`;
        if (evr < 1) return `${evr.toFixed(4)} EVR`;
        return `${evr.toFixed(2)} EVR`;
    };

    console.log('  ' + '─'.repeat(112));
    console.log('  ' + '#'.padEnd(4) + 'Address'.padEnd(36) + 'Domain'.padEnd(25) + 'CC'.padEnd(5) + 'Avail'.padEnd(7) + 'Total'.padEnd(7) + 'RAM'.padEnd(12) + 'Lease/hr'.padEnd(12) + 'Version');
    console.log('  ' + '─'.repeat(112));
    found.forEach((h, i) => {
        console.log('  ' + String(i+1).padEnd(4) + (h.address||'').padEnd(36) + (h.domain||'').slice(0,23).padEnd(25) +
            (h.countryCode||'??').padEnd(5) + String(h.availableInstanceSlots||0).padEnd(7) +
            String(h.totalInstanceSlots||0).padEnd(7) + (h.ram||'').slice(0,10).padEnd(12) +
            formatEVR(h.leasePrice).padEnd(12) + (h.sashimonoVersion||'?'));
    });
    console.log('  ' + '─'.repeat(112));
    return found;
};

// ── Deploy ────────────────────────────────────────────────────

const opDeploy = async () => {
    console.log('\n── Deploy New Cluster ───────────────────────────────');
    console.log('');

    // Offer to find hosts first
    const findFirst = (await ask('  Find available hosts first? (yes/y or press Enter to skip): ')).trim();
    if (findFirst === 'yes' || findFirst === 'y') {
        const minSlots = parseInt((await ask('  Minimum available slots per host (default 1): ')).trim() || '1');
        await findHosts(minSlots, 20);
        await ask('  Press Enter to continue to deployment...');
    }

    console.log('');

    // How many nodes
    let nodeCount;
    while (true) {
        const input = (await ask(`  How many nodes? (default ${process.env.DEFAULT_NODE_COUNT || 3}, minimum 3): `)).trim();
        nodeCount = parseInt(input || process.env.DEFAULT_NODE_COUNT || '3');
        if (nodeCount >= 3) break;
        console.log('  Must be >= 3.');
    }

    // Collect host addresses
    console.log(`\n  Enter ${nodeCount} host XRPL address(es).`);
    console.log('  Repeat the same address for multiple nodes on one host.\n');
    const hostsFile = '/tmp/ecm-deploy-hosts.txt';
    const hostAddrs = [];
    for (let i = 1; i <= nodeCount; i++) {
        while (true) {
            const addr = (await ask(`  Host ${i} XRPL address: `)).trim();
            if (addr) { hostAddrs.push(addr); break; }
            console.log('  Cannot be empty.');
        }
    }
    fs.writeFileSync(hostsFile, hostAddrs.join('\n'));

    // How many moments
    let moments;
    while (true) {
        const input = (await ask(`\n  Life moments per node? (default ${process.env.DEFAULT_MOMENTS || 3}): `)).trim();
        moments = parseInt(input || process.env.DEFAULT_MOMENTS || '3');
        if (moments >= 1) break;
        console.log('  Must be >= 1.');
    }

    // Summary
    console.log('\n── Summary ───────────────────────────────────────────');
    console.log(`  Nodes   : ${nodeCount}`);
    console.log(`  Moments : ${moments} (~${moments}hr per node)`);
    console.log('  Hosts   :');
    hostAddrs.forEach((h, i) => console.log(`    ${i+1}. ${h}`));
    console.log('');

    const confirm = (await ask('  Proceed? (yes/y): ')).trim();
    if (confirm !== 'yes' && confirm !== 'y') {
        console.log('  Cancelled.');
        fs.unlinkSync(hostsFile);
        return;
    }

    console.log('');

    // Install dependencies
    console.log('[1/3] Installing contract dependencies...');
    execSync(`npm install --prefix ${CONTRACT_DIR} --silent`);
    console.log('      ✓ Done.');

    console.log('[2/3] Writing authorized_pubkey.txt...');
    fs.writeFileSync(path.join(CONTRACT_DIR, 'authorized_pubkey.txt'), process.env.EV_USER_PUBLIC_KEY + '\n');
    console.log(`      ✓ ${process.env.EV_USER_PUBLIC_KEY}`);

    console.log('[3/3] Running evdevkit cluster-create...');
    const clusterInfoFile = path.join(PROJECT_DIR, 'cluster-info.json');
    try {
        execSync(
            `bash -c 'set -a; source ${ENV_FILE}; set +a; unset EV_HP_OVERRIDE_CFG_PATH; export EV_HP_INIT_CFG_PATH=${PROJECT_DIR}/config/hp-init.cfg; sudo -E evdevkit cluster-create ${nodeCount} -m ${moments} ${CONTRACT_DIR} /usr/bin/node ${hostsFile} -a index.js'`,
            { encoding: 'utf8', stdio: 'inherit' }
        );
    } catch(e) {
        console.error(`\n  ✗ cluster-create failed: ${e.message}`);
        fs.unlinkSync(hostsFile);
        return;
    }
    fs.unlinkSync(hostsFile);

    // Parse cluster output to get contract ID and node details
    // evdevkit prints the result to stdout — read from cluster-info if saved, otherwise ask user
    console.log('');
    let newContractId = (await ask('  Enter the contract ID from the output above: ')).trim();
    if (!newContractId) { console.log('  No contract ID entered. Exiting deploy.'); return; }

    let firstIp = (await ask(`  Enter the IP/domain of one node (e.g. evernode.onledger.net): `)).trim();
    let firstPort = (await ask(`  Enter its user port: `)).trim();

    // Save basic node records — user can add details later via option 5
    console.log('');
    console.log('  ✓ Cluster deployed.');
    console.log(`  Contract ID : ${newContractId}`);
    console.log('');
    console.log('  Note: Run option 5 (Check node expiry) after adding nodes via option 3');
    console.log('  to track lease times. Nodes from initial deploy need to be added manually');
    console.log('  if you want expiry tracking.');

    // Switch to management mode
    contractId = newContractId;
    ip = firstIp;
    port = firstPort;
    deployMode = false;

    console.log('\n  Connecting to cluster...');
    console.log('─────────────────────────────────────────────────────\n');
};

// ── Operations ────────────────────────────────────────────────

const opStatus = async () => {
    console.log('\n  Fetching cluster status...');
    try {
        const stat = await getStatus(ip, port);

        let nodes = loadNodes();
        const reconciled = reconcileNodes(nodes, stat.currentUnl);
        if (reconciled.length !== nodes.length) { saveNodes(reconciled); nodes = reconciled; }

        console.log('\n── Cluster Status ───────────────────────────────────');
        console.log(`  HP Version   : ${stat.hpVersion}`);
        console.log(`  Vote Status  : ${stat.voteStatus}`);
        console.log(`  LCL          : ${stat.ledgerSeqNo}`);
        console.log(`  Round Time   : ${stat.roundTime}ms`);
        console.log(`  Contract ID  : ${contractId}`);
        console.log(`  UNL Count    : ${stat.currentUnl.length}`);
        console.log('  UNL Nodes    :');
        stat.currentUnl.forEach((pk, i) => {
            const node = nodes.find(n => n.pubkey === pk);
            const tr = node ? ` (${timeRemaining(node).text})` : '';
            console.log(`    [${i}] ${pk}${tr}`);
        });
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

    const newVersion = (await ask('  New version string (e.g. v1.0.1): ')).trim();
    if (!newVersion) { console.log('  Cancelled.'); return; }

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

    console.log('  Building bundle...');
    const zip = new AdmZip(); zip.addLocalFolder(CONTRACT_DIR);
    const buf = zip.toBuffer();
    console.log(`  Bundle: ${(buf.length/1024).toFixed(1)} KB`);

    try {
        const result = await sendInput(ip, port, { type:'updateContract', newVersion, bundle:buf.toString('base64') }, 'updateContract', 20000);
        console.log(`\n  ✓ Contract updated.`);
        console.log(`    Was : ${result.version}`);
        console.log(`    Now : ${newVersion}`);
        console.log(`    LCL : ${result.lclSeqNo}`);
        await waitForSync(ip, port, stat.currentUnl.length);
    } catch(e) {
        if (currentVersion) {
            contractCode = contractCode.replace(`const CONTRACT_VERSION       = '${newVersion}'`, `const CONTRACT_VERSION       = '${currentVersion}'`);
            fs.writeFileSync(indexPath, contractCode);
            console.error(`\n  ✗ Update failed: ${e.message}. Version reverted to ${currentVersion}.`);
        }
    }
    console.log('─────────────────────────────────────────────────────\n');
};

const opAddNode = async () => {
    console.log('\n── Add Node ─────────────────────────────────────────');
    console.log('  Checking cluster is synced...');
    let stat;
    try {
        stat = await getStatus(ip, port);
        if (stat.voteStatus !== 'synced') { console.error('  ✗ Cluster not synced. Aborting.'); return; }
        console.log(`  ✓ Synced. Current UNL=${stat.currentUnl.length}`);
    } catch(e) { console.error(`  ✗ ${e.message}`); return; }

    // Offer to find hosts
    const findFirst = (await ask('\n  Find available hosts first? (yes/y or press Enter to skip): ')).trim();
    if (findFirst === 'yes' || findFirst === 'y') {
        await findHosts(1, 20);
        await ask('  Press Enter to continue...');
    }

    console.log('\n  ── STEP 1: Acquire the new node ──────────────────');
    const extHost = (await ask('  External host XRPL address: ')).trim();
    const moments = (await ask(`  Life moments (default ${process.env.DEFAULT_MOMENTS || 3}): `)).trim() || (process.env.DEFAULT_MOMENTS || '3');
    if (!extHost) { console.log('  Cancelled.'); return; }

    console.log(`\n  Acquiring on ${extHost} for ${moments} moments...\n`);

    let acquireOutput;
    try {
        acquireOutput = execSync(
            `bash -c 'set -a; source ${ENV_FILE}; set +a; unset EV_HP_OVERRIDE_CFG_PATH; sudo -E evdevkit acquire ${extHost} -m ${moments} -c ${contractId}'`,
            { encoding: 'utf8' }
        );
        console.log(acquireOutput);
    } catch(e) { console.error(`  ✗ Acquire failed: ${e.message}`); return; }

    const pubkeyMatch  = acquireOutput.match(/pubkey['":\s]+['"]?(ed[a-f0-9]{64})['"]?/);
    const peerMatch    = acquireOutput.match(/peer_port['":\s]+['"]?(\d+)['"]?/);
    const userMatch    = acquireOutput.match(/user_port['":\s]+['"]?(\d+)['"]?/);
    const domainMatch  = acquireOutput.match(/domain['":\s]+['"]?([a-zA-Z0-9._-]+\.[a-zA-Z]{2,})['"]?/);
    const nameMatch    = acquireOutput.match(/name['":\s]+['"]?([A-F0-9]{64})['"]?/);
    const tsMatch      = acquireOutput.match(/created_timestamp['":\s]+(\d+)/);

    if (!pubkeyMatch || !peerMatch || !userMatch || !domainMatch) { console.error('  ✗ Could not parse acquire output.'); return; }

    const newPubkey        = pubkeyMatch[1];
    const newPeerPort      = peerMatch[1];
    const newUserPort      = userMatch[1];
    const newDomain        = domainMatch[1];
    const newName          = nameMatch ? nameMatch[1] : '';
    const createdTimestamp = tsMatch ? parseInt(tsMatch[1]) : Date.now();

    console.log('  ── Acquired node details ─────────────────────────');
    console.log(`  Pubkey    : ${newPubkey}`);
    console.log(`  Domain    : ${newDomain}`);
    console.log(`  User port : ${newUserPort}`);
    console.log(`  Peer port : ${newPeerPort}`);

    console.log('\n  ── STEP 2: Building override config ──────────────');
    const allPubkeys = [...stat.currentUnl, newPubkey];
    const overrideCfg = {
        contract: {
            bin_path: '/usr/bin/node', bin_args: 'index.js',
            consensus: { roundtime: parseInt(process.env.HP_ROUNDTIME||5000), threshold: parseInt(process.env.HP_THRESHOLD||66) },
            unl: allPubkeys
        },
        mesh: { peer_discovery: { enabled: process.env.HP_PEER_DISCOVERY === 'true' }, known_peers: stat.peers }
    };
    const overridePath = path.join(PROJECT_DIR, 'node-override-temp.cfg');
    fs.writeFileSync(overridePath, JSON.stringify(overrideCfg, null, 2));
    console.log(`  ✓ Override config: ${allPubkeys.length} nodes in UNL, ${stat.peers.length} known peers`);

    console.log('\n  ── STEP 3: Building bundle ───────────────────────');
    try {
        execSync(`bash -c 'set -a; source ${ENV_FILE}; set +a; export EV_HP_OVERRIDE_CFG_PATH=${overridePath}; sudo -E evdevkit bundle ${CONTRACT_DIR} ${newPubkey} /usr/bin/node -a index.js'`, { encoding: 'utf8', cwd: PROJECT_DIR });
        console.log('  ✓ Bundle created.');
    } catch(e) { console.error(`  ✗ Bundle failed: ${e.message}`); fs.unlinkSync(overridePath); return; }

    console.log('\n  ── STEP 4: Deploying to new node ─────────────────');
    try {
        const deployOutput = execSync(`bash -c 'set -a; source ${ENV_FILE}; set +a; sudo -E evdevkit deploy ${PROJECT_DIR}/bundle/bundle.zip ${newDomain} ${newUserPort}'`, { encoding: 'utf8' });
        console.log(deployOutput);
        if (!deployOutput.includes('Contract bundle uploaded')) { console.error('  ✗ Deploy may have failed.'); fs.unlinkSync(overridePath); return; }
        console.log('  ✓ Bundle deployed.');
    } catch(e) { console.error(`  ✗ Deploy failed: ${e.message}`); fs.unlinkSync(overridePath); return; }

    fs.unlinkSync(overridePath);

    console.log('\n  ── STEP 5: Adding node to cluster UNL ────────────');
    try {
        const result = await sendInput(ip, port, { type:'addNode', pubkey:newPubkey, ip:newDomain, peerPort:parseInt(newPeerPort) }, 'addNode', 15000);
        console.log(`\n  ✓ Node added. UNL=${result.newUnlCount} LCL=${result.lclSeqNo}`);

        const nodes = loadNodes();
        nodes.push({ pubkey:newPubkey, name:newName, host:extHost, domain:newDomain, userPort:parseInt(newUserPort), peerPort:parseInt(newPeerPort), createdTimestamp, lifeMoments:parseInt(moments) });
        saveNodes(nodes);
        console.log('  ✓ Node saved to cluster-nodes.json');

        await waitForSync(ip, port, result.newUnlCount, 90000);

        const finalStat = await getStatus(ip, port);
        console.log('\n  ── Final verification ────────────────────────────');
        console.log(`  Vote Status : ${finalStat.voteStatus}`);
        console.log(`  UNL Count   : ${finalStat.currentUnl.length}`);
        console.log(`  Peers       : ${finalStat.peers.join(', ')}`);
    } catch(e) { console.error(`\n  ✗ Add node failed: ${e.message}`); }
    console.log('─────────────────────────────────────────────────────\n');
};

const opRemoveNode = async () => {
    console.log('\n── Remove Node ──────────────────────────────────────');
    let stat;
    try {
        stat = await getStatus(ip, port);
        if (stat.voteStatus !== 'synced') { console.error('  ✗ Cluster not synced. Aborting.'); return; }
        console.log(`  ✓ Synced. UNL=${stat.currentUnl.length}:`);
        stat.currentUnl.forEach((pk, i) => console.log(`    [${i}] ${pk}`));
    } catch(e) { console.error(`  ✗ ${e.message}`); return; }

    if (stat.currentUnl.length <= 3) { console.error('  ✗ Cannot remove — minimum safe cluster size is 3 nodes.'); return; }

    const input = (await ask('\n  Pubkey or index to remove: ')).trim();
    if (!input) { console.log('  Cancelled.'); return; }

    let targetPubkey = input;
    if (/^\d+$/.test(input)) {
        const idx = parseInt(input);
        if (idx >= 0 && idx < stat.currentUnl.length) { targetPubkey = stat.currentUnl[idx]; console.log(`  Selected: ${targetPubkey}`); }
        else { console.error('  ✗ Invalid index.'); return; }
    }

    const confirm = (await ask(`  Confirm remove ${targetPubkey.slice(0,20)}…? (yes/y): `)).trim();
    if (confirm !== 'yes' && confirm !== 'y') { console.log('  Cancelled.'); return; }

    try {
        const result = await sendInput(ip, port, { type:'removeNode', pubkey:targetPubkey }, 'removeNode', 15000);
        console.log(`\n  ✓ Node removed. UNL=${result.newUnlCount} LCL=${result.lclSeqNo}`);
        saveNodes(loadNodes().filter(n => n.pubkey !== targetPubkey));
        console.log('  ✓ Node removed from cluster-nodes.json');
        await waitForSync(ip, port, result.newUnlCount);
    } catch(e) { console.error(`\n  ✗ Remove failed: ${e.message}`); }
    console.log('─────────────────────────────────────────────────────\n');
};

const opCheckExpiry = async () => {
    console.log('\n── Node Expiry ──────────────────────────────────────');
    const nodes = loadNodes();
    if (nodes.length === 0) {
        console.log('  No node records found in cluster-nodes.json.');
        console.log('  Records are created when nodes are added via option 3 (Add a node).');
        console.log('─────────────────────────────────────────────────────\n');
        return;
    }

    console.log(`  Current time: ${new Date().toUTCString()}\n`);
    console.log('  ' + '─'.repeat(90));
    console.log('  ' + 'Pubkey'.padEnd(22) + 'Domain'.padEnd(25) + 'Moments'.padEnd(9) + 'Remaining'.padEnd(12) + 'Expires (UTC)');
    console.log('  ' + '─'.repeat(90));

    for (const node of nodes) {
        const tr = timeRemaining(node);
        console.log('  ' + (node.pubkey.slice(0,20)+'…').padEnd(22) + (node.domain||'').slice(0,23).padEnd(25) +
            String(node.lifeMoments).padEnd(9) + (tr.expired ? '⚠ EXPIRED' : tr.text).padEnd(12) +
            new Date(tr.expirySec * 1000).toUTCString());
    }
    console.log('  ' + '─'.repeat(90));
    console.log('─────────────────────────────────────────────────────\n');
};

const opExtendLease = async () => {
    console.log('\n── Extend Lease ─────────────────────────────────────');
    const nodes = loadNodes();
    if (nodes.length === 0) {
        console.log('  No node records found. Cannot extend without host address and instance name.');
        console.log('─────────────────────────────────────────────────────\n');
        return;
    }

    console.log('  Current nodes:\n');
    nodes.forEach((n, i) => {
        const tr = timeRemaining(n);
        console.log(`    [${i}] ${n.pubkey.slice(0,20)}… | ${n.domain} | ${tr.text}`);
    });

    const input = (await ask('\n  Node index to extend (or "all"): ')).trim();
    if (!input) { console.log('  Cancelled.'); return; }

    const momentsStr = (await ask('  Extend by how many moments (hours): ')).trim();
    if (!momentsStr || isNaN(momentsStr)) { console.log('  Cancelled.'); return; }
    const addMoments = parseInt(momentsStr);

    let targets = [];
    if (input === 'all') targets = nodes;
    else if (/^\d+$/.test(input)) {
        const idx = parseInt(input);
        if (idx >= 0 && idx < nodes.length) targets = [nodes[idx]];
        else { console.error('  ✗ Invalid index.'); return; }
    } else { console.error('  ✗ Enter an index number or "all".'); return; }

    console.log('');
    for (const node of targets) {
        if (!node.name || !node.host) { console.log(`  ✗ ${node.pubkey.slice(0,20)}… — missing name or host.`); continue; }
        process.stdout.write(`  Extending ${node.pubkey.slice(0,20)}… by ${addMoments} moment(s)...`);
        try {
            execSync(`bash -c 'set -a; source ${ENV_FILE}; set +a; sudo -E evdevkit extend-instance ${node.host} ${node.name} -m ${addMoments}'`, { encoding: 'utf8' });
            node.lifeMoments += addMoments;
            console.log(` ✓ Extended. Total life: ${node.lifeMoments} moments.`);
        } catch(e) { console.log(` ✗ Failed: ${e.message}`); }
    }
    saveNodes(nodes);
    console.log('\n  ✓ cluster-nodes.json updated.');
    console.log('─────────────────────────────────────────────────────\n');
};

const opFindHosts = async () => {
    const minSlots = parseInt((await ask('  Minimum available slots (default 1): ')).trim() || '1');
    const target   = parseInt((await ask('  Number of hosts to find (default 20): ')).trim() || '20');
    await findHosts(minSlots, target);
};

// ── Main Menu ─────────────────────────────────────────────────

const main = async () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║          Evernode Cluster Manager                   ║');
    console.log('╚══════════════════════════════════════════════════════╝');

    if (deployMode) {
        console.log('  No cluster specified — starting in deploy mode.');
        console.log('');
        await opDeploy();
        if (deployMode) {
            // Deploy was cancelled or failed
            rl.close();
            process.exit(0);
        }
    } else {
        console.log(`  Node     : ${ip}:${port}`);
        console.log(`  Contract : ${contractId}`);
        console.log(`  Project  : ${PROJECT_DIR}`);
        console.log('');
    }

    await opStatus();

    while (true) {
        console.log('  What would you like to do?');
        console.log('    1. Check status');
        console.log('    2. Update contract');
        console.log('    3. Add a node');
        console.log('    4. Remove a node');
        console.log('    5. Check node expiry');
        console.log('    6. Extend node lease');
        console.log('    7. Find available hosts');
        console.log('    8. Exit');
        console.log('');
        const choice = (await ask('  Choice: ')).trim();
        console.log('');

        switch (choice) {
            case '1': await opStatus(); break;
            case '2': await opUpdateContract(); break;
            case '3': await opAddNode(); break;
            case '4': await opRemoveNode(); break;
            case '5': await opCheckExpiry(); break;
            case '6': await opExtendLease(); break;
            case '7': await opFindHosts(); break;
            case '8':
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
