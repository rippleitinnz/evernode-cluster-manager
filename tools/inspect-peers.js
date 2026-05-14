#!/usr/bin/env node
// inspect-peers.js
// Standalone diagnostic — pulls hp.cfg, patch.cfg, and live status from every
// UNL node in a cluster, then reports per-node and aggregate peer state.
//
// Read-only on every path. Makes no state changes anywhere in the cluster.
//
// Usage:
//   node inspect-peers.js                          # uses cwd as project dir
//   node inspect-peers.js /path/to/project         # explicit project dir
//   node inspect-peers.js --watch zerp.network     # highlight matches in output
//   node inspect-peers.js --json                   # raw JSON dump (machine-readable)
//
// Requires: hotpocket-js-client and dotenv installed in the project's
// node_modules (the cluster manager already has these, so running from the
// project dir or its parent should work without any new install).

'use strict';

const path = require('path');
const fs   = require('fs');

// ── arg parsing ───────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let projectDir = process.cwd();
const watchTerms = [];
let outputJson = false;

for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--watch')      { watchTerms.push((argv[++i] || '').toLowerCase()); }
    else if (a === '--json')  { outputJson = true; }
    else if (a === '-h' || a === '--help') {
        console.log('usage: node inspect-peers.js [project-dir] [--watch <substring>]... [--json]');
        process.exit(0);
    }
    else if (!a.startsWith('-')) { projectDir = path.resolve(a); }
}
if (watchTerms.length === 0) watchTerms.push('zerp.network'); // sensible default

// ── locate project files ──────────────────────────────────────────────────
const NODES_FILE = path.join(projectDir, 'cluster-nodes.json');
const ENV_FILE   = path.join(projectDir, '.env');
const GLOBAL_ENV = path.join(require('os').homedir(), '.evernode-cluster-manager', '.env');

if (!fs.existsSync(NODES_FILE)) {
    console.error(`✗ cluster-nodes.json not found at ${NODES_FILE}`);
    console.error(`  Pass the project dir as the first argument.`);
    process.exit(1);
}

// dotenv: global first, then project (overrides)
try { require('dotenv').config({ path: GLOBAL_ENV }); } catch {}
try { require('dotenv').config({ path: ENV_FILE, override: true }); } catch {}

if (!process.env.EV_USER_PRIVATE_KEY) {
    console.error('✗ EV_USER_PRIVATE_KEY not set. Source the project .env or run from inside the project dir.');
    process.exit(1);
}

const nodes = (() => {
    try { return JSON.parse(fs.readFileSync(NODES_FILE, 'utf8')); }
    catch (e) { console.error(`✗ failed to parse cluster-nodes.json: ${e.message}`); process.exit(1); }
})();
if (!Array.isArray(nodes) || nodes.length === 0) {
    console.error('✗ cluster-nodes.json is empty.');
    process.exit(1);
}

// hotpocket-js-client lives in the project's node_modules
let HP;
try {
    HP = require(path.join(projectDir, 'node_modules', 'hotpocket-js-client'));
} catch {
    try { HP = require('hotpocket-js-client'); }  // fall back to global / local
    catch { console.error('✗ hotpocket-js-client not installed. Run from project root.'); process.exit(1); }
}

// ── helpers ───────────────────────────────────────────────────────────────
const TIMEOUT_MS = 15000;

const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
]);

const connect = async (domain, userPort) => {
    const kp = await HP.generateKeys(process.env.EV_USER_PRIVATE_KEY);
    const client = await HP.createClient([`wss://${domain}:${userPort}`], kp, { protocol: HP.protocols.json });
    const ok = await withTimeout(client.connect(), TIMEOUT_MS, 'connect');
    if (!ok) { try { await client.close(); } catch {} throw new Error('connect returned false'); }
    return client;
};

const readReq = async (client, type) => {
    const raw = await withTimeout(
        client.submitContractReadRequest(JSON.stringify({ type })),
        TIMEOUT_MS,
        `readonly ${type}`
    );
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (p && p.type === 'error') throw new Error(p.message || `${type} returned error`);
    return p;
};

const probeNode = async (node) => {
    const out = { node, ok: false };
    let client;
    try {
        client = await connect(node.domain, node.userPort);
    } catch (e) {
        out.error = `connect: ${e.message}`;
        return out;
    }
    try {
        const status   = await withTimeout(client.getStatus(), TIMEOUT_MS, 'getStatus');
        const hpCfg    = await readReq(client, 'readCfg').catch(e => ({ _error: e.message }));
        const patchCfg = await readReq(client, 'readPatchCfg').catch(e => ({ _error: e.message }));
        out.ok = true;
        out.status   = status;
        out.hpCfg    = hpCfg && !hpCfg._error ? hpCfg.cfg : null;
        out.hpCfgErr = hpCfg && hpCfg._error  ? hpCfg._error : null;
        out.patchCfg    = patchCfg && !patchCfg._error ? patchCfg.cfg : null;
        out.patchCfgErr = patchCfg && patchCfg._error  ? patchCfg._error : null;
    } catch (e) {
        out.error = e.message;
    } finally {
        try { await client.close(); } catch {}
    }
    return out;
};

