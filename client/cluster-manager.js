#!/usr/bin/env node
/**
 * Evernode Cluster Manager
 *
 * Single tool for deploying and managing multiple HotPocket cluster projects.
 * No host access required.
 *
 * Usage: node cluster-manager.js
 */

'use strict';

const path         = require('path');
const fs           = require('fs');
const readline     = require('readline');
const https        = require('https');
const { execSync, spawnSync } = require('child_process');
const vm           = require('vm');
const os           = require('os');

// ── Tool and projects paths ───────────────────────────────────
const TOOL_DIR      = path.dirname(__dirname);
const TOOL_CONTRACT = path.join(TOOL_DIR, 'contract');
const PROJECTS_DIR  = path.join(os.homedir(), '.evernode-clusters', 'projects');
const MOMENT_SECONDS = 3600;

// ── Current project state (set at runtime) ────────────────────
let PROJECT_DIR  = null;
let ENV_FILE     = null;
let NODES_FILE   = null;
let CONTRACT_DIR = null;
let INITCFG      = null;
let ip = null, port = null, contractId = null;

const setProject = (projectDir) => {
    PROJECT_DIR  = projectDir;
    ENV_FILE     = path.join(projectDir, '.env');
    NODES_FILE   = path.join(projectDir, 'cluster-nodes.json');
    CONTRACT_DIR = path.join(projectDir, 'contract');
    INITCFG      = path.join(projectDir, 'hp-init.cfg');
};

// ── readline ──────────────────────────────────────────────────
const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = () => new Date().toISOString().replace('T',' ').replace(/\..+/,'');
const hr = (n=52) => '─'.repeat(n);

// ── Project management ────────────────────────────────────────

const getProjects = () => {
    if (!fs.existsSync(PROJECTS_DIR)) return [];
    return fs.readdirSync(PROJECTS_DIR)
        .filter(f => fs.statSync(path.join(PROJECTS_DIR, f)).isDirectory())
        .map(name => {
            const dir = path.join(PROJECTS_DIR, name);
            const envFile = path.join(dir, '.env');
            const nodesFile = path.join(dir, 'cluster-nodes.json');
            let contractId = '', nodeCount = 0, lastNode = '';
            try {
                const env = fs.readFileSync(envFile, 'utf8');
                contractId = (env.match(/^CONTRACT_ID=(.+)$/m) || [])[1] || '';
                lastNode   = (env.match(/^LAST_NODE=(.+)$/m) || [])[1] || '';
            } catch {}
            try { nodeCount = JSON.parse(fs.readFileSync(nodesFile, 'utf8')).length; } catch {}
            return { name, dir, contractId, nodeCount, lastNode };
        });
};

const loadProjectEnv = () => {
    // Clear any previously loaded env vars that might conflict
    delete require.cache[require.resolve('dotenv')];
    require('dotenv').config({ path: ENV_FILE, override: true });
};

const saveProjectMeta = (meta) => {
    let env = fs.readFileSync(ENV_FILE, 'utf8');
    if (meta.contractId) { env = env.replace(/^CONTRACT_ID=.*\n?/m, ''); env += `\nCONTRACT_ID=${meta.contractId}`; }
    if (meta.lastNode)   { env = env.replace(/^LAST_NODE=.*\n?/m, '');   env += `\nLAST_NODE=${meta.lastNode}`; }
    fs.writeFileSync(ENV_FILE, env.trim() + '\n');
};

// ── Node tracking ─────────────────────────────────────────────

const loadNodes = () => {
    try { if (fs.existsSync(NODES_FILE)) return JSON.parse(fs.readFileSync(NODES_FILE, 'utf8')); } catch {}
    return [];
};
const saveNodes = (nodes) => fs.writeFileSync(NODES_FILE, JSON.stringify(nodes, null, 2));
const reconcileNodes = (nodes, currentUnl) => nodes.filter(n => currentUnl.includes(n.pubkey));

const timeRemaining = (node) => {
    const expirySec = Math.floor(node.createdTimestamp / 1000) + (node.lifeMoments * MOMENT_SECONDS);
    const remaining = expirySec - Math.floor(Date.now() / 1000);
    if (remaining <= 0) return { expired: true, text: 'EXPIRED', expirySec };
    return { expired: false, text: `${Math.floor(remaining/3600)}h ${Math.floor((remaining%3600)/60)}m`, expirySec, remaining };
};

// ── HP Client Helpers ─────────────────────────────────────────

const getKeyPair = async () => {
    const HP = require('hotpocket-js-client');
    return HP.generateKeys(process.env.EV_USER_PRIVATE_KEY);
};

const getStatus = async (targetIp, targetPort) => {
    const HP = require('hotpocket-js-client');
    const keyPair = await getKeyPair();
    const client = await HP.createClient([`wss://${targetIp}:${targetPort}`], keyPair, { protocol: HP.protocols.json });
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
            process.stdout.write(`  ${fmt()} | voteStatus=${stat.voteStatus} | unl=${stat.currentUnl.length}\r`);
            if (stat.voteStatus === 'synced' && (!expectedUnlCount || stat.currentUnl.length === expectedUnlCount)) {
                console.log(`\n  ✓ Synced! UNL=${stat.currentUnl.length}`);
                return stat;
            }
        } catch(e) { process.stdout.write(`  ${fmt()} | waiting... (${e.message})\r`); }
        await sleep(3000);
    }
    throw new Error('Timed out waiting for sync');
};

