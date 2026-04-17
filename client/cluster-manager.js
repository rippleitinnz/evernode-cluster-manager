#!/usr/bin/env node
/**
 * Evernode Cluster Manager v3.0.0
 *
 * Single tool for deploying and managing multiple HotPocket cluster projects.
 * No host access required.
 *
 * Usage: node cluster-manager.js
 */

'use strict';

const TOOL_VERSION = 'v3.0.0';

const path         = require('path');
const fs           = require('fs');
const readline     = require('readline');
const https        = require('https');
const { execSync, spawnSync } = require('child_process');
const vm           = require('vm');
const os           = require('os');

// ── Tool and projects paths ───────────────────────────────────
const TOOL_DIR       = path.dirname(__dirname);
const TOOL_CONTRACT  = path.join(TOOL_DIR, 'contract', 'dist');
const PROJECTS_DIR   = path.join(os.homedir(), '.evernode-clusters', 'projects');
const GLOBAL_ENV     = path.join(os.homedir(), '.evernode-clusters', '.env');
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
const hr = (n=52) => '─'.repeat(n);
const sudo = process.platform !== 'win32' ? 'sudo -E ' : '';

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
const findHostsViaAPI = async (apiUrl, minSlots, targetCount, minRep, includeUnscored, allowReport = false) => {
    const url = apiUrl.replace(/\/$/, '') +
        '/hosts?active=true' +
        '&minSlots=' + minSlots +
        '&minRep=' + (minRep || 200) +
        (includeUnscored ? '&includeUnscored=true' : '') +
        '&minXah=1&minEvr=0.01' +
        '&minLastHeartbeat=180' +
        '&sortBy=hostReputation&sortDir=desc' +
        '&limit=' + (targetCount * 10);

    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? require('https') : require('http');
        mod.get(url, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const data = JSON.parse(d);
                    if (!data.success) { reject(new Error(data.error || 'API error')); return; }

                    // Deduplicate by operator — max 3 per operator for diversity
                    const domainCount = {};
                    const getOperator = (domain) => {
                        if (!domain) return 'unknown';
                        // Strip leading node numbers e.g. n1234.bisdaknode1051-1100.ovh -> bisdaknode
                        const stripped = domain.replace(/^[a-z0-9]+-?\d*\./, '');
                        // Extract meaningful operator name from subdomain
                        const parts = stripped.split('.');
                        // Use first subdomain part, strip trailing numbers
                        const base = parts[0].replace(/\d+(-\d+)?$/, '').replace(/-$/, '');
                        return base || parts.slice(-2).join('.');
                    };
                    const hosts = data.hosts.filter(h => {
                        const operator = getOperator(h.domain || '');
                        domainCount[operator] = (domainCount[operator] || 0) + 1;
                        return domainCount[operator] <= 3;
                    }).slice(0, targetCount);
                    // Fetch cache age
                    const ageMs = hosts.length > 0 ? Date.now() - hosts[0].lastUpdated : 0;
                    const ageMin = Math.round(ageMs / 60000);
                    const ageTxt = ageMin < 1 ? 'just now' : ageMin + ' min ago';
                    console.log('\n  API returned ' + hosts.length + ' hosts (from ' + data.total + ' matching) | cache updated: ' + ageTxt);

                    // Display results
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
                    console.log('\n  ' + hosts.length + ' host(s) from local API cache.');
                    if (allowReport) console.log('  Tip: To report a bad host, enter r<number> (e.g. r3)');
                    console.log('');

                    resolve(hosts);
                } catch(e) { reject(e); }
            });
        }).on('error', reject);
    });
};