const isWatched = (s) => {
    if (!s) return false;
    const lower = String(s).toLowerCase();
    return watchTerms.some(t => t && lower.includes(t));
};

// ── main ──────────────────────────────────────────────────────────────────
(async () => {
    // Find a reachable seed node (try each cluster-nodes.json entry until one answers status).
    let seedStatus = null, seedNode = null;
    for (const n of nodes) {
        if (!n.domain || !n.userPort) continue;
        try {
            const c = await connect(n.domain, n.userPort);
            seedStatus = await withTimeout(c.getStatus(), TIMEOUT_MS, 'seed getStatus');
            try { await c.close(); } catch {}
            seedNode = n;
            break;
        } catch {}
    }
    if (!seedStatus) {
        console.error('✗ Could not reach any node in cluster-nodes.json. Aborting.');
        process.exit(1);
    }

    const currentUnl = seedStatus.currentUnl || [];
    const unlNodes = nodes.filter(n => currentUnl.includes(n.pubkey));

    if (!outputJson) {
        console.log('');
        console.log('  Evernode Cluster — Peer Inspection');
        console.log('  ════════════════════════════════════════════════════════════════');
        console.log(`  Project        : ${path.basename(projectDir)}`);
        console.log(`  Seed node      : ${seedNode.domain}`);
        console.log(`  voteStatus     : ${seedStatus.voteStatus}`);
        console.log(`  UNL size       : ${currentUnl.length}`);
        console.log(`  Resolvable     : ${unlNodes.length} of ${currentUnl.length}`);
        console.log(`  Watch terms    : ${watchTerms.join(', ')}`);
        console.log('  ════════════════════════════════════════════════════════════════\n');
    }

    // Probe every UNL node we have a record for (sequential — keeps load low and output ordered).
    const probes = [];
    for (const n of unlNodes) {
        if (!outputJson) process.stdout.write(`  Probing ${n.domain.padEnd(34)}… `);
        const r = await probeNode(n);
        probes.push(r);
        if (!outputJson) {
            if (r.ok)       console.log('ok');
            else            console.log(`✗ ${r.error}`);
        }
    }

    // Canonical expected peer set: every UNL member's domain:peerPort.
    const expectedAll = new Set(
        unlNodes
            .filter(n => n.domain && n.peerPort)
            .map(n => `${n.domain}:${n.peerPort}`)
    );

    if (outputJson) {
        console.log(JSON.stringify({
            project: path.basename(projectDir),
            seedNode: seedNode.domain,
            voteStatus: seedStatus.voteStatus,
            currentUnl,
            expected: [...expectedAll],
            watchTerms,
            probes: probes.map(p => ({
                domain: p.node.domain,
                ok: p.ok,
                error: p.error || null,
                hpCfgKnownPeers:    p.hpCfg?.mesh?.known_peers    || null,
                patchCfgKnownPeers: p.patchCfg?.mesh?.known_peers || null,
                statusPeers:        p.status?.peers               || null,
                hpCfgErr: p.hpCfgErr, patchCfgErr: p.patchCfgErr,
            })),
        }, null, 2));
        return;
    }

    // ── per-node breakdown ──────────────────────────────────────────────
    console.log('');
    console.log('  Per-node breakdown');
    console.log('  ────────────────────────────────────────────────────────────────');
    for (const r of probes) {
        const tag = r.node.domain;
        if (!r.ok) {
            console.log(`\n  ${tag}`);
            console.log(`    ✗ probe failed: ${r.error}`);
            continue;
        }

        const self = `${r.node.domain}:${r.node.peerPort}`;
        const expected = new Set([...expectedAll].filter(p => p !== self));

        const hpKnown    = r.hpCfg?.mesh?.known_peers || [];
        const patchKnown = r.patchCfg?.mesh?.known_peers || [];
        const liveSeen   = r.status?.peers || [];

        // Diff classifications.
        const hpGhosts    = hpKnown.filter(p    => !expected.has(p) && p !== self);
        const patchGhosts = patchKnown.filter(p => !expected.has(p) && p !== self);
        const liveGhosts  = liveSeen.filter(p   => !expected.has(p) && p !== self);
        const hpMissing    = [...expected].filter(p => !hpKnown.includes(p));
        const patchMissing = [...expected].filter(p => !patchKnown.includes(p));
        const liveMissing  = [...expected].filter(p => !liveSeen.includes(p));

        console.log(`\n  ${tag}`);
        console.log(`    pubkey            : ${r.node.pubkey?.slice(0, 24)}…`);
        console.log(`    self peer-addr    : ${self}`);
        if (r.hpCfgErr)    console.log(`    hp.cfg            : ✗ ${r.hpCfgErr}`);
        else               console.log(`    hp.cfg known      : ${hpKnown.length}  ghosts=${hpGhosts.length}  missing=${hpMissing.length}`);
        if (r.patchCfgErr) console.log(`    patch.cfg         : ✗ ${r.patchCfgErr}`);
        else               console.log(`    patch.cfg known   : ${patchKnown.length}  ghosts=${patchGhosts.length}  missing=${patchMissing.length}`);
        console.log(`    live status peers : ${liveSeen.length}  ghosts=${liveGhosts.length}  missing=${liveMissing.length}`);

        // Detail lines — only print when something interesting (or watched).
        const detailLines = [];
        const flagWatch = (peer) => isWatched(peer) ? '  ⚑ WATCHED' : '';

        for (const p of hpGhosts)    detailLines.push(`      hp.cfg ghost      : ${p}${flagWatch(p)}`);
        for (const p of patchGhosts) detailLines.push(`      patch.cfg ghost   : ${p}${flagWatch(p)}`);
        for (const p of liveGhosts)  detailLines.push(`      live ghost        : ${p}${flagWatch(p)}`);
        for (const p of hpMissing)    detailLines.push(`      hp.cfg missing    : ${p}`);
        for (const p of patchMissing) detailLines.push(`      patch.cfg missing : ${p}`);
        for (const p of liveMissing)  detailLines.push(`      live missing      : ${p}`);

        // Even if no ghosts, if any peer matches a watch term, highlight it.
        for (const p of hpKnown)    if (isWatched(p) && !hpGhosts.includes(p))    detailLines.push(`      hp.cfg WATCHED    : ${p}`);
        for (const p of patchKnown) if (isWatched(p) && !patchGhosts.includes(p)) detailLines.push(`      patch.cfg WATCHED : ${p}`);
        for (const p of liveSeen)   if (isWatched(p) && !liveGhosts.includes(p))  detailLines.push(`      live WATCHED      : ${p}`);

        for (const line of detailLines) console.log(line);
    }

    // ── aggregate ───────────────────────────────────────────────────────
    console.log('');
    console.log('  Aggregate — where each address appears');
    console.log('  ────────────────────────────────────────────────────────────────');
    const allAddrs = new Map(); // addr -> { hp:[], patch:[], live:[] }
    const bump = (addr, layer, where) => {
        if (!allAddrs.has(addr)) allAddrs.set(addr, { hp: [], patch: [], live: [] });
        allAddrs.get(addr)[layer].push(where);
    };
    for (const r of probes) {
        if (!r.ok) continue;
        for (const p of r.hpCfg?.mesh?.known_peers    || []) bump(p, 'hp',    r.node.domain);
        for (const p of r.patchCfg?.mesh?.known_peers || []) bump(p, 'patch', r.node.domain);
        for (const p of r.status?.peers               || []) bump(p, 'live',  r.node.domain);
    }
    // Sort: ghosts/watched first, then by frequency.
    const sortedAddrs = [...allAddrs.entries()].sort((a, b) => {
        const ga = !expectedAll.has(a[0]); const gb = !expectedAll.has(b[0]);
        if (ga !== gb) return ga ? -1 : 1;
        return (b[1].hp.length + b[1].patch.length + b[1].live.length)
             - (a[1].hp.length + a[1].patch.length + a[1].live.length);
    });
    for (const [addr, layers] of sortedAddrs) {
        const isExpected = expectedAll.has(addr);
        const watched = isWatched(addr);
        const tag = !isExpected ? ' [GHOST]' : '';
        const tag2 = watched ? ' ⚑' : '';
        console.log(`    ${addr}${tag}${tag2}`);
        console.log(`      hp.cfg    : ${layers.hp.length} node(s)  ${layers.hp.length ? layers.hp.join(', ') : ''}`);
        console.log(`      patch.cfg : ${layers.patch.length} node(s)  ${layers.patch.length ? layers.patch.join(', ') : ''}`);
        console.log(`      live      : ${layers.live.length} node(s)  ${layers.live.length ? layers.live.join(', ') : ''}`);
    }

    // ── summary ─────────────────────────────────────────────────────────
    const ghostAddrs = [...allAddrs.keys()].filter(a => !expectedAll.has(a));
    const watchedAddrs = [...allAddrs.keys()].filter(a => isWatched(a));
    console.log('');
    console.log('  Summary');
    console.log('  ────────────────────────────────────────────────────────────────');
    console.log(`    Probed nodes        : ${probes.filter(p => p.ok).length} of ${probes.length}`);
    console.log(`    Ghost addresses     : ${ghostAddrs.length}`);
    console.log(`    Watched addresses   : ${watchedAddrs.length}`);
    if (ghostAddrs.length > 0) {
        console.log('');
        console.log('    Ghost-by-layer counts (which layer each ghost lives in):');
        for (const a of ghostAddrs) {
            const L = allAddrs.get(a);
            console.log(`      ${a}  hp=${L.hp.length} patch=${L.patch.length} live=${L.live.length}`);
        }
    }
    console.log('');
    console.log('  This was a read-only inspection. No cluster state was modified.');
    console.log('');
})().catch(e => {
    console.error(`\n✗ unhandled error: ${e.stack || e.message}`);
    process.exit(2);
});