const sendInput = async (targetIp, targetPort, msg, expectedType, waitMs = 15000) => {
    const HP = require('hotpocket-js-client');
    const keyPair = await getKeyPair();
    const client = await HP.createClient([`wss://${targetIp}:${targetPort}`], keyPair, { protocol: HP.protocols.json });
    return new Promise(async (resolve, reject) => {
        let result = null;
        client.on(HP.events.contractOutput, (r) => {
            for (const o of r.outputs) {
                try { const p = JSON.parse(o); if (p.type === expectedType || p.type === 'error') result = p; } catch {}
            }
        });
        client.on(HP.events.disconnect, () => {});
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

// Get contract version by sending status input to contract
const getContractVersion = async (targetIp, targetPort) => {
    try {
        const result = await sendInput(targetIp, targetPort, { type: 'status' }, 'status', 12000);
        return result.version || 'unknown';
    } catch { return 'unknown'; }
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
    console.log(`\n  Scanning for ${targetCount} active hosts with >= ${minSlots} slot(s)...`);
    console.log(`  Note: The Evernode network has 15,000+ registered hosts, most inactive.`);
    console.log(`  Hosts are checked in batches of 15 — this typically takes 1-2 minutes.\n`);    
    const get = (url) => new Promise((resolve, reject) => {
        https.get(url, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){reject(e);} }); }).on('error', reject);
    });
    process.stdout.write('  Fetching host list...');
    const data = await get('https://xahau.xrplwin.com/api/evernode/hosts');
    const priceMap = {};
    const allHosts = data.data.filter(h=>h.leaseprice_evr_drops!==null&&h.host).map(h=>{ priceMap[h.host]=h.leaseprice_evr_drops; return h.host; });
    console.log(` ${allHosts.length} registered hosts.`);
    const shuffled = allHosts.sort(()=>Math.random()-0.5);
    const found=[]; const checked=new Set(); let idx=0,batchNum=0;
    while (found.length<targetCount&&idx<shuffled.length) {
        const batch=[];
        while (batch.length<batchSize&&idx<shuffled.length) { if(!checked.has(shuffled[idx])){batch.push(shuffled[idx]);checked.add(shuffled[idx]);} idx++; }
        if (!batch.length) break;
        batchNum++;
        process.stdout.write(`  Batch ${String(batchNum).padStart(2)} | Checked: ${checked.size} | Found: ${found.length}/${targetCount}\r`);
        const tmpFile='/tmp/ecm-hosts-batch.txt'; fs.writeFileSync(tmpFile,batch.join('\n'));
        const result=spawnSync('evdevkit',['hostinfo','-f',tmpFile],{encoding:'utf8',timeout:60000});
        try{fs.unlinkSync(tmpFile);}catch{}
        const info=parseEvmOutput(result.stdout||'');
        if (Array.isArray(info)) info.filter(h=>h.active&&h.availableInstanceSlots>=minSlots).forEach(h=>{ h.leasePrice=priceMap[h.address]||null; found.push(h); });
    }
    console.log(`\n  Found ${found.length} active host(s).\n`);
    found.sort((a,b)=>b.availableInstanceSlots-a.availableInstanceSlots||(a.leasePrice||0)-(b.leasePrice||0));
    const fmtEVR=(d)=>{ if(!d)return'free?'; const e=d/1000000; if(e<0.001)return`${d}drops`; if(e<1)return`${e.toFixed(4)} EVR`; return`${e.toFixed(2)} EVR`; };
    console.log('  '+hr(112));
    console.log('  '+'#'.padEnd(4)+'Address'.padEnd(36)+'Domain'.padEnd(25)+'CC'.padEnd(5)+'Avail'.padEnd(7)+'Total'.padEnd(7)+'RAM'.padEnd(12)+'Lease/hr'.padEnd(12)+'Version');
    console.log('  '+hr(112));
    found.forEach((h,i)=>console.log('  '+String(i+1).padEnd(4)+(h.address||'').padEnd(36)+(h.domain||'').slice(0,23).padEnd(25)+(h.countryCode||'??').padEnd(5)+String(h.availableInstanceSlots||0).padEnd(7)+String(h.totalInstanceSlots||0).padEnd(7)+(h.ram||'').slice(0,10).padEnd(12)+fmtEVR(h.leasePrice).padEnd(12)+(h.sashimonoVersion||'?')));
    console.log('  '+hr(112));
    return found;
};

// ── Project Setup ─────────────────────────────────────────────