// ── Batch XAH + EVR balance check ─────────────────────────────
const checkBalances = (addresses) => new Promise((resolve) => {
    const WS = (() => { try { return require('ws'); } catch { return require('/usr/lib/node_modules/evdevkit/node_modules/ws'); } })();
    const results = {};
    addresses.forEach(a => { results[a] = { xah: 0, evr: 0 }; });
    if (!addresses.length) { resolve(results); return; }
    let ws;
    try { ws = new WS('wss://xahau.network'); } catch { resolve(results); return; }
    let pending = addresses.length * 2;
    const finish = () => { try { ws.close(); } catch {} resolve(results); };
    const timer = setTimeout(finish, 20000);
    const dec = () => { if (--pending <= 0) { clearTimeout(timer); finish(); } };
    ws.on('open', () => {
        addresses.forEach(addr => {
            ws.send(JSON.stringify({ command:'account_info',  account:addr, ledger_index:'current', id:'info_'+addr  }));
            ws.send(JSON.stringify({ command:'account_lines', account:addr, ledger_index:'current', id:'lines_'+addr }));
        });
    });
    ws.on('message', (data) => {
        try {
            const r = JSON.parse(data);
            if (r.id && r.id.startsWith('info_')) {
                const addr = r.id.replace('info_','');
                if (r.result && r.result.account_data) results[addr].xah = parseInt(r.result.account_data.Balance)/1000000;
                dec();
            } else if (r.id && r.id.startsWith('lines_')) {
                const addr = r.id.replace('lines_','');
                const evr = r.result && r.result.lines && r.result.lines.find(l=>l.currency==='EVR');
                if (evr) results[addr].evr = parseFloat(evr.balance);
                dec();
            }
        } catch { dec(); }
    });
    ws.on('error', () => { clearTimeout(timer); resolve(results); });
});

// ── Batch reputation check via registry client ─────────────────
const checkReputation = async (addresses) => {
    const results = {};
    addresses.forEach(a => { results[a] = null; });
    if (!addresses.length) return results;
    try {
        const evernode = (() => { try { return require('evernode-js-client'); } catch { return require('/usr/lib/node_modules/evdevkit/node_modules/evernode-js-client'); } })();
        await evernode.Defaults.useNetwork('mainnet');
        const xrplApi = new evernode.XrplApi();
        evernode.Defaults.set({ xrplApi, useCentralizedRegistry: true });
        await xrplApi.connect();
        const reg = await evernode.HookClientFactory.create(evernode.HookTypes.registry);
        await reg.connect();
        await Promise.all(addresses.map(async addr => {
            try {
                const info = await reg.getHostInfo(addr);
                results[addr] = (info && info.hostReputation !== undefined) ? info.hostReputation : null;
            } catch { results[addr] = null; }
        }));
        await reg.disconnect();
        await xrplApi.disconnect();
    } catch(e) { console.error('  Warning: Reputation check failed:', e.message); }
    return results;
};

