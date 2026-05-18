#!/usr/bin/env node
/**
 * Evernode Client Cluster Manager v3.0.0
 *
 * Single tool for deploying and managing multiple HotPocket cluster projects.
 * No host access required.
 *
 * Usage: node cluster-manager.js
 */

'use strict';

const TOOL_VERSION = 'v3.2.0';

const path         = require('path');
const fs           = require('fs');
const readline     = require('readline');
const { execSync } = require('child_process');
const vm           = require('vm');
const os           = require('os');

// Suppress HP client connection logging (show errors only)
require('hotpocket-js-client').setLogLevel(1);

// ── Debug logging ─────────────────────────────────────────────
// When DEBUG=true in ~/.evernode-clusters/.env, all console output is
// mirrored to ~/.evernode-clusters/cluster-manager.log with timestamps.
// Log rotates at 2MB, keeping one previous log as cluster-manager.log.1
const GLOBAL_LOG = path.join(os.homedir(), '.evernode-clusters', 'cluster-manager.log');
const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2MB

const initDebugLogging = () => {
    // Load global env to check DEBUG flag before PROJECT_DIR is set
    const globalEnvPath = path.join(os.homedir(), '.evernode-clusters', '.env');
    let debugEnabled = false;
    try {
        if (fs.existsSync(globalEnvPath)) {
            const envContent = fs.readFileSync(globalEnvPath, 'utf8');
            debugEnabled = /^\s*DEBUG\s*=\s*true\s*$/m.test(envContent);
        }
    } catch {}
    if (!debugEnabled) return;

    const logDir = path.dirname(GLOBAL_LOG);
    try { fs.mkdirSync(logDir, { recursive: true }); } catch {}

    const rotateLogs = () => {
        try {
            if (fs.existsSync(GLOBAL_LOG) && fs.statSync(GLOBAL_LOG).size >= MAX_LOG_BYTES) {
                fs.renameSync(GLOBAL_LOG, GLOBAL_LOG + '.1');
            }
        } catch {}
    };

    const writeLog = (level, args) => {
        rotateLogs();
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const line = `[${ts}] [${level}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}
`;
        try { fs.appendFileSync(GLOBAL_LOG, line); } catch {}
    };

    const origLog   = console.log.bind(console);
    const origError = console.error.bind(console);
    const origWarn  = console.warn.bind(console);

    console.log   = (...args) => { origLog(...args);   writeLog('INFO',  args); };
    console.error = (...args) => { origError(...args); writeLog('ERROR', args); };
    console.warn  = (...args) => { origWarn(...args);  writeLog('WARN',  args); };

    console.log(`[ClusterManager] Debug logging enabled → ${GLOBAL_LOG}`);
};

initDebugLogging();

// ── Tool and projects paths ───────────────────────────────────
const TOOL_DIR       = path.dirname(__dirname);
const TOOL_CONTRACT  = path.join(TOOL_DIR, 'contract', 'dist');
const PROJECTS_DIR   = path.join(os.homedir(), '.evernode-clusters', 'projects');
const GLOBAL_ENV     = path.join(os.homedir(), '.evernode-clusters', '.env');
const MOMENT_BASE_IDX = 1702531862; // Evernode epoch (unix seconds) — verified 6 May 2026
const MOMENT_SIZE     = 3600;       // Seconds per moment (1 hour)

const momentToTimestamp = (moment) => MOMENT_BASE_IDX + (moment * MOMENT_SIZE);
const momentToDate = (moment) => new Date(momentToTimestamp(moment) * 1000).toUTCString();
const getExpiryTimestamp = (node) => {
    if (node.expiryMoment) return momentToTimestamp(node.expiryMoment);
    const createdSec = node.createdTimestamp > 9999999999
        ? Math.floor(node.createdTimestamp / 1000)
        : node.createdTimestamp;
    return createdSec + (node.lifeMoments * MOMENT_SIZE);
};



const getEvernodeTenant = async () => {
    const xahauWs = process.env.XAHAU_WS || process.env.EV_XAHAUD_SERVER || 'wss://xahau.network';
    const evernode = (() => { try { return require('evernode-js-client'); } catch { return require('/usr/lib/node_modules/evdevkit/node_modules/evernode-js-client'); } })();
    await evernode.Defaults.useNetwork('mainnet');
    const xrplApi = new evernode.XrplApi(xahauWs);
    evernode.Defaults.set({ xrplApi });
    await xrplApi.connect();
    const tenant = new evernode.TenantClient(process.env.EV_TENANT_ADDRESS, process.env.EV_TENANT_SECRET);
    await tenant.connect();
    return { evernode, xrplApi, tenant };
};

// ── Ensure ncc bundle is in node_modules ─────────────────────
const ensureNccBundle = (targetNodeModules) => {
    const src = path.join(TOOL_DIR, 'contract', 'dist', 'node_modules', 'evernode-client-cluster-manager');
    const dst = path.join(targetNodeModules, 'evernode-client-cluster-manager');
    execSync(`rm -rf "${dst}" && cp -r "${src}" "${dst}"`);
};

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
const hr = (n=52) => '─'.repeat(n);
const sudo = process.platform !== 'win32' ? 'sudo -E ' : '';
const isYes = (s) => s === 'yes' || s === 'y';
const askYesNo = async (q) => {
    while (true) {
        const s = (await ask(q)).trim().toLowerCase();
        if (s === 'yes' || s === 'y' || s === '') return s;
        console.log('  Please enter yes/y or press Enter to skip.');
    }
};

// ── Global env ────────────────────────────────────────────────

const loadGlobalEnv = () => {
    if (fs.existsSync(GLOBAL_ENV)) {
        require('dotenv').config({ path: GLOBAL_ENV });
    }
};

const saveGlobalEnv = (data) => {
    const lines = [
        '# Evernode Cluster Manager — Global Credentials',
        '# Shared across all projects. Created: ' + new Date().toUTCString(),
        '',
        `EV_TENANT_SECRET=${data.tenantSecret}`,
        `EV_TENANT_ADDRESS=${data.tenantAddress}`,
        `EV_USER_PRIVATE_KEY=${data.userPrivKey}`,
        `EV_USER_PUBLIC_KEY=${data.userPubKey}`,
        '',
        '# Host Discovery API — change if you run your own instance',
        'HOST_API_URL=https://api.onledger.net',
    ].join('\n') + '\n';
    fs.writeFileSync(GLOBAL_ENV, lines, { mode: 0o600 });
};

const hasGlobalEnv = () => {
    if (!fs.existsSync(GLOBAL_ENV)) return false;
    const env = fs.readFileSync(GLOBAL_ENV, 'utf8');
    return env.includes('EV_TENANT_SECRET=') && env.includes('EV_USER_PRIVATE_KEY=');
};

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
    // Load global env first, then project env overrides
    loadGlobalEnv();
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
// Only reconcile cluster-nodes.json when cluster is fully synced and UNL is stable.
// Never strip records during a crisis — only remove nodes that have cleanly left the UNL
// and where the remaining UNL count is >= 3 (minimum viable cluster).
const reconcileNodes = (nodes, currentUnl, voteStatus) => {
    if (voteStatus !== 'synced') return nodes; // never strip during unstable state
    if (currentUnl.length < 3) return nodes;   // never strip below minimum
    return nodes.filter(n => currentUnl.includes(n.pubkey));
};

const timeRemaining = (node) => {
    const expirySec = getExpiryTimestamp(node);
    const nowSec    = Math.floor(Date.now() / 1000);
    const remaining = expirySec - nowSec;
    if (remaining <= 0) return { expired: true, text: 'EXPIRED', expirySec };
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    const s = remaining % 60;
    return { expired: false, text: `${h}h ${m}m ${s}s`, expirySec, remaining };
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

const submitInput = async (targetIp, targetPort, msg) => {
    const HP = require('hotpocket-js-client');
    const keyPair = await getKeyPair();
    const client = await HP.createClient([`wss://${targetIp}:${targetPort}`], keyPair, { protocol: HP.protocols.json });
    const connected = await client.connect();
    if (!connected) throw new Error('Connection failed');
    const submission = await client.submitContractInput(JSON.stringify(msg));
    const inputStatus = await submission.submissionStatus;
    await client.close().catch(() => {});
    if (inputStatus.status !== 'accepted') throw new Error(`Input rejected: ${inputStatus.reason}`);
    return true;
};

const pollUntil = async (check, timeoutMs, intervalMs = 3000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try { const result = await check(); if (result !== null) return result; } catch {}
        await sleep(intervalMs);
    }
    throw new Error('Timed out waiting for confirmation');
};