const createProject = async () => {
    console.log('\n── New Project Setup ────────────────────────────────');

    let projectName;
    while (true) {
        projectName = (await ask('  Project name (e.g. my-app): ')).trim().toLowerCase().replace(/[^a-z0-9-]/g,'-');
        if (!projectName) { console.log('  Cannot be empty.'); continue; }
        if (fs.existsSync(path.join(PROJECTS_DIR, projectName))) { console.log(`  Project "${projectName}" already exists.`); continue; }
        break;
    }

    const projectDir = path.join(PROJECTS_DIR, projectName);
    fs.mkdirSync(path.join(projectDir, 'contract'), { recursive: true });
    setProject(projectDir);

    // Keys
    console.log('\n── Key Generation ────────────────────────────────────');
    const hasKeys = (await ask('  Have existing HotPocket user keys? (yes/y or Enter to generate): ')).trim();
    let userPrivKey='', userPubKey='';
    if (hasKeys==='yes'||hasKeys==='y') {
        userPrivKey = (await ask('  EV_USER_PRIVATE_KEY: ')).trim();
        userPubKey  = (await ask('  EV_USER_PUBLIC_KEY : ')).trim();
    } else {
        console.log('  Generating new key pair...');
        try {
            const out = execSync('evdevkit keygen 2>&1', { encoding: 'utf8' });
            console.log(out);
            userPrivKey = (out.match(/private[Kk]ey['":\s]+(ed[a-f0-9]{128})/i)||[])[1]||'';
            userPubKey  = (out.match(/public[Kk]ey['":\s]+(ed[a-f0-9]{64})/i)||[])[1]||'';
        } catch {}
        if (!userPrivKey||!userPubKey) {
            console.log('  Could not parse keys. Enter manually:');
            userPrivKey = (await ask('  EV_USER_PRIVATE_KEY: ')).trim();
            userPubKey  = (await ask('  EV_USER_PUBLIC_KEY : ')).trim();
        } else { console.log('  ✓ Keys generated.'); }
    }

    // XRPL credentials
    console.log('\n── XRPL Tenant Credentials ───────────────────────────');
    const tenantSecret  = (await ask('  EV_TENANT_SECRET : ')).trim();
    const tenantAddress = (await ask('  EV_TENANT_ADDRESS: ')).trim();

    // HotPocket settings
    console.log('\n── HotPocket Settings ────────────────────────────────');
    const roundtime     = (await ask('  Round time ms     (default 5000): ')).trim()||'5000';
    const threshold     = (await ask('  Threshold %       (default 66)  : ')).trim()||'66';
    const logLevel      = (await ask('  Log level         (default dbg)  : ')).trim()||'dbg';
    const peerDiscovery = (await ask('  Peer discovery    (default false) : ')).trim()||'false';

    // Contract settings
    console.log('\n── Contract Settings ─────────────────────────────────');
    const contractVersion = (await ask('  Starting version  (default v1.0.0): ')).trim()||'v1.0.0';
    const defaultNodes    = (await ask('  Default node count(default 3)      : ')).trim()||'3';
    const defaultMoments  = (await ask('  Default moments   (default 3)      : ')).trim()||'3';

    // Contract source
    console.log('\n── Contract Source ───────────────────────────────────');
    console.log('  1. Use default cluster management contract (recommended)');
    console.log('  2. Use my own contract');
    console.log('');
    let contractSrcDir = TOOL_CONTRACT;
    while (true) {
        const choice = (await ask('  Choice (1 or 2): ')).trim();
        if (choice === '1') { contractSrcDir = TOOL_CONTRACT; break; }
        if (choice === '2') {
            const customPath = (await ask('  Path to your contract directory: ')).trim();
            if (fs.existsSync(customPath) && fs.statSync(customPath).isDirectory()) {
                contractSrcDir = customPath; break;
            }
            console.log('  Directory not found. Try again.');
        }
    }

    // Write .env
    fs.writeFileSync(ENV_FILE, `# Evernode Cluster Manager — Project: ${projectName}
# Created: ${new Date().toUTCString()}

EV_TENANT_SECRET=${tenantSecret}
EV_TENANT_ADDRESS=${tenantAddress}
EV_USER_PRIVATE_KEY=${userPrivKey}
EV_USER_PUBLIC_KEY=${userPubKey}

DEFAULT_NODE_COUNT=${defaultNodes}
DEFAULT_MOMENTS=${defaultMoments}
HP_ROUNDTIME=${roundtime}
HP_THRESHOLD=${threshold}
HP_LOG_LEVEL=${logLevel}
HP_PEER_DISCOVERY=${peerDiscovery}
CONTRACT_VERSION=${contractVersion}
`, { mode: 0o600 });

    // Write hp-init.cfg
    fs.writeFileSync(INITCFG, JSON.stringify({
        contract: { consensus: { roundtime: parseInt(roundtime), threshold: parseInt(threshold) } },
        mesh: { peer_discovery: { enabled: peerDiscovery==='true' } },
        log: { log_level: logLevel }
    }, null, 2));

    // Write hp.cfg.override
    const overrideCfg = { contract: { bin_path:'/usr/bin/node', bin_args:'index.js', consensus:{ roundtime:parseInt(roundtime), threshold:parseInt(threshold) } } };
    fs.writeFileSync(path.join(projectDir, 'hp.cfg.override'), JSON.stringify(overrideCfg, null, 2));

    // Copy contract files
    for (const f of fs.readdirSync(contractSrcDir)) {
        if (f === 'node_modules') continue;
        fs.copyFileSync(path.join(contractSrcDir, f), path.join(CONTRACT_DIR, f));
    }
    // Always use project's hp.cfg.override in contract dir
    fs.copyFileSync(path.join(projectDir, 'hp.cfg.override'), path.join(CONTRACT_DIR, 'hp.cfg.override'));

    // Update version in index.js if it has CONTRACT_VERSION
    const idxPath = path.join(CONTRACT_DIR, 'index.js');
    if (fs.existsSync(idxPath)) {
        let idx = fs.readFileSync(idxPath, 'utf8');
        if (idx.includes('CONTRACT_VERSION')) {
            idx = idx.replace(/const CONTRACT_VERSION\s+=\s+'[^']+'/, `const CONTRACT_VERSION       = '${contractVersion}'`);
            fs.writeFileSync(idxPath, idx);
        }
    }

    // Install contract dependencies
    if (fs.existsSync(path.join(CONTRACT_DIR, 'package.json'))) {
        console.log('\n  Installing contract dependencies...');
        execSync(`npm install --prefix ${CONTRACT_DIR} --silent`);
        console.log('  ✓ Done');
    }

    loadProjectEnv();

    console.log('\n  ✓ Project created successfully.');
    console.log(`  Location: ${projectDir}\n`);
    return projectName;
};

// ── Deploy ────────────────────────────────────────────────────

const opDeploy = async () => {
    console.log('\n── Deploy New Cluster ───────────────────────────────');

    const findFirst = (await ask('  Find available hosts first? (yes/y or Enter to skip): ')).trim();
    if (findFirst==='yes'||findFirst==='y') {
        const minSlots = parseInt((await ask('  Minimum available slots (default 1): ')).trim()||'1');
        await findHosts(minSlots, 20);
        await ask('  Press Enter to continue...');
    }

    let nodeCount;
    while (true) {
        const input = (await ask(`\n  How many nodes? (default ${process.env.DEFAULT_NODE_COUNT||3}, minimum 3): `)).trim();
        nodeCount = parseInt(input||process.env.DEFAULT_NODE_COUNT||'3');
        if (nodeCount>=3) break;
        console.log('  Must be >= 3.');
    }

    console.log(`\n  Enter ${nodeCount} host XRPL address(es).\n`);
    const hostAddrs=[];
    for (let i=1;i<=nodeCount;i++) {
        while (true) { const a=(await ask(`  Host ${i}: `)).trim(); if(a){hostAddrs.push(a);break;} }
    }

    let moments;
    while (true) {
        const input=(await ask(`\n  Life moments per node? (default ${process.env.DEFAULT_MOMENTS||3}): `)).trim();
        moments=parseInt(input||process.env.DEFAULT_MOMENTS||'3');
        if (moments>=1) break;
    }

    console.log('\n── Summary ───────────────────────────────────────────');
    console.log(`  Nodes   : ${nodeCount}`);
    console.log(`  Moments : ${moments} (~${moments}hr per node)`);
    console.log('  Hosts   :');
    hostAddrs.forEach((h,i)=>console.log(`    ${i+1}. ${h}`));
    console.log('');
    const confirm=(await ask('  Proceed? (yes/y): ')).trim();
    if (confirm!=='yes'&&confirm!=='y') { console.log('  Cancelled.'); return false; }

    console.log('');
    console.log('[1/3] Installing contract dependencies...');
    execSync(`npm install --prefix ${CONTRACT_DIR} --silent`);
    console.log('      ✓ Done.');

    console.log('[2/3] Writing authorized_pubkey.txt...');
    fs.writeFileSync(path.join(CONTRACT_DIR,'authorized_pubkey.txt'), process.env.EV_USER_PUBLIC_KEY+'\n');
    console.log(`      ✓ ${process.env.EV_USER_PUBLIC_KEY}`);

    const hostsFile='/tmp/ecm-deploy-hosts.txt';
    fs.writeFileSync(hostsFile, hostAddrs.join('\n'));

    console.log('[3/3] Running evdevkit cluster-create...\n');
    let clusterOutput = '';
    try {
        clusterOutput = execSync(
            `bash -c 'set -a; source ${ENV_FILE}; set +a; unset EV_HP_OVERRIDE_CFG_PATH; export EV_HP_INIT_CFG_PATH=${INITCFG}; sudo -E evdevkit cluster-create ${nodeCount} -m ${moments} ${CONTRACT_DIR} /usr/bin/node ${hostsFile} -a index.js'`,
            { encoding:'utf8' }
        );
        process.stdout.write(clusterOutput);
    } catch(e) {
        console.error('\n  ✗ cluster-create failed');
        try{fs.unlinkSync(hostsFile);}catch{}
        return false;
    }
    try{fs.unlinkSync(hostsFile);}catch{}

    // Auto-parse cluster output
    console.log('\n  Parsing cluster output...');
    const nodes = parseEvmOutput(clusterOutput);
    if (!Array.isArray(nodes) || nodes.length === 0) {
        console.log('  ⚠ Could not auto-parse output. Please enter details manually.');
        contractId = (await ask('  Contract ID: ')).trim();
        ip         = (await ask('  Node IP/domain: ')).trim();
        port       = (await ask('  Node user port: ')).trim();
    } else {
        // Extract from parsed nodes
        contractId = nodes[0].contract_id;
        ip         = nodes[0].domain;
        port       = String(nodes[0].user_port);

        // Save all nodes to cluster-nodes.json
        const nodeRecords = nodes.map(n => ({
            pubkey           : n.pubkey,
            name             : n.name,
            host             : n.host,
            domain           : n.domain,
            userPort         : parseInt(n.user_port),
            peerPort         : parseInt(n.peer_port),
            createdTimestamp : n.created_timestamp,
            lifeMoments      : n.life_moments
        }));
        saveNodes(nodeRecords);

        console.log(`  ✓ Contract ID : ${contractId}`);
        console.log(`  ✓ Connecting  : ${ip}:${port}`);
        console.log(`  ✓ Saved ${nodeRecords.length} node(s) to cluster-nodes.json`);
    }

    if (!contractId||!ip||!port) { console.log('  ✗ Missing cluster details.'); return false; }

    saveProjectMeta({ contractId, lastNode:`${ip}:${port}` });
    console.log('\n  ✓ Cluster deployed and project updated.\n');
    return true;
};

// ── Operations ────────────────────────────────────────────────

const opStatus = async () => {
    console.log('\n  Fetching cluster status...');
    try {
        const stat = await getStatus(ip, port);
        let nodes = loadNodes();
        const reconciled = reconcileNodes(nodes, stat.currentUnl);
        if (reconciled.length!==nodes.length) { saveNodes(reconciled); nodes=reconciled; }

        // Get contract version from contract
        let contractVersion = 'fetching...';
        try {
            contractVersion = await getContractVersion(ip, port);
        } catch { contractVersion = 'unknown'; }

        console.log('\n── Cluster Status ───────────────────────────────────');
        console.log(`  Project          : ${path.basename(PROJECT_DIR)}`);
        console.log(`  Contract ID      : ${contractId}`);
        console.log(`  Contract Version : ${contractVersion}`);
        console.log(`  HP Version       : ${stat.hpVersion}`);
        console.log(`  Vote Status      : ${stat.voteStatus}`);
        console.log(`  LCL              : ${stat.ledgerSeqNo}`);
        console.log(`  Round Time       : ${stat.roundTime}ms`);
        console.log(`  UNL Count        : ${stat.currentUnl.length}`);
        console.log('  UNL Nodes        :');
        stat.currentUnl.forEach((pk,i)=>{ const n=nodes.find(n=>n.pubkey===pk); console.log(`    [${i}] ${pk}${n?` (${timeRemaining(n).text})`:''}`); });
        console.log('  Peers            :');
        stat.peers.forEach(p=>console.log(`    ${p}`));
        console.log('─────────────────────────────────────────────────────\n');
        return stat;
    } catch(e) { console.error(`  ✗ ${e.message}`); }
};

const opUpdateContract = async () => {
    console.log('\n── Update Contract ──────────────────────────────────');
    let stat;
    try {
        stat = await getStatus(ip, port);
        if (stat.voteStatus!=='synced') { console.error('  ✗ Cluster not synced. Aborting.'); return; }
        console.log(`  ✓ Synced. UNL=${stat.currentUnl.length}`);
    } catch(e) { console.error(`  ✗ ${e.message}`); return; }

    const newVersion=(await ask('  New version string (e.g. v1.0.1): ')).trim();
    if (!newVersion) { console.log('  Cancelled.'); return; }

    const AdmZip = require('adm-zip');
    const indexPath=path.join(CONTRACT_DIR,'index.js');
    let code=fs.readFileSync(indexPath,'utf8');
    const cur=(code.match(/const CONTRACT_VERSION\s+=\s+'([^']+)'/)||[])[1];
    if (cur) {
        code=code.replace(`const CONTRACT_VERSION       = '${cur}'`,`const CONTRACT_VERSION       = '${newVersion}'`);
        fs.writeFileSync(indexPath,code);
        console.log(`  Updated: ${cur} → ${newVersion}`);
    }

    const zip=new AdmZip(); zip.addLocalFolder(CONTRACT_DIR);
    const buf=zip.toBuffer();
    console.log(`  Bundle: ${(buf.length/1024).toFixed(1)} KB`);

    try {
        const result=await sendInput(ip,port,{type:'updateContract',newVersion,bundle:buf.toString('base64')},'updateContract',20000);
        console.log(`\n  ✓ Updated. Was: ${result.version} → Now: ${newVersion} | LCL: ${result.lclSeqNo}`);
        await waitForSync(ip,port,stat.currentUnl.length);
    } catch(e) {
        if (cur) { code=code.replace(`const CONTRACT_VERSION       = '${newVersion}'`,`const CONTRACT_VERSION       = '${cur}'`); fs.writeFileSync(indexPath,code); }
        console.error(`\n  ✗ Update failed: ${e.message}. Version reverted.`);
    }
    console.log('─────────────────────────────────────────────────────\n');
};

const opAddNode = async () => {
    console.log('\n── Add Node ─────────────────────────────────────────');
    let stat;
    try {
        stat=await getStatus(ip,port);
        if (stat.voteStatus!=='synced') { console.error('  ✗ Cluster not synced. Aborting.'); return; }
        console.log(`  ✓ Synced. UNL=${stat.currentUnl.length}`);
    } catch(e) { console.error(`  ✗ ${e.message}`); return; }

    const findFirst=(await ask('\n  Find available hosts first? (yes/y or Enter to skip): ')).trim();
    if (findFirst==='yes'||findFirst==='y') { await findHosts(1,20); await ask('  Press Enter to continue...'); }

    console.log('\n  ── STEP 1: Acquire ───────────────────────────────');
    const extHost=(await ask('  External host XRPL address: ')).trim();
    const moments=(await ask(`  Life moments (default ${process.env.DEFAULT_MOMENTS||3}): `)).trim()||(process.env.DEFAULT_MOMENTS||'3');
    if (!extHost) { console.log('  Cancelled.'); return; }

    let acquireOutput;
    try {
        acquireOutput=execSync(`bash -c 'set -a; source ${ENV_FILE}; set +a; unset EV_HP_OVERRIDE_CFG_PATH; sudo -E evdevkit acquire ${extHost} -m ${moments} -c ${contractId}'`,{encoding:'utf8'});
        console.log(acquireOutput);
    } catch(e) { console.error(`  ✗ Acquire failed: ${e.message}`); return; }

    const pub  =(acquireOutput.match(/pubkey['":\s]+['"]?(ed[a-f0-9]{64})['"]?/)||[])[1];
    const peer =(acquireOutput.match(/peer_port['":\s]+['"]?(\d+)['"]?/)||[])[1];
    const user =(acquireOutput.match(/user_port['":\s]+['"]?(\d+)['"]?/)||[])[1];
    const dom  =(acquireOutput.match(/domain['":\s]+['"]?([a-zA-Z0-9._-]+\.[a-zA-Z]{2,})['"]?/)||[])[1];
    const name =(acquireOutput.match(/name['":\s]+['"]?([A-F0-9]{64})['"]?/)||[])[1]||'';
    const ts   =parseInt((acquireOutput.match(/created_timestamp['":\s]+(\d+)/)||[])[1]||Date.now());
    if (!pub||!peer||!user||!dom) { console.error('  ✗ Could not parse acquire output.'); return; }

    console.log('\n  ── STEP 2: Override config ───────────────────────');
    const allPubkeys=[...stat.currentUnl,pub];
    const overridePath=path.join(PROJECT_DIR,'node-override-temp.cfg');
    fs.writeFileSync(overridePath,JSON.stringify({
        contract:{bin_path:'/usr/bin/node',bin_args:'index.js',consensus:{roundtime:parseInt(process.env.HP_ROUNDTIME||5000),threshold:parseInt(process.env.HP_THRESHOLD||66)},unl:allPubkeys},
        mesh:{peer_discovery:{enabled:process.env.HP_PEER_DISCOVERY==='true'},known_peers:stat.peers}
    },null,2));
    console.log(`  ✓ ${allPubkeys.length} nodes in UNL`);

    console.log('\n  ── STEP 3: Bundle ────────────────────────────────');
    try {
        execSync(`bash -c 'set -a; source ${ENV_FILE}; set +a; export EV_HP_OVERRIDE_CFG_PATH=${overridePath}; sudo -E evdevkit bundle ${CONTRACT_DIR} ${pub} /usr/bin/node -a index.js'`,{encoding:'utf8',cwd:PROJECT_DIR});
        console.log('  ✓ Bundle created.');
    } catch(e) { console.error(`  ✗ Bundle failed: ${e.message}`); fs.unlinkSync(overridePath); return; }

    console.log('\n  ── STEP 4: Deploy ────────────────────────────────');
    try {
        const out=execSync(`bash -c 'set -a; source ${ENV_FILE}; set +a; sudo -E evdevkit deploy ${PROJECT_DIR}/bundle/bundle.zip ${dom} ${user}'`,{encoding:'utf8'});
        console.log(out);
        if (!out.includes('Contract bundle uploaded')) { console.error('  ✗ Deploy may have failed.'); fs.unlinkSync(overridePath); return; }
        console.log('  ✓ Bundle deployed.');
    } catch(e) { console.error(`  ✗ Deploy failed: ${e.message}`); fs.unlinkSync(overridePath); return; }
    fs.unlinkSync(overridePath);

    console.log('\n  ── STEP 5: Add to UNL ────────────────────────────');
    try {
        const result=await sendInput(ip,port,{type:'addNode',pubkey:pub,ip:dom,peerPort:parseInt(peer)},'addNode',15000);
        console.log(`\n  ✓ Node added. UNL=${result.newUnlCount} LCL=${result.lclSeqNo}`);
        const nodes=loadNodes();
        nodes.push({pubkey:pub,name,host:extHost,domain:dom,userPort:parseInt(user),peerPort:parseInt(peer),createdTimestamp:ts,lifeMoments:parseInt(moments)});
        saveNodes(nodes);
        console.log('  ✓ Saved to cluster-nodes.json');
        await waitForSync(ip,port,result.newUnlCount,90000);
        const fs2=await getStatus(ip,port);
        console.log(`\n  Vote Status: ${fs2.voteStatus} | UNL: ${fs2.currentUnl.length} | Peers: ${fs2.peers.join(', ')}`);
    } catch(e) { console.error(`\n  ✗ Add node failed: ${e.message}`); }
    console.log('─────────────────────────────────────────────────────\n');
};

const opRemoveNode = async () => {
    console.log('\n── Remove Node ──────────────────────────────────────');
    let stat;
    try {
        stat=await getStatus(ip,port);
        if (stat.voteStatus!=='synced') { console.error('  ✗ Cluster not synced. Aborting.'); return; }
        console.log(`  ✓ Synced. UNL=${stat.currentUnl.length}:`);
        stat.currentUnl.forEach((pk,i)=>console.log(`    [${i}] ${pk}`));
    } catch(e) { console.error(`  ✗ ${e.message}`); return; }
    if (stat.currentUnl.length<=3) { console.error('  ✗ Cannot remove — minimum 3 nodes.'); return; }

    const input=(await ask('\n  Pubkey or index to remove: ')).trim();
    if (!input) { console.log('  Cancelled.'); return; }
    let targetPubkey=input;
    if (/^\d+$/.test(input)) {
        const idx=parseInt(input);
        if (idx>=0&&idx<stat.currentUnl.length) { targetPubkey=stat.currentUnl[idx]; console.log(`  Selected: ${targetPubkey}`); }
        else { console.error('  ✗ Invalid index.'); return; }
    }
    const confirm=(await ask(`  Confirm remove ${targetPubkey.slice(0,20)}…? (yes/y): `)).trim();
    if (confirm!=='yes'&&confirm!=='y') { console.log('  Cancelled.'); return; }
    try {
        const result=await sendInput(ip,port,{type:'removeNode',pubkey:targetPubkey},'removeNode',15000);
        console.log(`\n  ✓ Node removed. UNL=${result.newUnlCount} LCL=${result.lclSeqNo}`);
        saveNodes(loadNodes().filter(n=>n.pubkey!==targetPubkey));
        console.log('  ✓ Removed from cluster-nodes.json');
        await waitForSync(ip,port,result.newUnlCount);
    } catch(e) { console.error(`\n  ✗ Remove failed: ${e.message}`); }
    console.log('─────────────────────────────────────────────────────\n');
};

const opCheckExpiry = async () => {
    console.log('\n── Node Expiry ──────────────────────────────────────');
    const nodes=loadNodes();
    if (!nodes.length) {
        console.log('  No node records found.');
        console.log('  Records are created when nodes are added via option 3 or when a cluster is deployed.');
        console.log('─────────────────────────────────────────────────────\n');
        return;
    }
    console.log(`  Current time: ${new Date().toUTCString()}\n`);
    console.log('  '+hr(90));
    console.log('  '+'Pubkey'.padEnd(22)+'Domain'.padEnd(25)+'Moments'.padEnd(9)+'Remaining'.padEnd(12)+'Expires (UTC)');
    console.log('  '+hr(90));
    nodes.forEach(n=>{ const tr=timeRemaining(n); console.log('  '+(n.pubkey.slice(0,20)+'…').padEnd(22)+(n.domain||'').slice(0,23).padEnd(25)+String(n.lifeMoments).padEnd(9)+(tr.expired?'⚠ EXPIRED':tr.text).padEnd(12)+new Date(tr.expirySec*1000).toUTCString()); });
    console.log('  '+hr(90));
    console.log('─────────────────────────────────────────────────────\n');
};

const opExtendLease = async () => {
    console.log('\n── Extend Lease ─────────────────────────────────────');
    const nodes=loadNodes();
    if (!nodes.length) { console.log('  No node records found.'); console.log('─────────────────────────────────────────────────────\n'); return; }
    nodes.forEach((n,i)=>{ const tr=timeRemaining(n); console.log(`    [${i}] ${n.pubkey.slice(0,20)}… | ${n.domain} | ${tr.text}`); });
    const input=(await ask('\n  Node index (or "all"): ')).trim();
    if (!input) { console.log('  Cancelled.'); return; }
    const momentsStr=(await ask('  Extend by how many moments: ')).trim();
    if (!momentsStr||isNaN(momentsStr)) { console.log('  Cancelled.'); return; }
    const addMoments=parseInt(momentsStr);
    const targets=input==='all'?nodes:/^\d+$/.test(input)&&parseInt(input)<nodes.length?[nodes[parseInt(input)]]:null;
    if (!targets) { console.error('  ✗ Invalid input.'); return; }
    console.log('');
    for (const node of targets) {
        if (!node.name||!node.host) { console.log(`  ✗ ${node.pubkey.slice(0,20)}… — missing details.`); continue; }
        process.stdout.write(`  Extending ${node.pubkey.slice(0,20)}… by ${addMoments} moment(s)...`);
        try {
            execSync(`bash -c 'set -a; source ${ENV_FILE}; set +a; sudo -E evdevkit extend-instance ${node.host} ${node.name} -m ${addMoments}'`,{encoding:'utf8'});
            node.lifeMoments+=addMoments;
            console.log(` ✓ Total: ${node.lifeMoments} moments.`);
        } catch(e) { console.log(` ✗ ${e.message}`); }
    }
    saveNodes(nodes);
    console.log('\n  ✓ cluster-nodes.json updated.');
    console.log('─────────────────────────────────────────────────────\n');
};

const opFindHosts = async () => {
    const minSlots=parseInt((await ask('  Minimum available slots (default 1): ')).trim()||'1');
    const target=parseInt((await ask('  Number of hosts to find (default 20): ')).trim()||'20');
    await findHosts(minSlots,target);
};

// ── Project selector ──────────────────────────────────────────

const selectProject = async () => {
    const projects = getProjects();
    console.log('');
    if (projects.length === 0) {
        console.log('  No projects found. Creating your first project...');
        return await createProject();
    }

    console.log('  Select a project:\n');
    projects.forEach((p,i) => {
        const status = p.contractId ? `contract: ${p.contractId.slice(0,8)}… | ${p.lastNode||'no node saved'}` : 'no cluster yet';
        console.log(`    ${i+1}. ${p.name.padEnd(22)} ${status}`);
    });
    console.log(`    ${projects.length+1}. Create new project`);
    console.log(`    ${projects.length+2}. Exit`);
    console.log('');

    while (true) {
        const input=(await ask('  Choice: ')).trim();
        const idx=parseInt(input);
        if (idx===projects.length+2) { rl.close(); process.exit(0); }
        if (idx===projects.length+1) { return await createProject(); }
        if (idx>=1&&idx<=projects.length) {
            const project=projects[idx-1];
            setProject(project.dir);
            loadProjectEnv();
            if (project.lastNode) { const parts=project.lastNode.split(':'); ip=parts[0]; port=parts[1]; }
            if (project.contractId) contractId=project.contractId;
            console.log(`\n  ✓ Loaded project: ${project.name}`);
            return project.name;
        }
        console.log('  Invalid choice.');
    }
};

// ── Management menu ───────────────────────────────────────────

const managementMenu = async () => {
    if (!contractId||!ip||!port) {
        console.log('\n  No cluster deployed yet for this project.');
        const deploy=(await ask('  Deploy a new cluster now? (yes/y or Enter to skip): ')).trim();
        if (deploy==='yes'||deploy==='y') { const ok=await opDeploy(); if (!ok) return; }
        else { console.log('  Returning to project selector...\n'); return; }
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
        console.log('    8. Switch project');
        console.log('    9. Exit');
        console.log('');
        const choice=(await ask('  Choice: ')).trim();
        console.log('');

        switch (choice) {
            case '1': await opStatus(); break;
            case '2': await opUpdateContract(); break;
            case '3': await opAddNode(); break;
            case '4': await opRemoveNode(); break;
            case '5': await opCheckExpiry(); break;
            case '6': await opExtendLease(); break;
            case '7': await opFindHosts(); break;
            case '8': return 'switch';
            case '9': console.log('  Goodbye.\n'); rl.close(); process.exit(0);
            default: console.log('  Invalid choice.\n');
        }
    }
};

// ── Main ──────────────────────────────────────────────────────

const main = async () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║          Evernode Cluster Manager                   ║');
    console.log('╚══════════════════════════════════════════════════════╝');

    fs.mkdirSync(PROJECTS_DIR, { recursive: true });

    // Install client dependencies if needed
    const clientNodeModules = path.join(TOOL_DIR, 'client', 'node_modules');
    if (!fs.existsSync(clientNodeModules)) {
        console.log('\n  Installing dependencies...');
        execSync(`npm install --prefix ${path.join(TOOL_DIR, 'client')} --silent`);
        console.log('  ✓ Done\n');
    }

    while (true) {
        await selectProject();
        const result = await managementMenu();
        if (result !== 'switch') break;
        ip=null; port=null; contractId=null;
        PROJECT_DIR=null; ENV_FILE=null; NODES_FILE=null; CONTRACT_DIR=null; INITCFG=null;
        console.log('\n  Switching project...\n');
    }
};

main().catch(e => { console.error('Fatal:', e.message); rl.close(); process.exit(1); });