// ── Host Finder ───────────────────────────────────────────────
const findHosts = async (minSlots = 1, targetCount = 20, minRep = 200, includeUnscored = false, allowReport = false) => {
    // Use local API if configured
    const apiUrl = process.env.HOST_API_URL;
    if (apiUrl) {
        try {
            console.log('\n  Using local host API: ' + apiUrl);
            return await findHostsViaAPI(apiUrl, minSlots, targetCount, minRep, includeUnscored, allowReport);
        } catch(e) {
            console.log('  ⚠ API unavailable (' + e.message + ') — falling back to network scan...');
        }
    }

    const batchSize = 15;
    const MAX_SCAN  = 300;
    const MIN_XAH   = 5;
    const MIN_EVR   = 1;
    const MIN_REP   = 200;

    console.log('\n  Scanning for ' + targetCount + ' active hosts with >= ' + minSlots + ' slot(s)...');
    console.log('  Filters: slots >= ' + minSlots + ' | XAH >= ' + MIN_XAH + ' | EVR >= ' + MIN_EVR + ' | reputation >= ' + MIN_REP + '/255');
    console.log('  Note: The Evernode network has 15,000+ registered hosts, most inactive.');
    console.log('  Hosts are checked in batches — this typically takes 2-3 minutes.');
    console.log('  Press Ctrl+C to stop early and show results so far.\n');

    const get = (url) => new Promise((resolve, reject) => {
        https.get(url, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){reject(e);} }); }).on('error', reject);
    });

    process.stdout.write('  Fetching host list...');
    const data = await get('https://xahau.xrplwin.com/api/evernode/hosts');
    const priceMap = {};
    const allHosts = data.data.filter(h=>h.leaseprice_evr_drops!==null&&h.host).map(h=>{ priceMap[h.host]=h.leaseprice_evr_drops; return h.host; });
    console.log(' ' + allHosts.length + ' registered hosts.');

    const shuffled = allHosts.sort(()=>Math.random()-0.5);
    const found=[]; const checked=new Set(); let idx=0,batchNum=0,cancelled=false;

    const sigHandler = () => { cancelled=true; console.log('\n\n  Scan stopped — showing results so far...'); };
    process.once('SIGINT', sigHandler);

    while (found.length<targetCount&&idx<shuffled.length&&checked.size<MAX_SCAN&&!cancelled) {
        const batch=[];
        while (batch.length<batchSize&&idx<shuffled.length) {
            if(!checked.has(shuffled[idx])){batch.push(shuffled[idx]);checked.add(shuffled[idx]);}
            idx++;
        }
        if (!batch.length) break;
        batchNum++;
        process.stdout.write('  Batch ' + String(batchNum).padStart(2) + ' | Checked: ' + checked.size + '/' + MAX_SCAN + ' | Found: ' + found.length + '/' + targetCount + '\r');

        const tmpFile=require('path').join(require('os').tmpdir(),'ecm-hosts-batch.txt');
        fs.writeFileSync(tmpFile, batch.join('\n'));
        const result=spawnSync('evdevkit',['hostinfo','-f',tmpFile],{encoding:'utf8',timeout:60000});
        try{fs.unlinkSync(tmpFile);}catch{}
        const info=parseEvmOutput(result.stdout||'');
        if (!Array.isArray(info)) continue;

        const candidates = info.filter(h=>h.active&&h.availableInstanceSlots>=minSlots);
        if (!candidates.length) continue;

        const addrs = candidates.map(h=>h.address);
        process.stdout.write('  Batch ' + String(batchNum).padStart(2) + ' | Checking ' + addrs.length + ' candidates (balance + reputation)...\r');

        const [balances, reputations] = await Promise.all([
            checkBalances(addrs),
            checkReputation(addrs)
        ]);

        for (const h of candidates) {
            const bal = balances[h.address] || { xah:0, evr:0 };
            const rep = reputations[h.address];
            if (bal.xah < MIN_XAH) continue;
            if (bal.evr < MIN_EVR) continue;
            if (rep !== null && rep < MIN_REP) continue;
            h.leasePrice = priceMap[h.address]||null;
            h.xahBalance = bal.xah;
            h.evrBalance = bal.evr;
            h.reputation = rep;
            found.push(h);
        }
    }

    process.removeListener('SIGINT', sigHandler);

    if (checked.size>=MAX_SCAN&&found.length<targetCount)
        console.log('\n  Reached scan limit of ' + MAX_SCAN + ' hosts. Showing ' + found.length + ' results.');
    else
        console.log('\n  Found ' + found.length + ' verified host(s).');
    console.log('');

    if (!found.length) { console.log('  No hosts passed all filters.'); return found; }

    found.sort((a,b)=>(b.reputation||0)-(a.reputation||0)||(b.availableInstanceSlots-a.availableInstanceSlots)||(a.leasePrice||0)-(b.leasePrice||0));

    const fmtEVR=(d)=>{ if(!d)return'free?'; const e=d/1000000; if(e<0.001)return d+'drops'; if(e<1)return e.toFixed(4)+' EVR'; return e.toFixed(2)+' EVR'; };
    const fmtRep=(r)=>r===null?'?':String(r);

    console.log('  '+hr(131));
    console.log('  '+'#'.padEnd(4)+'Address'.padEnd(36)+'Domain'.padEnd(25)+'CC'.padEnd(5)+'Avail'.padEnd(7)+'Total'.padEnd(7)+'Rep'.padEnd(6)+'XAH'.padEnd(8)+'EVR'.padEnd(8)+'Lease/hr'.padEnd(12)+'Version');
    console.log('  '+hr(131));
    found.forEach((h,i)=>console.log(
        '  '+String(i+1).padEnd(4)+
        (h.address||'').padEnd(36)+
        (h.domain||'').slice(0,23).padEnd(25)+
        (h.countryCode||'??').padEnd(5)+
        String(h.availableInstanceSlots||0).padEnd(7)+
        String(h.totalInstanceSlots||0).padEnd(7)+
        fmtRep(h.reputation).padEnd(6)+
        (h.xahBalance||0).toFixed(1).padEnd(8)+
        (h.evrBalance||0).toFixed(1).padEnd(8)+
        fmtEVR(h.leasePrice).padEnd(12)+
        (h.sashimonoVersion||'?')
    ));
    console.log('  '+hr(131));
    console.log('\n  ' + found.length + ' host(s) verified — active, funded and reputation >= ' + MIN_REP + '.\n');
    return found;
};

