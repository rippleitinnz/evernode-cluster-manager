#!/usr/bin/env node
/**
 * Evernode Cluster Manager — Host Finder
 * Scans the Evernode network for active hosts with available slots.
 * Keeps scanning in batches until it finds enough results.
 *
 * Usage: node find-hosts.js [min_slots] [target_results]
 *   min_slots      - minimum available slots required (default: 1)
 *   target_results - how many hosts to find before stopping (default: 20)
 */

'use strict';

const https     = require('https');
const { spawnSync } = require('child_process');
const fs        = require('fs');
const vm        = require('vm');

const minSlots     = parseInt(process.argv[2]) || 1;
const targetCount  = parseInt(process.argv[3]) || 20;
const batchSize    = 15;

const get = (url) => new Promise((resolve, reject) => {
    https.get(url, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
});

const stripAnsi = (str) => str.replace(/\u001b\[[0-9;]*m/g, '');

const parseHostInfo = (raw) => {
    try {
        const clean = stripAnsi(raw);
        const start = clean.indexOf('[');
        if (start === -1) return [];
        const result = vm.runInNewContext(`(${clean.slice(start).trim()})`);
        return Array.isArray(result) ? result : [];
    } catch(e) { return []; }
};

const checkBatch = (addresses) => {
    const tmpFile = '/tmp/evernode-hosts-batch.txt';
    fs.writeFileSync(tmpFile, addresses.join('\n'));
    const result = spawnSync('evdevkit', ['hostinfo', '-f', tmpFile], {
        encoding: 'utf8', timeout: 60000
    });
    try { fs.unlinkSync(tmpFile); } catch {}
    return parseHostInfo(result.stdout || '');
};

const formatEVR = (drops) => {
    if (!drops) return 'free?';
    const evr = drops / 1000000;
    if (evr < 0.001) return `${drops}drops`;
    if (evr < 1) return `${evr.toFixed(4)} EVR`;
    return `${evr.toFixed(2)} EVR`;
};

const run = async () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║       Evernode Cluster Manager — Host Finder        ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(`  Target    : ${targetCount} active hosts with >= ${minSlots} available slot(s)`);
    console.log(`  Batch size: ${batchSize} hosts per check\n`);

    // Step 1 — Get full host list with prices
    process.stdout.write('  Fetching host list from Evernode registry...');
    const data = await get('https://xahau.xrplwin.com/api/evernode/hosts');
    const priceMap = {};
    const allHosts = data.data
        .filter(h => h.leaseprice_evr_drops !== null && h.host)
        .map(h => {
            priceMap[h.host] = h.leaseprice_evr_drops;
            return h.host;
        });
    console.log(` ${allHosts.length} registered hosts found.`);
    console.log('  Scanning in batches (active hosts send regular heartbeats)...\n');

    // Step 2 — Shuffle and scan in batches
    const shuffled = allHosts.sort(() => Math.random() - 0.5);
    const found = [];
    const checked = new Set();
    let batchNum = 0;
    let idx = 0;

    while (found.length < targetCount && idx < shuffled.length) {
        const batch = [];
        while (batch.length < batchSize && idx < shuffled.length) {
            if (!checked.has(shuffled[idx])) {
                batch.push(shuffled[idx]);
                checked.add(shuffled[idx]);
            }
            idx++;
        }
        if (batch.length === 0) break;
        batchNum++;
        process.stdout.write(
            `  Batch ${String(batchNum).padStart(2)} | Checked: ${checked.size}/${shuffled.length} | Found: ${found.length}/${targetCount}\r`
        );
        const results = checkBatch(batch);
        const active = results.filter(h => h.active && h.availableInstanceSlots >= minSlots);
        // Attach price from API
        active.forEach(h => { h.leasePrice = priceMap[h.address] || null; });
        found.push(...active);
    }

    console.log(`\n  Scan complete. Checked ${checked.size} hosts, found ${found.length} active host(s).\n`);

    if (found.length === 0) {
        console.log(`  ✗ No active hosts found with >= ${minSlots} available slot(s).`);
        console.log('  Try again in a few minutes.');
        return;
    }

    // Sort by available slots desc, then price asc
    found.sort((a, b) => {
        if (b.availableInstanceSlots !== a.availableInstanceSlots)
            return b.availableInstanceSlots - a.availableInstanceSlots;
        return (a.leasePrice || 0) - (b.leasePrice || 0);
    });

    console.log('  ' + '─'.repeat(118));
    console.log(
        '  ' +
        '#'.padEnd(4) +
        'Address'.padEnd(36) +
        'Domain'.padEnd(25) +
        'CC'.padEnd(5) +
        'Avail'.padEnd(7) +
        'Total'.padEnd(7) +
        'RAM'.padEnd(12) +
        'Lease/hr'.padEnd(12) +
        'Version'
    );
    console.log('  ' + '─'.repeat(118));

    found.forEach((h, i) => {
        console.log(
            '  ' +
            String(i + 1).padEnd(4) +
            (h.address||'').padEnd(36) +
            (h.domain||'').slice(0,23).padEnd(25) +
            (h.countryCode||'??').padEnd(5) +
            String(h.availableInstanceSlots||0).padEnd(7) +
            String(h.totalInstanceSlots||0).padEnd(7) +
            (h.ram||'').slice(0,10).padEnd(12) +
            formatEVR(h.leasePrice).padEnd(12) +
            (h.sashimonoVersion||'?')
        );
    });

    console.log('  ' + '─'.repeat(118));
    console.log(`\n  ${found.length} host(s) listed above, sorted by availability then price.`);
    console.log('  Copy addresses into deploy.sh or cluster-manager.js when prompted.\n');
};

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