// Get contract version — non-blocking, times out cleanly
const getContractVersion = async (targetIp, targetPort) => {
    const HP = require('hotpocket-js-client');
    try {
        const keyPair = await HP.generateKeys();
        const client = await HP.createClient([`wss://${targetIp}:${targetPort}`], keyPair, { protocol: HP.protocols.json });
        const connected = await client.connect();
        if (!connected) return 'unknown';
        const raw = await client.submitContractReadRequest(JSON.stringify({ type: 'status' }));
        await client.close().catch(() => {});
        if (!raw) return 'unknown';
        const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return p.version || 'unknown';
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

// ── Fast host finder via local API ───────────────────────────
const fetchFromAPI = (url) => new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    mod.get(url, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
});

const getOperator = (domain) => {
    if (!domain) return 'unknown';
    const stripped = domain.replace(/^[a-z0-9]+-?\d*\./, '');
    const parts = stripped.split('.');
    const base = parts[0].replace(/\d+(-\d+)?$/, '').replace(/-$/, '');
    return base || parts.slice(-2).join('.');
};

const dedupeByOperator = (hosts, domainCount = {}, max = 3) => hosts.filter(h => {
    const op = getOperator(h.domain || '');
    domainCount[op] = (domainCount[op] || 0) + 1;
    return domainCount[op] <= max;
});

const findHostsViaAPI = async (apiUrl, minSlots, targetCount, minRep, includeUnscored, allowReport = false) => {
    const base = apiUrl.replace(/\/$/, '') + '/hosts?active=true' +
        '&minRep=' + (minRep || 200) +
        (includeUnscored ? '&includeUnscored=true' : '') +
        '&minXah=1&minEvr=0.01' +
        '&minLastHeartbeat=180' +
        '&sortBy=hostReputation&sortDir=desc';

    // Fetch single-slot and general hosts in parallel
    const [singleData, allData] = await Promise.all([
        fetchFromAPI(base + '&minSlots=1&maxSlots=1&limit=50'),
        fetchFromAPI(base + '&minSlots=' + minSlots + '&limit=' + (targetCount * 10))
    ]);

    if (!allData.success) throw new Error(allData.error || 'API error');

    // Dedupe single-slot hosts first (up to 10)
    const domainCount = {};
    const singleHosts = dedupeByOperator(singleData.success ? singleData.hosts : [], domainCount).slice(0, 10);
    const singleSet = new Set(singleHosts.map(h => h.address));

    // Fill remainder from general pool skipping already included
    const otherHosts = dedupeByOperator(
        allData.hosts.filter(h => !singleSet.has(h.address)),
        domainCount
    ).slice(0, targetCount - singleHosts.length);

    const hosts = [...singleHosts, ...otherHosts];

    const ageMs = hosts.length > 0 ? Date.now() - hosts[0].lastUpdated : 0;
    const ageMin = Math.round(ageMs / 60000);
    const ageTxt = ageMin < 1 ? 'just now' : ageMin + ' min ago';
    console.log('\n  API returned ' + hosts.length + ' hosts (' + singleHosts.length + ' single-slot) | cache updated: ' + ageTxt);

    const fmtEVR = (drops) => {
        if (!drops) return 'free?';
        const e = drops / 1000000;
        if (e < 0.001) return drops + 'drops';
        if (e < 1) return e.toFixed(4) + ' EVR';
        return e.toFixed(2) + ' EVR';
    };
    const fmtRep = (r) => r === null || r === undefined ? '?' : String(r);

    console.log('  ' + hr(131));
    console.log('  ' + '#'.padEnd(4) + 'Address'.padEnd(36) + 'Domain'.padEnd(25) + 'CC'.padEnd(5) + 'Avail'.padEnd(7) + 'Total'.padEnd(7) + 'Rep'.padEnd(6) + 'RAM'.padEnd(8) + 'Lease/hr'.padEnd(12) + 'Version');
    console.log('  ' + hr(131));
    hosts.forEach((h, i) => console.log(
        '  ' + String(i + 1).padEnd(4) +
        (h.address || '').padEnd(36) +
        (h.domain || '').slice(0, 23).padEnd(25) +
        (h.countryCode || '??').padEnd(5) +
        String(h.availableInstances || 0).padEnd(7) +
        String(h.maxInstances || 0).padEnd(7) +
        fmtRep(h.hostReputation).padEnd(6) +
        (h.ramMb ? Math.round(h.ramMb / 1024) + 'GB' : '?').padEnd(8) +
        fmtEVR(h.leaseDrops).padEnd(12) +
        (h.version || '?')
    ));
    console.log('  ' + hr(131));
    console.log('\n  ' + hosts.length + ' host(s) — ' + singleHosts.length + ' single-slot (recommended for deployment).');
    if (allowReport) console.log('  To report a bad host enter its full Xahau address.');
    console.log('');

    return hosts;
};


// ── Host Finder ───────────────────────────────────────────────
const findHosts = async (minSlots = 1, targetCount = 20, minRep = 200, includeUnscored = false, allowReport = false) => {
    const apiUrl = process.env.HOST_API_URL || 'https://api.onledger.net';
    try {
        console.log('\n  Using host API: ' + apiUrl);
        return await findHostsViaAPI(apiUrl, minSlots, targetCount, minRep, includeUnscored, allowReport);
    } catch(e) {
        console.log('  ⚠  API unavailable (' + e.message + ')');
        return [];
    }
};

// ── Resolve host input — address or list number ───────────────
// hosts = array returned by findHosts (may be empty if user skipped find step)
const resolveHostInput = (raw, hosts) => {
    if (/^\d+$/.test(raw)) {
        const idx = parseInt(raw) - 1;
        if (!hosts.length) return { error: 'No host list available — enter a full address.' };
        if (idx < 0 || idx >= hosts.length) return { error: `Invalid number — enter 1–${hosts.length} or a full address.` };
        return { address: hosts[idx].address, domain: hosts[idx].domain };
    }
    return { address: raw };
};

// ── Global credentials setup ──────────────────────────────────

const setupGlobalCredentials = async () => {
    console.log('\n── Global Credentials Setup ─────────────────────────');
    console.log('  These credentials are shared across all projects.');
    console.log('  You only need to enter them once.\n');

    // Keys
    console.log('── Key Generation ────────────────────────────────────');
    const hasKeys = (await askYesNo('  Have existing HotPocket user keys? (yes/y or Enter to generate): '));
    let userPrivKey='', userPubKey='';
    if (isYes(hasKeys)) {
        userPrivKey = (await ask('  EV_USER_PRIVATE_KEY: ')).trim();
        userPubKey  = (await ask('  EV_USER_PUBLIC_KEY : ')).trim();
    } else {
        console.log('  Generating new key pair...');
        try {
            const out = execSync('evdevkit keygen', { encoding: 'utf8', stderr: 'pipe' });
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

    // Xahau credentials
    console.log('\n── Xahau Tenant Credentials ───────────────────────────');
    const tenantSecret  = (await ask('  EV_TENANT_SECRET : ')).trim();
    const tenantAddress = (await ask('  EV_TENANT_ADDRESS: ')).trim();

    saveGlobalEnv({ tenantSecret, tenantAddress, userPrivKey, userPubKey });
    loadGlobalEnv();
    console.log(`\n  ✓ Global credentials saved to ${GLOBAL_ENV}`);
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
    console.log('  2. Use my own contract directory');
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
        } else {
            console.log('  Invalid choice — enter 1 or 2.');
        }
    }

    // Write project .env (no credentials — those are in global .env)
    fs.writeFileSync(ENV_FILE, `# Evernode Cluster Manager — Project: ${projectName}
# Created: ${new Date().toUTCString()}
# Note: Credentials are stored in ~/.evernode-clusters/.env

DEFAULT_NODE_COUNT=${defaultNodes}
DEFAULT_MOMENTS=${defaultMoments}
HP_ROUNDTIME=${roundtime}
HP_THRESHOLD=${threshold}
HP_LOG_LEVEL=${logLevel}
HP_PEER_DISCOVERY=${peerDiscovery}
CONTRACT_VERSION=${contractVersion}
ALERT_HOURS=6
ALERT_MIN_MOMENTS=12
`, { mode: 0o600 });

    // Write hp-init.cfg
    fs.writeFileSync(INITCFG, JSON.stringify({
        contract: { consensus: { roundtime: parseInt(roundtime), threshold: parseInt(threshold) } },
        mesh: { peer_discovery: { enabled: peerDiscovery==='true' } },
        log: { log_level: logLevel }
    }, null, 2));

    // Write hp.cfg.override
    const overrideCfg = { contract: { bin_path:'/usr/bin/node', bin_args:'index.js', read_request_exec: true, consensus:{ roundtime:parseInt(roundtime), threshold:parseInt(threshold) } } };
    fs.writeFileSync(path.join(projectDir, 'hp.cfg.override'), JSON.stringify(overrideCfg, null, 2));

    // Copy contract files (skip node_modules and directories)
    for (const f of fs.readdirSync(contractSrcDir)) {
        if (f === 'node_modules' || f === '.git') continue;
        const src = path.join(contractSrcDir, f);
        const dst = path.join(CONTRACT_DIR, f);
        if (fs.statSync(src).isDirectory()) continue;
        fs.copyFileSync(src, dst);
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
        // Rewrite file: paths to absolute so they resolve correctly from the project dir
        const pkgPath = path.join(CONTRACT_DIR, 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        let changed = false;
        for (const [dep, ver] of Object.entries(pkg.dependencies || {})) {
            if (ver.startsWith('file:')) {
                const rel = ver.slice(5);
                const abs = path.resolve(TOOL_CONTRACT, rel);
                pkg.dependencies[dep] = `file:${abs}`;
                changed = true;
            }
        }
        if (changed) fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
        console.log('\n  Installing contract dependencies...');
        execSync(`npm install --prefix ${CONTRACT_DIR} --silent`, { env: { ...process.env, BLAKE3_FORCE_WASM: '1' } });
        ensureNccBundle(`${CONTRACT_DIR}/node_modules`);
        console.log('  ✓ Done');
    }

    loadProjectEnv();

    console.log('\n  ✓ Project created successfully.');
    console.log(`  Location: ${projectDir}\n`);
    return projectName;
};


// ── Verify host availability (live check) ─────────────────────
const verifyHosts = async (hostAddrs, requiredSlots = 1) => {
    const xahauWs = process.env.XAHAU_WS || process.env.EV_XAHAUD_SERVER || 'wss://xahau.network';
    console.log('\n  Verifying host availability via ' + xahauWs + '...');
    try {
        const evernode = (() => { try { return require('evernode-js-client'); } catch { return require('/usr/lib/node_modules/evdevkit/node_modules/evernode-js-client'); } })();
        await evernode.Defaults.useNetwork('mainnet');
        const xrplApi = new evernode.XrplApi(xahauWs);
        evernode.Defaults.set({ xrplApi, useCentralizedRegistry: true });
        await xrplApi.connect();
        const reg = await evernode.HookClientFactory.create(evernode.HookTypes.registry);
        await reg.connect();

        const results = await Promise.all(hostAddrs.map(async (addr) => {
            try {
                const info = await reg.getHostInfo(addr);
                const available = info ? (info.maxInstances - info.activeInstances) : 0;
                const ok = info?.active && available >= requiredSlots;
                return { addr, ok, available, active: info?.active || false };
            } catch {
                return { addr, ok: false, available: 0, active: false };
            }
        }));

        await reg.disconnect();
        await xrplApi.disconnect();

        let allOk = true;
        for (const r of results) {
            if (r.ok) {
                console.log('  ✓ ' + r.addr + ' — ' + r.available + ' slot(s) available');
            } else {
                console.log('  ✗ ' + r.addr + ' — ' + (r.active ? r.available + ' slots available (insufficient)' : 'inactive or not found'));
                allOk = false;
            }
        }
        return { allOk, results };
    } catch(e) {
        console.error('  ⚠  Could not verify hosts: ' + e.message);
        return { allOk: null, results: [] }; // null = verification failed, proceed with caution
    }
};

// ── Deploy ────────────────────────────────────────────────────


// ── Host Selection with live slot verification ────────────────
// hosts = array from findHosts — allows entering a list number instead of full address.
// Pass [] if user skipped the find step (number input will be rejected gracefully).

const selectHosts = async (nodeCount, hosts = []) => {
    const hint = hosts.length
        ? `Enter address or list number (1–${hosts.length})`
        : 'Enter host address';
    console.log(`\n  ${hint}.\n`);

    const hostResults = [];

    for (let i = 1; i <= nodeCount; i++) {
        while (true) {
            const raw = (await ask(`  Host ${i}: `)).trim();
            if (!raw) continue;

            const resolved = resolveHostInput(raw, hosts);
            if (resolved.error) { console.log('  ✗ ' + resolved.error); continue; }

            const addr = resolved.address;
            if (resolved.domain) console.log(`  → ${addr} (${resolved.domain})`);

            const { results } = await verifyHosts([addr], 1);
            const result = results[0];

            if (!result || !result.active) {
                console.log('  ✗ Host not found or inactive. Try another.');
                continue;
            }

            hostResults.push({ addr, available: result.available });
            break;
        }
    }

    // Ensure first host has exactly 1 slot
    while (hostResults[0].available > 1) {
        console.log('\n  ⚠  No single-slot host available — risk of double allocation on same host.');
        console.log('  Current order:');
        hostResults.forEach((h, i) => console.log(`    ${i+1}. ${h.addr} — ${h.available} slot(s)`));
        console.log('\n  Please replace one host with a single-slot host.');
        const idxStr = (await ask(`  Replace host number (1-${nodeCount}) or Enter to proceed anyway: `)).trim();
        if (!idxStr) {
            console.log('  ⚠  Proceeding without a single-slot host — double allocation risk remains.');
            break;
        }
        const idx = parseInt(idxStr) - 1;
        if (isNaN(idx) || idx < 0 || idx >= nodeCount) { console.log('  Invalid number.'); continue; }
        const rawNew = (await ask('  New host (address or list number): ')).trim();
        if (!rawNew) { console.log('  Cancelled.'); return null; }
        const resolved = resolveHostInput(rawNew, hosts);
        if (resolved.error) { console.log('  ✗ ' + resolved.error); continue; }
        const newAddr = resolved.address;
        if (resolved.domain) console.log(`  → ${newAddr} (${resolved.domain})`);
        const { results } = await verifyHosts([newAddr], 1);
        const result = results[0];
        if (!result || !result.active) { console.log('  ✗ Host not found or inactive. Try again.'); continue; }
        console.log(`  ✓ ${newAddr} — ${result.available} slot(s) available`);
        hostResults[idx] = { addr: newAddr, available: result.available };
    }

    console.log('\n  ✓ Final host order:');
    hostResults.forEach((h, i) => console.log(`    ${i+1}. ${h.addr} — ${h.available} slot(s)`));

    return hostResults.map(h => h.addr);
};

const opDeploy = async () => {
    console.log('\n── Deploy New Cluster ───────────────────────────────');

    // ── CHANGE: capture foundHosts so selectHosts can resolve numbers ──
    let foundHosts = [];
    const findFirst = (await askYesNo('  Find available hosts first? (yes/y or Enter to skip): '));
    if (isYes(findFirst)) {
        const minSlots = parseInt((await ask('  Minimum available slots (default 1): ')).trim()||'1');
        foundHosts = await findHosts(minSlots, 20) || [];
        await ask('  Press Enter to continue...');
    }

    let nodeCount;
    while (true) {
        const input = (await ask(`\n  How many nodes? (default ${process.env.DEFAULT_NODE_COUNT||3}, minimum 3): `)).trim();
        nodeCount = parseInt(input||process.env.DEFAULT_NODE_COUNT||'3');
        if (nodeCount>=3) break;
        console.log('  Must be >= 3.');
    }

    // ── CHANGE: pass foundHosts through ──
    const hostAddrs = await selectHosts(nodeCount, foundHosts);
    if (!hostAddrs) { console.log('  Cancelled.'); return false; }

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
    const confirm=(await askYesNo('  Proceed? (yes/y or Enter to cancel): '));
    if (confirm!=='yes'&&confirm!=='y') { console.log('  Cancelled.'); return false; }

    // Verify hosts are still available before committing
    const { allOk, results } = await verifyHosts(hostAddrs, 1);
    if (allOk === false) {
        const unavailable = results.filter(r => !r.ok).map(r => r.addr);
        console.log('\n  ✗ ' + unavailable.length + ' host(s) no longer available:');
        unavailable.forEach(a => console.log('    ' + a));
        console.log('');
        for (const bad of unavailable) {
            const idx = hostAddrs.indexOf(bad);
            console.log('  Host ' + (idx+1) + ' (' + bad + ') is unavailable.');
            const replace = (await ask('  Enter replacement host address (or Enter to cancel): ')).trim();
            if (!replace) { console.log('  Cancelled.'); return false; }
            hostAddrs[idx] = replace;
        }
        // Re-verify after replacements
        console.log('');
        const recheck = await verifyHosts(hostAddrs, 1);
        if (recheck.allOk === false) {
            const proceed = (await askYesNo('  Some replacement hosts are still unavailable. Proceed anyway? (yes/y or Enter to cancel): '));
            if (proceed !== 'yes' && proceed !== 'y') { console.log('  Cancelled.'); return false; }
        }
    } else if (allOk === null) {
        const proceed = (await askYesNo('  Could not verify hosts. Proceed anyway? (yes/y or Enter to cancel): '));
        if (proceed !== 'yes' && proceed !== 'y') { console.log('  Cancelled.'); return false; }
    }

    console.log('');
    console.log('[1/3] Installing contract dependencies...');
    const pkgJson = path.join(CONTRACT_DIR, 'package.json');
    const hasDeps = fs.existsSync(pkgJson) && Object.keys(JSON.parse(fs.readFileSync(pkgJson,'utf8')).dependencies || {}).length > 0;
    if (hasDeps) {
        execSync(`npm install --prefix ${CONTRACT_DIR} --silent`, { env: { ...process.env, BLAKE3_FORCE_WASM: '1' } });
        ensureNccBundle(`${CONTRACT_DIR}/node_modules`);
    }
    console.log('      ✓ Done.');

    console.log('[2/3] Writing authorized_pubkey.txt...');
    fs.writeFileSync(path.join(CONTRACT_DIR,'authorized_pubkey.txt'), process.env.EV_USER_PUBLIC_KEY+'\n');
    console.log(`      ✓ ${process.env.EV_USER_PUBLIC_KEY}`);

    const hostsFile=require('path').join(require('os').tmpdir(),'ecm-deploy-hosts.txt');
    fs.writeFileSync(hostsFile, hostAddrs.join('\n'));

    console.log('[3/3] Running evdevkit cluster-create...\n');
    let clusterOutput = '';
    try {
        process.env.EV_HP_INIT_CFG_PATH = INITCFG;
        delete process.env.EV_HP_OVERRIDE_CFG_PATH;
        clusterOutput = execSync(
            `${sudo}evdevkit cluster-create ${nodeCount} "${CONTRACT_DIR}" /usr/bin/node "${hostsFile}" -m ${moments} -a index.js`,
            { encoding:'utf8', env: process.env }
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
        console.log('  ⚠  Could not auto-parse output. Please enter details manually.');
        contractId = (await ask('  Contract ID: ')).trim();
        ip         = (await ask('  Node IP/domain: ')).trim();
        port       = (await ask('  Node user port: ')).trim();
    } else {
        contractId = nodes[0].contract_id;
        // Try each node until one connects
        let connected = false;
        for (const node of nodes) {
            try {
                const stat = await getStatus(node.domain, String(node.user_port));
                if (stat) { ip = node.domain; port = String(node.user_port); connected = true; break; }
            } catch {}
        }
        if (!connected) { ip = nodes[0].domain; port = String(nodes[0].user_port); }

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

        // Check for duplicate hosts — indicates cluster-create chunk algorithm bug
        const hostCounts = {};
        nodeRecords.forEach(n => { hostCounts[n.host] = (hostCounts[n.host] || 0) + 1; });
        const duplicateHosts = Object.entries(hostCounts).filter(([h, c]) => c > 1);
        if (duplicateHosts.length > 0) {
            console.log('\n  ⚠  WARNING: Multiple nodes deployed to the same host:');
            duplicateHosts.forEach(([h, c]) => console.log(`    ${h} — ${c} nodes`));
            console.log('  This will cause 0-peer consensus issues.');
            console.log('  Recommendation: delete this project and redeploy with different hosts.\n');
        }

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


// ── Cluster health check (parallel across all nodes) ─────────

const checkClusterHealth = async (nodes) => {
    if (!nodes || nodes.length === 0) return null;

    const results = await Promise.all(nodes.map(async (node) => {
        try {
            const HP = require('hotpocket-js-client');
            const keyPair = await HP.generateKeys();
            const client = await HP.createClient(
                [`wss://${node.domain}:${node.userPort}`],
                keyPair,
                { protocol: HP.protocols.json }
            );
            const result = await Promise.race([
                (async () => {
                    const connected = await client.connect();
                    if (!connected) return { node, error: 'connection failed' };
                    const [lcl, stat] = await Promise.all([client.getLcl(), client.getStatus()]);
                    await client.close().catch(() => {});
                    return { node, lcl, weaklyConnected: stat.weaklyConnected };
                })(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
            ]);
            return result;
        } catch(e) {
            return { node, error: e.message };
        }
    }));

    const reachable = results.filter(r => !r.error);
    const unreachable = results.filter(r => r.error);
    // Only flag hash mismatch if nodes at the same LCL sequence disagree.
    // Nodes that are 1 ledger behind will naturally have a different hash — that is not a fork.
    const allHashesMatch = reachable.length > 0 && (() => {
        const bySeq = {};
        for (const r of reachable) {
            const seq = r.lcl.ledgerSeqNo;
            if (!bySeq[seq]) bySeq[seq] = [];
            bySeq[seq].push(r.lcl.ledgerHash);
        }
        return Object.values(bySeq).every(group => group.every(h => h === group[0]));
    })();
    const anyWeaklyConnected = reachable.some(r => r.weaklyConnected);
    const safeToRemove = allHashesMatch && !anyWeaklyConnected && unreachable.length === 0;

    return { results, reachable, unreachable, allHashesMatch, anyWeaklyConnected, safeToRemove };
};

const opStatus = async () => {
    console.log('\n  Fetching cluster status...');
    try {
        const stat = await getStatus(ip, port);
        let nodes = loadNodes();
        const reconciled = reconcileNodes(nodes, stat.currentUnl, stat.voteStatus);
        if (reconciled.length !== nodes.length && stat.voteStatus === 'synced' && stat.currentUnl.length >= 3) {
            saveNodes(reconciled);
            nodes = reconciled;
        }

        const contractVersion = await getContractVersion(ip, port);

        console.log('\n── Cluster Status ───────────────────────────────────');
        console.log(`  Project          : ${path.basename(PROJECT_DIR)}`);
        console.log(`  Contract ID      : ${contractId}`);
        console.log(`  Contract Version : ${contractVersion}`);
        console.log(`  HP Version       : ${stat.hpVersion}`);
        console.log(`  Vote Status      : ${stat.voteStatus}${stat.weaklyConnected ? '  ⚠  WEAKLY CONNECTED' : ''}`);
        console.log(`  LCL              : ${stat.ledgerSeqNo}`);
        console.log(`  Round Time       : ${stat.roundTime}ms`);
        console.log(`  UNL Count        : ${stat.currentUnl.length}`);
        console.log('  UNL Nodes        :');
        stat.currentUnl.forEach((pk,i)=>{ const n=nodes.find(n=>n.pubkey===pk); console.log(`    [${i}] ${pk.slice(0,20)}… ${n?n.domain:'(unknown)'} ${n?`(${timeRemaining(n).text})`:''}`); });
        console.log('  Peers            :');
        stat.peers.forEach(p=>console.log(`    ${p}`));
        // Offer to replace unreachable nodes
        if (stat.weaklyConnected) {
            const peerDomains = stat.peers.map(p => p.split(':')[0]);
            const unreachable = stat.currentUnl.slice(1).filter(pk => {
                const n = nodes.find(n => n.pubkey === pk);
                const domain = n ? n.domain : '';
                return !peerDomains.some(p => domain.includes(p) || p.includes(domain));
            });
            if (unreachable.length > 0) {
                console.log('\n  ⚠  Unreachable node(s) detected:');
                unreachable.forEach(pk => {
                    const n = nodes.find(n => n.pubkey === pk);
                    console.log(`    ${pk.slice(0,20)}… ${n ? n.domain : 'unknown'}`);
                });
                const replace = (await askYesNo('\n  Replace unreachable node(s) now? (yes/y or Enter to skip): '));
                if (replace === 'yes' || replace === 'y') {
                    for (const deadPubkey of unreachable) {
                        const deadNode = nodes.find(n => n.pubkey === deadPubkey);
                        console.log(`\n  Replacing ${deadPubkey.slice(0,20)}… (${deadNode ? deadNode.domain : 'unknown'})...`);
                        // Step 1 — Add new node
                        await opAddNode();
                        // Step 2 — Wait 2 extra roundtimes for stability
                        const roundtime = parseInt(process.env.HP_ROUNDTIME || 5000);
                        console.log(`\n  Waiting ${(roundtime * 2 / 1000).toFixed(1)}s for new node to stabilise...`);
                        await sleep(roundtime * 2);
                        // Step 3 — Check if dead node already left UNL
                        const currentStat = await getStatus(ip, port);
                        if (!currentStat.currentUnl.includes(deadPubkey)) {
                            console.log(`  ✓ Dead node already left the UNL — no removal needed.`);
                            saveNodes(loadNodes().filter(n => n.pubkey !== deadPubkey));
                        } else {
                            const doRemove = (await askYesNo(`  Remove dead node ${deadPubkey.slice(0,20)}… now? (yes/y or Enter to skip): `));
                            if (doRemove === 'yes' || doRemove === 'y') {
                                console.log(`  Removing unreachable node ${deadPubkey.slice(0,20)}…`);
                                try {
                                    const nodeInfo = nodes.find(n => n.pubkey === deadPubkey);
                                    await submitInput(ip, port, { type: 'removeNode', pubkey: deadPubkey, ip: nodeInfo?.domain, peerPort: nodeInfo?.peerPort });
                                    saveNodes(loadNodes().filter(n => n.pubkey !== deadPubkey));
                                    const expectedUnl = stat.currentUnl.length;
                                    await pollUntil(async () => {
                                        const s = await getStatus(ip, port);
                                        process.stdout.write(`  UNL: ${s.currentUnl.length}/${expectedUnl} | voteStatus: ${s.voteStatus}          \r`);
                                        return s.currentUnl.length >= expectedUnl && s.voteStatus === 'synced' ? s : null;
                                    }, roundtime * 20);
                                    console.log(`\n  ✓ Cluster repaired. UNL=${expectedUnl}`);
                                } catch(e) { console.error(`  ✗ Failed to remove dead node: ${e.message}`); }
                            } else {
                                console.log('  Skipped — remove manually via option 4.');
                            }
                        }
                    }
                }
            }
        }
        // Parallel health check across all nodes
        console.log('\n── Node Health ───────────────────────────────────────');
        const health = await checkClusterHealth(nodes);
        if (health) {
            health.results.forEach(r => {
                const pubkey = r.node.pubkey ? r.node.pubkey.slice(0,20) + '…' : 'unknown';
                if (r.error) {
                    console.log(`  ✗ ${(r.node.domain||'').slice(0,25).padEnd(26)} ${pubkey}  UNREACHABLE — ${r.error}`);
                } else {
                    const lclOk = health.allHashesMatch ? '' : ' ✗ HASH MISMATCH';
                    const wcWarn = r.weaklyConnected ? '  ⚠ WEAKLY CONNECTED' : '';
                    console.log(`  ${r.weaklyConnected ? '⚠' : '✓'} ${(r.node.domain||'').slice(0,25).padEnd(26)} ${pubkey}  LCL:${r.lcl.ledgerSeqNo}${lclOk}${wcWarn}`);
                }
            });
            console.log(`  All hashes match : ${health.allHashesMatch ? '✓' : '✗ MISMATCH — possible fork'}`);
            console.log(`  Safe to remove   : ${health.safeToRemove ? '✓' : '✗'}`);
        }
        console.log('─────────────────────────────────────────────────────\n');
        return stat;
    } catch(e) { console.error(`  ✗ ${e.message}`); }
};

const opUpdateContract = async () => {
    console.log('\n── Update Contract ──────────────────────────────────');
    let stat;
    try {
        stat = await getStatus(ip, port);
        if (stat.voteStatus !== 'synced') { console.error('  ✗ Cluster not synced. Aborting.'); return; }
        console.log(`  ✓ Synced. UNL=${stat.currentUnl.length}`);
    } catch(e) { console.error(`  ✗ ${e.message}`); return; }

    const currentVersion = await getContractVersion(ip, port);
    console.log(`  Current version  : ${currentVersion}`);
    const newVersion = (await ask('  New version string (e.g. v1.0.1): ')).trim();
    if (!newVersion) { console.log('  Cancelled.'); return; }

    const srcIndex = path.join(TOOL_DIR, 'contract', 'src', 'index.js');
    if (fs.existsSync(srcIndex)) {
        let src = fs.readFileSync(srcIndex, 'utf8');
        src = src.replace(/const VERSION\s*=\s*'[^']+'/,  `const VERSION   = '${newVersion}'`);
        fs.writeFileSync(srcIndex, src);
        execSync('npm run build', { encoding: 'utf8', cwd: path.join(TOOL_DIR, 'contract') });
        console.log(`  ✓ Rebuilt contract at ${newVersion}`);
    }

    const builtIndex = path.join(TOOL_CONTRACT, 'index.js');
    fs.copyFileSync(builtIndex, path.join(CONTRACT_DIR, 'index.js'));
    // Copy node_modules from dist to CONTRACT_DIR
    const distNodeModules = path.join(TOOL_CONTRACT, 'node_modules');
    if (fs.existsSync(distNodeModules)) {
        execSync(`cp -r "${distNodeModules}" "${CONTRACT_DIR}/"`, { encoding: 'utf8' });
        ensureNccBundle(`${CONTRACT_DIR}/node_modules`);
        console.log('  ✓ Copied node_modules to project.');
    }
    console.log('  ✓ Copied built contract to project.');

    const firstNode = stat.currentUnl[0];
    execSync(
        `${sudo}evdevkit bundle "${CONTRACT_DIR}" ${firstNode} /usr/bin/node -a index.js`,
        { encoding: 'utf8', cwd: PROJECT_DIR, env: process.env }
    );
    const bundlePath = path.join(PROJECT_DIR, 'bundle', 'bundle.zip');
    console.log(`  ✓ Bundle created. ${(fs.statSync(bundlePath).size/1024).toFixed(1)} KB`);

    const bundle = fs.readFileSync(bundlePath).toString('base64');
    console.log('  Sending upgrade...');
    try {
        await submitInput(ip, port, { type: 'upgrade', bundle });
        console.log('  ✓ Accepted. Waiting for version to update...');
        const roundtime = parseInt(process.env.HP_ROUNDTIME || 6000);
        await pollUntil(async () => {
            const v = await getContractVersion(ip, port);
            process.stdout.write(`  Checking version: ${v}          \r`);
            return v === newVersion ? v : null;
        }, roundtime * 20);
        console.log(`\n  ✓ Contract updated to ${newVersion}`);
    } catch(e) { console.error(`\n  ✗ Upgrade failed: ${e.message}`); return; }
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

    // ── CHANGE: capture foundHosts for number-based selection ──
    let foundHosts = [];
    const findFirst=(await askYesNo('\n  Find available hosts first? (yes/y or Enter to skip): '));
    if (isYes(findFirst)) {
        foundHosts = await findHosts(1, 20) || [];
        await ask('  Press Enter to continue...');
    }

    console.log('\n  ── STEP 1: Acquire ───────────────────────────────');
    const hint = foundHosts.length ? `address or list number (1–${foundHosts.length})` : 'address';
    let extHost = '';
    while (!extHost) {
        const raw = (await ask(`  External host (${hint}): `)).trim();
        if (!raw) continue;
        const resolved = resolveHostInput(raw, foundHosts);
        if (resolved.error) { console.log('  ✗ ' + resolved.error); continue; }
        extHost = resolved.address;
        if (resolved.domain) console.log(`  → ${extHost} (${resolved.domain})`);
    }

    const moments=(await ask(`  Life moments (default ${process.env.DEFAULT_MOMENTS||3}): `)).trim()||(process.env.DEFAULT_MOMENTS||'3');

    const { allOk: hostOk } = await verifyHosts([extHost], 1);
    if (hostOk === false) {
        const proceed = (await askYesNo('  Host has no available slots. Proceed anyway? (yes/y or Enter to cancel): '));
        if (proceed !== 'yes' && proceed !== 'y') { console.log('  Cancelled.'); return; }
    }

    // Write hp-init.cfg with peer and UNL info — no bundle/deploy needed
    const roundtime = parseInt(process.env.HP_ROUNDTIME||5000);
    const threshold = parseInt(process.env.HP_THRESHOLD||66);
    const logLevel = process.env.HP_LOG_LEVEL||'dbg';
    // Ask cluster which node is best for bootstrapping — cluster has ground truth
    // on peer connectivity. Falls back to stat.peers[0] if unavailable.
    let bootstrapPeer = null;
    try {
        const HP2 = require('hotpocket-js-client');
        const kp2 = await getKeyPair();
        const bpClient = await HP2.createClient([`wss://${ip}:${port}`], kp2, { protocol: HP2.protocols.json });
        const bpConnected = await bpClient.connect();
        if (bpConnected) {
            const raw = await bpClient.submitContractReadRequest(JSON.stringify({ type: 'getBootstrapPeer' }));
            await bpClient.close().catch(() => {});
            const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (p && p.domain && p.peerPort) {
                bootstrapPeer = `${p.domain}:${p.peerPort}`;
            }
        }
    } catch(e) {
        console.log(`  ⚠  Could not get bootstrap peer from cluster: ${e.message}`);
    }
    if (!bootstrapPeer) {
        bootstrapPeer = stat.peers.length > 0 ? stat.peers[0] : `${ip}:${parseInt(port)-1}`;
    }

    // Show available peers and allow user to override bootstrap selection
    const availablePeers = stat.peers.length > 0 ? stat.peers : [bootstrapPeer];
    console.log('\n  ── Bootstrap Peer Selection ─────────────────────────────');
    availablePeers.forEach((p, i) => {
        const marker = p === bootstrapPeer ? ' (recommended)' : '';
        console.log(`    ${i + 1}. ${p}${marker}`);
    });
    console.log('');
    const bpInput = (await ask(`  Select peer (1-${availablePeers.length}) or Enter to accept recommended: `)).trim();
    if (bpInput) {
        const bpIdx = parseInt(bpInput) - 1;
        if (!isNaN(bpIdx) && bpIdx >= 0 && bpIdx < availablePeers.length) {
            bootstrapPeer = availablePeers[bpIdx];
        } else {
            console.log('  Invalid selection — using recommended peer.');
        }
    }
    console.log(`  ✓ Bootstrap peer: ${bootstrapPeer}`);

    // initCfg goes into Xahau memo — 1 peer only to stay under 1KB limit.
    const initCfg = {
        contract: {
            bin_path: '/usr/bin/node',
            bin_args: 'index.js',
            consensus: { roundtime, threshold },
            unl: [stat.currentUnl[0]]
        },
        mesh: {
            peer_discovery: { enabled: process.env.HP_PEER_DISCOVERY==='true' },
            known_peers: [bootstrapPeer]
        },
        log: { log_level: logLevel }
    };
    const initCfgPath = path.join(PROJECT_DIR, 'node-init-temp.cfg');
    fs.writeFileSync(initCfgPath, JSON.stringify(initCfg, null, 2));
    console.log(`  ✓ Init config written (peer: ${bootstrapPeer})`);

    let acquireOutput;
    try {
        process.env.EV_HP_INIT_CFG_PATH = initCfgPath;
        delete process.env.EV_HP_OVERRIDE_CFG_PATH;
        acquireOutput=execSync(
            `${sudo}evdevkit acquire ${extHost} -m ${moments} -c ${contractId}`,
            {encoding:'utf8', env: process.env}
        );
        console.log(acquireOutput);
    } catch(e) { console.error(`  ✗ Acquire failed: ${e.message}`); fs.unlinkSync(initCfgPath); return; }
    fs.unlinkSync(initCfgPath);

    const pub  =(acquireOutput.match(/pubkey['":\s]+['"]?(ed[a-f0-9]{64})['"]?/)||[])[1];
    const peer =(acquireOutput.match(/peer_port['":\s]+['"]?(\d+)['"]?/)||[])[1];
    const user =(acquireOutput.match(/user_port['":\s]+['"]?(\d+)['"]?/)||[])[1];
    const dom  =(acquireOutput.match(/domain['":\s]+['"]?([a-zA-Z0-9._-]+\.[a-zA-Z]{2,})['"]?/)||[])[1];
    const name =(acquireOutput.match(/name['":\s]+['"]?([A-F0-9]{64})['"]?/)||[])[1]||'';
    const ts   =parseInt((acquireOutput.match(/created_timestamp['":\s]+(\d+)/)||[])[1]||Date.now());
    if (!pub||!peer||!user||!dom) { console.error('  ✗ Could not parse acquire output.'); return; }

    // expiryMoment not available on initial acquire — only returned on extend.
    // Expiry tracked locally as createdTimestamp + lifeMoments * 3600 until first extend.

    console.log('\n  ── STEP 2: Register node in cluster ──────────────');
    try {
        const existingNodes = loadNodes().filter(n => stat.currentUnl.includes(n.pubkey)).map(n => ({
            pubkey: n.pubkey, domain: n.domain, userPort: n.userPort, peerPort: n.peerPort
        }));
        await submitInput(ip, port, { type: 'addNode', pubkey: pub, ip: dom, peerPort: parseInt(peer), userPort: parseInt(user), existingNodes });
        console.log('  ✓ Accepted. Saving node to cluster-nodes.json...');
        const nodes = loadNodes();
        const newRecord = { pubkey: pub, name, host: extHost, domain: dom, userPort: parseInt(user), peerPort: parseInt(peer), createdTimestamp: ts, lifeMoments: parseInt(moments) };
        nodes.push(newRecord);
        saveNodes(nodes);
        console.log('  ✓ Saved to cluster-nodes.json');
        const finalStat = await getStatus(ip, port);
        console.log(`  ✓ Node registered. Current UNL=${finalStat.currentUnl.length} | Peers: ${finalStat.peers.join(', ')}`);

        console.log('\n  ── STEP 3: Deploy bundle ─────────────────────────');
        // Build bundle with all current UNL pubkeys and deploy to new node
        try {
            // 1 UNL pubkey + max 2 peers — keeps Xahau memo under 1KB limit.
            // New node syncs full UNL and peers automatically from first connection.
            const overrideCfg = {
                contract: {
                    unl: [finalStat.currentUnl[0]]
                },
                mesh: {
                    known_peers: loadNodes()
                        .filter(n => finalStat.currentUnl.includes(n.pubkey) && n.peerPort)
                        .slice(0, 2)
                        .map(n => `${n.domain}:${n.peerPort}`)
                }
            };
            const overrideCfgPath = path.join(PROJECT_DIR, 'node-override-temp.cfg');
            fs.writeFileSync(overrideCfgPath, JSON.stringify(overrideCfg));
            process.env.EV_HP_OVERRIDE_CFG_PATH = overrideCfgPath;

            // Write cluster.info into dist for new node — full UNL peer list so new node
            // has multiple peers to try when sending MATURED. No memo size constraint here.
            const unlNodes = loadNodes().filter(n => finalStat.currentUnl.includes(n.pubkey) && n.domain && n.peerPort);
            const clusterJson = {
                initialized: true,
                nodes: [
                    ...unlNodes.map(n => ({
                        pubkey: n.pubkey, domain: n.domain,
                        userPort: n.userPort, peerPort: n.peerPort,
                        isUnl: true, status: 'active'
                    })),
                    {
                        pubkey: pub, domain: dom,
                        userPort: parseInt(user), peerPort: parseInt(peer),
                        isUnl: false, status: 'created',
                        acknowledgeTries: 0, lastAckSentLcl: 0
                    }
                ]
            };
            fs.writeFileSync(path.join(TOOL_DIR, 'contract', 'dist', 'cluster.info'), JSON.stringify(clusterJson, null, 2));
            console.log(`  ✓ cluster.info written (${unlNodes.length} UNL nodes + new node).`);
            // Rebuild bundle with override cfg (includes full UNL and known_peers)
            execSync(
                `${sudo}evdevkit bundle "${path.join(TOOL_DIR, 'contract', 'dist')}" ${pub} /usr/bin/node -a index.js`,
                { encoding: 'utf8', cwd: PROJECT_DIR, env: process.env }
            );
            console.log('  ✓ Bundle rebuilt with peer config.');
            // Wait for the new node's user port to be ready
            console.log(`  Waiting for ${dom}:${user} to be ready...`);
            await pollUntil(async () => {
                try {
                    execSync(`nc -zw3 ${dom} ${user} 2>/dev/null`, { encoding: 'utf8' });
                    return true;
                } catch { return null; }
            }, roundtime * 20);
            console.log(`  ✓ Port ${user} is open.`);

            execSync(
                `${sudo}evdevkit deploy "${path.join(TOOL_DIR, 'contract', 'bundle', 'bundle.zip')}" ${dom} ${user}`,
                { encoding: 'utf8', env: process.env }
            );
            fs.unlinkSync(overrideCfgPath);
            delete process.env.EV_HP_OVERRIDE_CFG_PATH;
            console.log('  ✓ Bundle deployed to new node.');

            // STEP 4 — Wait for contract to auto-promote node to UNL via MATURED flow
            console.log('\n  ── STEP 4: Waiting for node to mature and join UNL ──');
            console.log('  (New node will send MATURED signal when synced...)');
            const expectedUnl = stat.currentUnl.length + 1;
            await pollUntil(async () => {
                const s = await getStatus(ip, port);
                process.stdout.write(`  UNL: ${s.currentUnl.length}/${expectedUnl} | voteStatus: ${s.voteStatus}          \r`);
                return s.currentUnl.length >= expectedUnl && s.voteStatus === 'synced' ? s : null;
            }, roundtime * 60); // Give up to 60 roundtimes for sync + MATURED flow
            const promotedStat = await getStatus(ip, port);
            console.log(`\n  ✓ Node promoted to UNL. UNL=${promotedStat.currentUnl.length}`);
        } catch(e) {
            if (e.message && e.message.includes('Timed out')) {
                console.log(`\n  ⚠  Timed out waiting for node to join UNL.`);
                console.log('  The node may still be syncing. Check status in a moment.');
            } else {
                console.error(`  ✗ Bundle deploy failed: ${e.message}`);
                console.log('  ⚠  Node registered but bundle not deployed. Deploy manually:');
                console.log(`     evdevkit deploy <bundle.zip> ${dom} ${user}`);
            }
        }
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
        const nodes = loadNodes();
        stat.currentUnl.forEach((pk,i)=>{ const n=nodes.find(n=>n.pubkey===pk); console.log(`    [${i}] ${pk.slice(0,20)}… ${n?n.domain:'(unknown)'}`); });
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
    const confirm=(await askYesNo(`  Confirm remove ${targetPubkey.slice(0,20)}…? (yes/y or Enter to cancel): `));
    if (confirm!=='yes'&&confirm!=='y') { console.log('  Cancelled.'); return; }
    try {
        const nodeInfo = loadNodes().find(n => n.pubkey === targetPubkey);
        const peerIp = nodeInfo ? nodeInfo.domain : null;
        const peerPort = nodeInfo ? nodeInfo.peerPort : null;
        await submitInput(ip, port, { type: 'removeNode', pubkey: targetPubkey, ip: peerIp, peerPort: parseInt(peerPort) });
        console.log('  ✓ Accepted. Saving and waiting for UNL update...');
        saveNodes(loadNodes().filter(n => n.pubkey !== targetPubkey));
        console.log('  ✓ Removed from cluster-nodes.json');
        const expectedUnl = stat.currentUnl.length - 1;
        const roundtime = parseInt(process.env.HP_ROUNDTIME || 6000);
        await pollUntil(async () => {
            const s = await getStatus(ip, port);
            process.stdout.write(`  UNL: ${s.currentUnl.length}/${expectedUnl} | voteStatus: ${s.voteStatus}          \r`);
            return s.currentUnl.length >= expectedUnl && s.voteStatus === 'synced' ? s : null;
        }, roundtime * 20);
        console.log(`\n  ✓ Node removed. UNL=${expectedUnl}`);
        // Clean up stale peer connection
        if (peerIp && peerPort) {
            try {
                await submitInput(ip, port, { type: 'removePeer', peerIp, peerPort: parseInt(peerPort) });
                console.log(`  ✓ Peer removed: ${peerIp}:${peerPort}`);
            } catch(e) { console.log(`  ⚠  Peer removal failed: ${e.message}`); }
        }
        // Terminate the lease on-chain to evict the container and prevent further access.
        // The removed node's URI token is burned and the host evicts the instance.
        if (nodeInfo && nodeInfo.name) {
            try {
                console.log(`  Terminating lease for ${nodeInfo.domain}...`);
                const { tenant, xrplApi } = await getEvernodeTenant();
                await tenant.connect();
                await tenant.terminateLease(nodeInfo.name);
                await tenant.disconnect();
                await xrplApi.disconnect();
                console.log(`  ✓ Lease terminated — instance evicted.`);
            } catch(e) {
                console.log(`  ⚠  Lease termination failed: ${e.message} (may already be evicted)`);
            }
        } else {
            console.log(`  ⚠  No lease name found — skipping termination.`);
        }
        const doReport = (await askYesNo('  Report this host as problematic? (yes/y or Enter to skip): '));
        if (isYes(doReport)) {
            const ni = loadNodes().find(n => n.pubkey === targetPubkey) || {};
            await reportHost(ni.host || targetPubkey, ni.domain || targetPubkey);
        }
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
    const nowSec = Math.floor(Date.now() / 1000);
    console.log('  ' + hr(108));
    console.log('  ' + 'Node'.padEnd(22) + 'Domain'.padEnd(28) + 'Source'.padEnd(8) + 'Remaining'.padEnd(16) + 'Expires (UTC)');
    console.log('  ' + hr(108));
    nodes.forEach(n => {
        const expirySec = getExpiryTimestamp(n);
        const remaining = expirySec - nowSec;
        const h = Math.floor(Math.abs(remaining) / 3600);
        const m = Math.floor((Math.abs(remaining) % 3600) / 60);
        const s = Math.abs(remaining) % 60;
        const remainText = remaining <= 0 ? '⚠  EXPIRED' : `${h}h ${m}m ${s}s`;
        const source     = n.expiryMoment ? 'chain' : 'local';
        console.log('  ' + (n.pubkey.slice(0,20)+'…').padEnd(22) + (n.domain||'').slice(0,26).padEnd(28) + source.padEnd(8) + remainText.padEnd(16) + new Date(expirySec * 1000).toUTCString());
    });
    console.log('  ' + hr(108));
    const soonNodes = nodes.filter(n => { const tr = timeRemaining(n); return !tr.expired && tr.remaining < 6 * 3600; });
    if (soonNodes.length > 0) {
        console.log(`\n  ⚠  ${soonNodes.length} node(s) expiring within 6 hours:`);
        soonNodes.forEach(n => { const tr = timeRemaining(n); console.log(`    ${n.domain} — ${tr.text} remaining`); });
    }
    console.log('─────────────────────────────────────────────────────\n');
};

const opExtendLease = async () => {
    console.log('\n── Extend Lease ─────────────────────────────────────');
    const nodes=loadNodes();
    if (!nodes.length) { console.log('  No node records found.'); console.log('─────────────────────────────────────────────────────\n'); return; }

    // Display nodes with index
    nodes.forEach((n,i)=>{ const tr=timeRemaining(n); console.log(`    [${i}] ${n.pubkey.slice(0,20)}… | ${n.domain} | ${tr.text}`); });

    // ── CHANGE: support single index, comma-separated indices, or "all" ──
    console.log('');
    console.log('  Examples: 0  |  2,5,7  |  all');
    const input=(await ask('  Node(s) to extend: ')).trim();
    if (!input) { console.log('  Cancelled.'); return; }

    let targets;
    if (input === 'all') {
        targets = nodes;
    } else if (input.includes(',')) {
        // Comma-separated indices
        const indices = input.split(',').map(s => parseInt(s.trim()));
        const invalid = indices.filter(i => isNaN(i) || i < 0 || i >= nodes.length);
        if (invalid.length) {
            console.error(`  ✗ Invalid index(es): ${invalid.join(', ')} — valid range is 0–${nodes.length - 1}`);
            return;
        }
        targets = indices.map(i => nodes[i]);
    } else if (/^\d+$/.test(input)) {
        const idx = parseInt(input);
        if (idx < 0 || idx >= nodes.length) { console.error('  ✗ Invalid index.'); return; }
        targets = [nodes[idx]];
    } else {
        console.error('  ✗ Invalid input — enter an index, comma-separated indices, or "all".');
        return;
    }

    // Confirm selection
    console.log(`\n  Selected ${targets.length} node(s):`);
    targets.forEach(n => console.log(`    ${n.domain}`));
    console.log('');

    const momentsStr=(await ask('  Extend by how many moments: ')).trim();
    if (!momentsStr||isNaN(momentsStr)) { console.log('  Cancelled.'); return; }
    const addMoments=parseInt(momentsStr);

    console.log(`\n  Connecting to Xahau (${process.env.XAHAU_WS || process.env.EV_XAHAUD_SERVER || 'wss://xahau.network'})...`);
    let evernodeCtx;
    try {
        evernodeCtx = await getEvernodeTenant();
        console.log('  ✓ Connected.\n');
    } catch(e) {
        console.error(`  ✗ Could not connect to Xahau: ${e.message}`);
        return;
    }

    const { tenant, xrplApi } = evernodeCtx;
    const updatedNodes  = loadNodes();
    let successCount    = 0;
    let failCount       = 0;
    const failedDomains = [];

    for (const node of targets) {
        if (!node.name || !node.host) {
            console.log(`  ✗ ${node.domain} — missing host/name details, cannot extend.`);
            failCount++;
            failedDomains.push(node.domain);
            continue;
        }
        process.stdout.write(`  Extending ${node.domain} by ${addMoments} moment(s)... `);
        try {
            const result = await tenant.extendLease(node.host, addMoments, node.name);
            const record = updatedNodes.find(n => n.pubkey === node.pubkey);
            if (record) {
                record.expiryMoment = result.expiryMoment;
                record.lifeMoments += addMoments;
                console.log(`✓`);
                console.log(`    On-chain confirmed | expiryMoment: ${result.expiryMoment} | expires: ${momentToDate(result.expiryMoment)}`);
            }
            successCount++;
        } catch(e) {
            console.log(`✗`);
            console.log(`    FAILED — ${e.reason || e.message || JSON.stringify(e)}`); console.log(`    DEBUG — reason:${e.reason} message:${e.message} content:${e.content} error:${e.error}`);
            failCount++;
            failedDomains.push(node.domain);
        }
    }

    try { await tenant.disconnect(); } catch {}
    try { await xrplApi.disconnect(); } catch {}

    if (successCount > 0) saveNodes(updatedNodes);

    console.log('');
    if (failCount === 0) {
        console.log(`  ✓ All ${successCount} extension(s) confirmed on-chain. cluster-nodes.json updated.`);
    } else if (successCount === 0) {
        console.log(`  ✗ All ${failCount} extension(s) failed. cluster-nodes.json unchanged.`);
        console.log('    Check your EVR balance and Xahau connection, then try again.');
    } else {
        console.log(`  ⚠  ${successCount} succeeded, ${failCount} failed.`);
        console.log('    Failed nodes were NOT updated. Run extend again to retry:');
        failedDomains.forEach(d => console.log(`    ✗ ${d}`));
    }
    console.log('─────────────────────────────────────────────────────\n');
};

const reportHost = async (address, domain) => {
    const apiUrl = process.env.HOST_API_URL || 'https://api.onledger.net';
    const reason = (await ask('  Reason (e.g. user port closed, contract failed): ')).trim() || 'reported by user';
    const url = apiUrl.replace(/\/$/, '') + '/hosts/' + address + '/report';
    return new Promise((resolve) => {
        const mod = url.startsWith('https') ? require('https') : require('http');
        const req = mod.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const r = JSON.parse(d);
                    if (r.success) console.log(`  ✓ Host ${domain} reported and excluded for 7 days.`);
                    else console.log('  ✗ Report failed:', r.error);
                } catch { console.log('  ✗ Report failed.'); }
                resolve();
            });
        });
        req.on('error', () => { console.log('  ✗ Could not reach API.'); resolve(); });
        req.write(JSON.stringify({ reason }));
        req.end();
    });
};

const opFindHosts = async () => {
    const minSlots=parseInt((await ask('  Minimum available slots (default 1): ')).trim()||'1');
    const target=parseInt((await ask('  Number of hosts to find (default 20): ')).trim()||'20');
    const minRep=parseInt((await ask('  Minimum reputation score (default 200, max 252): ')).trim()||'200');
    const unscored=(await askYesNo('  Include unscored hosts rep=0? (yes/y or Enter to skip): '));
    const hosts = await findHosts(minSlots, target, minRep, isYes(unscored), true);
    if (!hosts || !hosts.length) return;
    while (true) {
        const input = (await ask('  Report a host? (enter full host address or Enter to skip): ')).trim();
        if (!input) break;
        const host = hosts.find(h => h.address === input);
        if (!host) { console.log('  Host address not found in current results — enter the full address exactly as shown.'); continue; }
        await reportHost(host.address, host.domain);
    }
};


// ── Delete Project ────────────────────────────────────────────

const opDeleteProject = async (project) => {
    console.log('\n── Delete Project ───────────────────────────────────');
    console.log(`  Project : ${project.name}`);
    if (project.contractId) console.log(`  Contract: ${project.contractId.slice(0,8)}…`);
    console.log('');
    const confirm = (await askYesNo('  Are you sure you want to delete this project? (yes/y or Enter to cancel): '));
    if (confirm !== 'yes' && confirm !== 'y') { console.log('  Cancelled.'); return; }
    const delDir = (await askYesNo('  Also delete project directory and all files? (yes/y or Enter to keep): '));
    if (delDir === 'yes' || delDir === 'y') {
        fs.rmSync(project.dir, { recursive: true, force: true });
        console.log(`  ✓ Project "${project.name}" and all files deleted.`);
    } else {
        console.log(`  ✓ Project "${project.name}" removed from list (files kept at ${project.dir}).`);
    }
};

// ── Reset Global Credentials ──────────────────────────────────

const opResetCredentials = async () => {
    console.log('\n── Reset Global Credentials ─────────────────────────');
    console.log('  This will overwrite the shared credentials used by all projects.');
    const confirm = (await askYesNo('  Proceed? (yes/y or Enter to cancel): '));
    if (confirm !== 'yes' && confirm !== 'y') { console.log('  Cancelled.'); return; }
    await setupGlobalCredentials();
    console.log('  ✓ Global credentials updated.');
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
    console.log('    1. Create new project');
    console.log('    2. Reset global credentials');
    console.log('    3. Remove projects');
    projects.forEach((p,i) => {
        const status = p.contractId ? `contract: ${p.contractId.slice(0,8)}… | ${p.lastNode||'no node saved'}` : 'no cluster yet';
        console.log(`    ${i+4}. ${p.name.padEnd(22)} ${status}`);
    });
    console.log(`    ${projects.length+4}. Exit`);
    console.log('');

    while (true) {
        const input=(await ask('  Choice: ')).trim();
        const idx=parseInt(input);
        if (idx===projects.length+4) { rl.close(); process.exit(0); }
        if (idx===1) { return await createProject(); }
        if (idx===2) { await opResetCredentials(); return await selectProject(); }
        if (idx===3) {
            // Remove projects
            console.log('\n  Select projects to remove (comma-separated numbers, e.g. 1,3,5):');
            projects.forEach((p,i) => console.log(`    ${i+1}. ${p.name}`));
            console.log('');
            const sel = (await ask('  Projects to remove (or Enter to cancel): ')).trim();
            if (sel) {
                const indices = sel.split(',').map(s=>parseInt(s.trim())-1).filter(i=>i>=0&&i<projects.length);
                for (const i of indices) {
                    await opDeleteProject(projects[i]);
                }
            }
            return await selectProject();
        }
        if (idx>=4&&idx<=projects.length+3) {
            const project=projects[idx-4];
            console.log(`\n  Project: ${project.name}`);
            console.log('    1. Open project');
            console.log('    2. Delete project');
            console.log('    3. Back');
            console.log('');
            const action=(await ask('  Choice: ')).trim();
            if (action==='2') { await opDeleteProject(project); return await selectProject(); }
            if (action==='3') { return await selectProject(); }
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

const opReadLog = async () => {
    console.log('\n── Read Node Log ────────────────────────────────────');
    let stat;
    try {
        stat = await getStatus(ip, port);
        const nodes = loadNodes();
        stat.currentUnl.forEach((pk,i)=>{ const n=nodes.find(n=>n.pubkey===pk); console.log(`    [${i}] ${pk.slice(0,20)}… ${n?n.domain:'(unknown)'} port:${n?n.userPort:'?'}`); });
    } catch(e) { console.error(`  ✗ ${e.message}`); return; }

    const input=(await ask('\n  Node index: ')).trim();
    if (!input) { console.log('  Cancelled.'); return; }
    const idx = parseInt(input);
    if (isNaN(idx)||idx<0||idx>=stat.currentUnl.length) { console.error('  ✗ Invalid index.'); return; }

    const nodes = loadNodes();
    const pk = stat.currentUnl[idx];
    const nodeInfo = nodes.find(n=>n.pubkey===pk);
    if (!nodeInfo) { console.error('  ✗ Node not in cluster-nodes.json.'); return; }

    console.log('  Log file:');
    console.log('    1. hp.log (HotPocket)');
    console.log('    2. rw.stdout.log (contract stdout)');
    console.log('    3. rw.stderr.log (contract stderr)');
    console.log('    4. hp.cfg (config)');
    console.log('    5. patch.cfg (contract override)');
    console.log('    6. env.vars (host environment)');
    console.log('    7. cluster.json (cluster state)');
    console.log('    8. authorized_pubkey.txt (authorized key)');
    const logChoice = (await ask('  Choice (default 1): ')).trim() || '1';
    if (logChoice === '5' || logChoice === '6') {
        try {
            const HP = require('hotpocket-js-client');
            const kp = await getKeyPair();
            const client = await HP.createClient([`wss://${nodeInfo.domain}:${nodeInfo.userPort}`], kp, { protocol: HP.protocols.json });
            const connected = await client.connect();
            if (!connected) { console.error('  ✗ Connection failed.'); return; }
            const reqType = logChoice === '5' ? 'readPatchCfg' : 'readEnvVars';
            const label = logChoice === '5' ? 'patch.cfg' : 'env.vars';
            const raw = await client.submitContractReadRequest(JSON.stringify({ type: reqType }));
            await client.close().catch(()=>{});
            const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (p.type === 'error') { console.error(`  ✗ ${p.message}`); return; }
            console.log(`\n  Node: ${nodeInfo.domain} | ${label} | ${new Date().toISOString()}`);
            console.log('─'.repeat(80));
            console.log(logChoice === '5' ? JSON.stringify(p.cfg, null, 2) : p.content);
            console.log('─────────────────────────────────────────────────────\n');
        } catch(e) { console.error(`  ✗ ${e.message}`); }
        return;
    }
    if (logChoice === '4') {
        try {
            const HP = require('hotpocket-js-client');
            const kp = await getKeyPair();
            const client = await HP.createClient([`wss://${nodeInfo.domain}:${nodeInfo.userPort}`], kp, { protocol: HP.protocols.json });
            const connected = await client.connect();
            if (!connected) { console.error('  ✗ Connection failed.'); return; }
            const raw = await client.submitContractReadRequest(JSON.stringify({ type: 'readCfg' }));
            await client.close().catch(()=>{});
            const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (p.type === 'error') { console.error(`  ✗ ${p.message}`); return; }
            console.log(`\n  Node: ${nodeInfo.domain} | hp.cfg | ${new Date().toISOString()}`);
            console.log('─'.repeat(80));
            console.log(JSON.stringify(p.cfg, null, 2));
            console.log('─────────────────────────────────────────────────────\n');
        } catch(e) { console.error(`  ✗ ${e.message}`); }
        return;
    }
    if (logChoice === '7' || logChoice === '8') {
        try {
            const HP = require('hotpocket-js-client');
            const kp = await getKeyPair();
            const client = await HP.createClient([`wss://${nodeInfo.domain}:${nodeInfo.userPort}`], kp, { protocol: HP.protocols.json });
            const connected = await client.connect();
            if (!connected) { console.error('  ✗ Connection failed.'); return; }
            const reqType = logChoice === '7' ? 'readClusterJson' : 'readAuthorizedPubkey';
            const label   = logChoice === '7' ? 'cluster.json'    : 'authorized_pubkey.txt';
            const raw = await client.submitContractReadRequest(JSON.stringify({ type: reqType }));
            await client.close().catch(()=>{});
            const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (p.type === 'error') { console.error(`  ✗ ${p.message}`); return; }
            console.log(`\n  Node: ${nodeInfo.domain} | ${label} | ${new Date().toISOString()}`);
            console.log('─'.repeat(80));
            if (logChoice === '7') {
                console.log(JSON.stringify(p.data, null, 2));
            } else {
                console.log(p.pubkey);
            }
            console.log('─────────────────────────────────────────────────────\n');
        } catch(e) { console.error(`  ✗ ${e.message}`); }
        return;
    }

    const logType = logChoice === '2' ? 'readContractLog' : logChoice === '3' ? 'readContractLog' : 'readLog';
    const logFile = logChoice === '3' ? 'stderr' : 'stdout';
    const linesStr = (await ask('  Lines to fetch (default 50): ')).trim() || '50';
    const lines = parseInt(linesStr) || 50;
    const tailMode = (await askYesNo('  Auto-refresh every 5s? (yes/y or Enter to skip): '));
    const doTail = tailMode === 'yes' || tailMode === 'y';

    const fetchLog = async () => {
        try {
            const HP = require('hotpocket-js-client');
            const kp = await getKeyPair();
            const client = await HP.createClient([`wss://${nodeInfo.domain}:${nodeInfo.userPort}`], kp, { protocol: HP.protocols.json });
            const connected = await client.connect();
            if (!connected) { console.error('  ✗ Connection failed.'); return false; }
            const raw = await client.submitContractReadRequest(JSON.stringify({ type: logType, lines, logFile }));
            await client.close().catch(()=>{});
            const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (p.type === 'error') { console.error(`  ✗ ${p.message}`); return false; }
            console.clear();
            console.log(`  Node: ${nodeInfo.domain} | Last ${lines} lines | ${new Date().toISOString()}${doTail ? ' | Ctrl+C to stop' : ''}`);
            console.log('─'.repeat(80));
            console.log(p.lines || 'no log data');
            return true;
        } catch(e) { console.error(`  ✗ ${e.message}`); return false; }
    };

    console.log(`\n  Fetching log from ${nodeInfo.domain}:${nodeInfo.userPort}...`);
    await fetchLog();

    if (doTail) {
        console.log('\n  Tailing... press Ctrl+C to stop.');
        const interval = setInterval(async () => { await fetchLog(); }, 5000);
        await new Promise(resolve => {
            process.once('SIGINT', () => { clearInterval(interval); console.log('\n  Stopped.'); resolve(); });
        });
    }
    console.log('─────────────────────────────────────────────────────\n');
};

// ── Report Host ──────────────────────────────────────────────

const opReportHost = async () => {
    console.log('\n── Report a Host ────────────────────────────────────');
    const nodes = loadNodes();
    if (nodes.length) {
        console.log('  Current cluster nodes:');
        nodes.forEach((n, i) => console.log(`    [${i}] ${n.pubkey.slice(0,20)}… ${n.domain} (${n.host})`));
        console.log('');
    }
    const address = (await ask('  Host Xahau address to report: ')).trim();
    if (!address) { console.log('  Cancelled.'); return; }
    const domain = nodes.find(n => n.host === address)?.domain || address;
    await reportHost(address, domain);
    console.log('─────────────────────────────────────────────────────\n');
};

// ── Management menu ───────────────────────────────────────────

const managementMenu = async () => {
    if (!contractId||!ip||!port) {
        console.log('\n  No cluster deployed yet for this project.');
        const deploy=(await askYesNo('  Deploy a new cluster now? (yes/y or Enter to skip): '));
        if (isYes(deploy)) { const ok=await opDeploy(); if (!ok) return; }
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
        console.log('    8. Read node log');
        console.log('    9. Report problematic host');
        console.log('   10. Switch project');
        console.log('    0. Exit');
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
            case '8': await opReadLog(); break;
            case '9': await opReportHost(); break;
            case '10': return 'switch';
            case '0': console.log('  Goodbye.\n'); rl.close(); process.exit(0);
            default: console.log('  Invalid choice.\n');
        }
    }
};

// ── Main ──────────────────────────────────────────────────────

const main = async () => {
    console.log('');
    const title = `  Evernode Client Cluster Manager  ${TOOL_VERSION}  `;
    const width = 54;
    const pad = width - title.length;
    const padStr = ' '.repeat(Math.max(0, pad));
    console.log('╔' + '═'.repeat(width) + '╗');
    console.log('║' + title + padStr + '║');
    console.log('╚' + '═'.repeat(width) + '╝');

    fs.mkdirSync(PROJECTS_DIR, { recursive: true });

    // Install client dependencies if needed
    const clientNodeModules = path.join(TOOL_DIR, 'client', 'node_modules');
    if (!fs.existsSync(clientNodeModules)) {
        console.log('\n  Installing dependencies...');
        execSync(`npm install --prefix ${path.join(TOOL_DIR, 'client')} --silent`, { env: { ...process.env, BLAKE3_FORCE_WASM: '1' } });
        console.log('  ✓ Done\n');
    }

    // Check for global credentials — ask once if not set
    if (!hasGlobalEnv()) {
        console.log('\n  Welcome! First time setup — enter your credentials once.');
        console.log('  They will be reused across all projects.\n');
        await setupGlobalCredentials();
    } else {
        loadGlobalEnv();
    }

    while (true) {
        await selectProject();
        const result = await managementMenu();
        ip=null; port=null; contractId=null;
        PROJECT_DIR=null; ENV_FILE=null; NODES_FILE=null; CONTRACT_DIR=null; INITCFG=null;
        if (result !== 'switch') console.log('\n  Returning to project selector...\n');
        else console.log('\n  Switching project...\n');
    }
};

main().catch(e => { console.error('Fatal:', e.message); rl.close(); process.exit(1); });