// ── Global credentials setup ──────────────────────────────────

const setupGlobalCredentials = async () => {
    console.log('\n── Global Credentials Setup ─────────────────────────');
    console.log('  These credentials are shared across all projects.');
    console.log('  You only need to enter them once.\n');

    // Keys
    console.log('── Key Generation ────────────────────────────────────');
    const hasKeys = (await ask('  Have existing HotPocket user keys? (yes/y or Enter to generate): ')).trim();
    let userPrivKey='', userPubKey='';
    if (hasKeys==='yes'||hasKeys==='y') {
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

    // XRPL credentials
    console.log('\n── XRPL Tenant Credentials ───────────────────────────');
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
    const overrideCfg = { contract: { bin_path:'/usr/bin/node', bin_args:'index.js', consensus:{ roundtime:parseInt(roundtime), threshold:parseInt(threshold) } } };
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
        console.log('\n  Installing contract dependencies...');
        execSync(`npm install --prefix ${CONTRACT_DIR} --silent`);
        console.log('  ✓ Done');
    }

    loadProjectEnv();

    console.log('\n  ✓ Project created successfully.');
    console.log(`  Location: ${projectDir}\n`);
    return projectName;
};


// ── Verify host availability (live check) ─────────────────────
const verifyHosts = async (hostAddrs, requiredSlots = 1) => {
    const xahauWs = process.env.XAHAU_WS || 'wss://xahau.network';
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
        console.error('  ⚠ Could not verify hosts: ' + e.message);
        return { allOk: null, results: [] }; // null = verification failed, proceed with caution
    }
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
            const proceed = (await ask('  Some replacement hosts are still unavailable. Proceed anyway? (yes/y or Enter to cancel): ')).trim();
            if (proceed !== 'yes' && proceed !== 'y') { console.log('  Cancelled.'); return false; }
        }
    } else if (allOk === null) {
        const proceed = (await ask('  Could not verify hosts. Proceed anyway? (yes/y or Enter to cancel): ')).trim();
        if (proceed !== 'yes' && proceed !== 'y') { console.log('  Cancelled.'); return false; }
    }

    console.log('');
    console.log('[1/3] Installing contract dependencies...');
    const pkgJson = path.join(CONTRACT_DIR, 'package.json');
    const hasDeps = fs.existsSync(pkgJson) && Object.keys(JSON.parse(fs.readFileSync(pkgJson,'utf8')).dependencies || {}).length > 0;
    if (hasDeps) execSync(`npm install --prefix ${CONTRACT_DIR} --silent`);
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
            `${sudo}evdevkit cluster-create ${nodeCount} -m ${moments} "${CONTRACT_DIR}" /usr/bin/node "${hostsFile}" -a index.js`,
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
        console.log('  ⚠ Could not auto-parse output. Please enter details manually.');
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
                console.log('\n  ⚠ Unreachable node(s) detected:');
                unreachable.forEach(pk => {
                    const n = nodes.find(n => n.pubkey === pk);
                    console.log(`    ${pk.slice(0,20)}… ${n ? n.domain : 'unknown'}`);
                });
                const replace = (await ask('\n  Replace unreachable node(s) now? (yes/y or Enter to skip): ')).trim();
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
                            const doRemove = (await ask(`  Remove dead node ${deadPubkey.slice(0,20)}… now? (yes/y or Enter to skip): `)).trim();
                            if (doRemove === 'yes' || doRemove === 'y') {
                                console.log(`  Removing unreachable node ${deadPubkey.slice(0,20)}…`);
                                try {
                                    const nodeInfo = nodes.find(n => n.pubkey === deadPubkey);
                                    await submitInput(ip, port, { type: 'removeNode', pubkey: deadPubkey, ip: nodeInfo?.domain, peerPort: nodeInfo?.peerPort });
                                    saveNodes(loadNodes().filter(n => n.pubkey !== deadPubkey));
                                    const expectedUnl = stat.currentUnl.length;
                                    await pollUntil(async () => {
                                        const s = await getStatus(ip, port);
                                        process.stdout.write(`  UNL: ${s.currentUnl.length}/${expectedUnl} | voteStatus: ${s.voteStatus}\r`);
                                        return s.currentUnl.length === expectedUnl && s.voteStatus === 'synced' ? s : null;
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
            process.stdout.write(`  Checking version: ${v}\r`);
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

    const findFirst=(await ask('\n  Find available hosts first? (yes/y or Enter to skip): ')).trim();
    if (findFirst==='yes'||findFirst==='y') { await findHosts(1,20); await ask('  Press Enter to continue...'); }

    console.log('\n  ── STEP 1: Acquire ───────────────────────────────');
    const extHost=(await ask('  External host XRPL address: ')).trim();
    const moments=(await ask(`  Life moments (default ${process.env.DEFAULT_MOMENTS||3}): `)).trim()||(process.env.DEFAULT_MOMENTS||'3');
    if (!extHost) { console.log('  Cancelled.'); return; }

    const { allOk: hostOk } = await verifyHosts([extHost], 1);
    if (hostOk === false) {
        const proceed = (await ask('  Host has no available slots. Proceed anyway? (yes/y or Enter to cancel): ')).trim();
        if (proceed !== 'yes' && proceed !== 'y') { console.log('  Cancelled.'); return; }
    }

    // Write hp-init.cfg with peer and UNL info — no bundle/deploy needed
    const roundtime = parseInt(process.env.HP_ROUNDTIME||5000);
    const threshold = parseInt(process.env.HP_THRESHOLD||66);
    const logLevel = process.env.HP_LOG_LEVEL||'dbg';
    const initCfg = {
        contract: {
            bin_path: '/usr/bin/node',
            bin_args: 'index.js',
            consensus: { roundtime, threshold },
            unl: [stat.currentUnl[0]]
        },
        mesh: {
            peer_discovery: { enabled: process.env.HP_PEER_DISCOVERY==='true' },
            known_peers: stat.peers.length > 0 ? stat.peers : [`${ip}:${parseInt(port)-1}`]
        },
        log: { log_level: logLevel }
    };
    const initCfgPath = path.join(PROJECT_DIR, 'node-init-temp.cfg');
    fs.writeFileSync(initCfgPath, JSON.stringify(initCfg, null, 2));
    console.log(`  ✓ Init config written (peer: ${initCfg.mesh.known_peers[0]})`);

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

    console.log('\n  ── STEP 2: Add to UNL ────────────────────────────');
    try {
        await submitInput(ip, port, { type: 'addNode', pubkey: pub, ip: dom, peerPort: parseInt(peer) });
        console.log('  ✓ Accepted. Saving node and waiting for UNL update...');
        const nodes = loadNodes();
        nodes.push({ pubkey: pub, name, host: extHost, domain: dom, userPort: parseInt(user), peerPort: parseInt(peer), createdTimestamp: ts, lifeMoments: parseInt(moments) });
        saveNodes(nodes);
        console.log('  ✓ Saved to cluster-nodes.json');
        const expectedUnl = stat.currentUnl.length + 1;
        await pollUntil(async () => {
            const s = await getStatus(ip, port);
            process.stdout.write(`  UNL: ${s.currentUnl.length}/${expectedUnl} | voteStatus: ${s.voteStatus}\r`);
            return s.currentUnl.length === expectedUnl && s.voteStatus === 'synced' ? s : null;
        }, roundtime * 20);
        const finalStat = await getStatus(ip, port);
        console.log(`\n  ✓ Node added. UNL=${finalStat.currentUnl.length} | Peers: ${finalStat.peers.join(', ')}`);
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
    const confirm=(await ask(`  Confirm remove ${targetPubkey.slice(0,20)}…? (yes/y): `)).trim();
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
            process.stdout.write(`  UNL: ${s.currentUnl.length}/${expectedUnl} | voteStatus: ${s.voteStatus}\r`);
            return s.currentUnl.length === expectedUnl && s.voteStatus === 'synced' ? s : null;
        }, roundtime * 20);
        console.log(`\n  ✓ Node removed. UNL=${expectedUnl}`);
        // Clean up stale peer connection
        if (peerIp && peerPort) {
            try {
                await submitInput(ip, port, { type: 'removePeer', peerIp, peerPort: parseInt(peerPort) });
                console.log(`  ✓ Peer removed: ${peerIp}:${peerPort}`);
            } catch(e) { console.log(`  ⚠ Peer removal failed: ${e.message}`); }
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
    console.log('  '+hr(90));
    console.log('  '+'Pubkey'.padEnd(22)+'Domain'.padEnd(25)+'Purchased'.padEnd(11)+'Remaining'.padEnd(12)+'Expires (UTC)');
    console.log('  '+hr(90));
    nodes.forEach(n=>{ const tr=timeRemaining(n); console.log('  '+(n.pubkey.slice(0,20)+'…').padEnd(22)+(n.domain||'').slice(0,23).padEnd(25)+(n.lifeMoments+'h total').padEnd(11)+(tr.expired?'⚠ EXPIRED':tr.text).padEnd(12)+new Date(tr.expirySec*1000).toUTCString()); });
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
            execSync(
                `${sudo}evdevkit extend-instance ${node.host} ${node.name} -m ${addMoments}`,
                {encoding:'utf8', env: process.env}
            );
            node.lifeMoments+=addMoments;
            console.log(` ✓ Total: ${node.lifeMoments} moments.`);
        } catch(e) { console.log(` ✗ ${e.message}`); }
    }
    saveNodes(nodes);
    console.log('\n  ✓ cluster-nodes.json updated.');
    console.log('─────────────────────────────────────────────────────\n');
};

const reportHost = async (address, domain) => {
    const apiUrl = process.env.HOST_API_URL;
    if (!apiUrl) { console.log('  ⚠ No HOST_API_URL configured — cannot report.'); return; }
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
    const unscored=(await ask('  Include unscored hosts rep=0? (yes/y or Enter to skip): ')).trim();
    const hosts = await findHosts(minSlots, target, minRep, unscored==='yes'||unscored==='y', true);
    if (!hosts || !hosts.length) return;
    while (true) {
        const input = (await ask('  Report a host? (r<number> e.g. r3, or Enter to skip): ')).trim();
        if (!input) break;
        const match = input.match(/^r(\d+)$/i);
        let host;
        if (match) {
            const idx = parseInt(match[1]) - 1;
            if (idx < 0 || idx >= hosts.length) { console.log('  Invalid index.'); continue; }
            host = hosts[idx];
        } else {
            // Try full address match
            host = hosts.find(h => h.address === input);
            if (!host) { console.log('  Invalid — use r<number> e.g. r3, or full address'); continue; }
        }
        await reportHost(host.address, host.domain);
    }
};


// ── Delete Project ────────────────────────────────────────────

const opDeleteProject = async (project) => {
    console.log('\n── Delete Project ───────────────────────────────────');
    console.log(`  Project : ${project.name}`);
    if (project.contractId) console.log(`  Contract: ${project.contractId.slice(0,8)}…`);
    console.log('');
    const confirm = (await ask('  Are you sure you want to delete this project? (yes/y): ')).trim();
    if (confirm !== 'yes' && confirm !== 'y') { console.log('  Cancelled.'); return; }
    const delDir = (await ask('  Also delete project directory and all files? (yes/y or Enter to keep): ')).trim();
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
    const confirm = (await ask('  Proceed? (yes/y): ')).trim();
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
    const logChoice = (await ask('  Choice (default 1): ')).trim() || '1';
    const logType = logChoice === '2' ? 'readContractLog' : logChoice === '3' ? 'readContractLog' : 'readLog';
    const logFile = logChoice === '3' ? 'stderr' : 'stdout';
    const linesStr = (await ask('  Lines to fetch (default 50): ')).trim() || '50';
    const lines = parseInt(linesStr) || 50;
    const tailMode = (await ask('  Auto-refresh every 5s? (yes/y or Enter to skip): ')).trim();
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
        console.log('    8. Read node log');
        console.log('    9. Switch project');
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
            case '9': return 'switch';
            case '0': console.log('  Goodbye.\n'); rl.close(); process.exit(0);
            default: console.log('  Invalid choice.\n');
        }
    }
};

// ── Main ──────────────────────────────────────────────────────

const main = async () => {
    console.log('');
    const title = `  Evernode Cluster Manager  ${TOOL_VERSION}  `;
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
        execSync(`npm install --prefix ${path.join(TOOL_DIR, 'client')} --silent`);
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
        if (result !== 'switch') break;
        ip=null; port=null; contractId=null;
        PROJECT_DIR=null; ENV_FILE=null; NODES_FILE=null; CONTRACT_DIR=null; INITCFG=null;
        console.log('\n  Switching project...\n');
    }
};

main().catch(e => { console.error('Fatal:', e.message); rl.close(); process.exit(1); });
