/**
 * v3.0.0 — HotPocket Contract
 *
 * Rules:
 *   - NO timestamp in outputs (causes output hash mismatch across nodes)
 *   - ctx.getConfig() then modify then ctx.updateConfig() with version at top level
 *   - ctx.updatePeers() for live peer connection alongside updateConfig
 */
'use strict';
const HotPocket = require('hotpocket-nodejs-contract');
const AdmZip    = require('adm-zip');
const fs        = require('fs');

const CONTRACT_VERSION       = 'v3.0.1';
const AUTHORIZED_PUBKEY_FILE = 'authorized_pubkey.txt';
const COUNTER_FILE           = 'counter.txt';
const CLUSTER_LOG_FILE       = 'cluster_log.txt';

const ts = () => new Date().toISOString().replace('T',' ').replace(/\..+/,'').replace(/-/g,'');
const log = (...a) => console.log(`${ts()} [${CONTRACT_VERSION}]`, ...a);
const readFile = (f, d='') => { try { return fs.readFileSync(f,'utf8').trim(); } catch { return d; } };
const writeFile = (f,v) => fs.writeFileSync(f, String(v));
const appendLog = (msg) => fs.appendFileSync(CLUSTER_LOG_FILE, `${ts()} ${msg}\n`);
const reply = async (user, obj) => user.send(JSON.stringify(obj));
const errReply = async (user, msg) => reply(user, { type:'error', version:CONTRACT_VERSION, message:msg });

const handleStatus = async (user, ctx, counter) => {
    const unl = ctx.unl.list();
    log(`status ← ${user.publicKey.slice(0,16)}…`);
    await reply(user, {
        type:'status', version:CONTRACT_VERSION, counter,
        lclSeqNo:ctx.lclSeqNo, unlCount:unl.length,
        unl:unl.map(n => n.publicKey)
        // NO timestamp field — causes output hash mismatch
    });
};

const handleUpdateContract = async (user, msg, authPubkey, ctx) => {
    if (user.publicKey !== authPubkey) return errReply(user, 'Unauthorized');
    if (!msg.bundle) return errReply(user, 'Missing bundle');
    log('updateContract — applying bundle...');
    try {
        fs.writeFileSync('pending_update.zip', Buffer.from(msg.bundle,'base64'));
        new AdmZip('pending_update.zip').extractAllTo('.', true);
        fs.unlinkSync('pending_update.zip');
        appendLog(`CONTRACT_UPDATE version=${msg.newVersion||'unknown'} lcl=${ctx.lclSeqNo}`);
        log('Bundle applied. New code active next round.');
        await reply(user, {
            type:'updateContract', version:CONTRACT_VERSION, status:'ok',
            lclSeqNo:ctx.lclSeqNo,
            message:`Contract updated at lcl=${ctx.lclSeqNo}. New code active next round.`
        });
    } catch(e) { log('updateContract error:', e.message); await errReply(user, e.message); }
};

const handleAddNode = async (user, msg, authPubkey, ctx) => {
    if (user.publicKey !== authPubkey) return errReply(user, 'Unauthorized');
    const { pubkey, ip, peerPort } = msg;
    if (!pubkey || !ip || !peerPort) return errReply(user, 'addNode requires: pubkey, ip, peerPort');
    log(`addNode ← ${pubkey.slice(0,16)}… ${ip}:${peerPort}`);
    try {
        const currentUnlKeys = ctx.unl.list().map(n => n.publicKey);
        if (currentUnlKeys.includes(pubkey)) return errReply(user, 'Node already in UNL');
        const updatedUnlKeys = [...currentUnlKeys, pubkey];
        // Get full config — version is required at top level by validateConfig
        const cfg = await ctx.getConfig();
        cfg.unl = updatedUnlKeys;
        await ctx.updateConfig(cfg);
        // Actively initiate peer connection live — no restart needed
        await ctx.updatePeers([`${ip}:${peerPort}`], []);
        appendLog(`NODE_ADDED pubkey=${pubkey} ip=${ip}:${peerPort} lcl=${ctx.lclSeqNo}`);
        log(`Node added — UNL now ${updatedUnlKeys.length}`);
        await reply(user, {
            type:'addNode', version:CONTRACT_VERSION, status:'ok',
            addedPubkey:pubkey, newUnlCount:updatedUnlKeys.length,
            lclSeqNo:ctx.lclSeqNo,
            message:`Node added. UNL is now ${updatedUnlKeys.length}. No restart required.`
        });
    } catch(e) { log('addNode error:', JSON.stringify(e)); await errReply(user, e.message || JSON.stringify(e)); }
};

const handleRemoveNode = async (user, msg, authPubkey, ctx) => {
    if (user.publicKey !== authPubkey) return errReply(user, 'Unauthorized');
    const { pubkey } = msg;
    if (!pubkey) return errReply(user, 'removeNode requires: pubkey');
    log(`removeNode ← ${pubkey.slice(0,16)}…`);
    try {
        const currentUnlKeys = ctx.unl.list().map(n => n.publicKey);
        const updatedUnlKeys = currentUnlKeys.filter(k => k !== pubkey);
        if (updatedUnlKeys.length === currentUnlKeys.length) return errReply(user, 'Node not found in UNL');
        if (updatedUnlKeys.length < 2) return errReply(user, 'Cannot remove — would break quorum');
        const cfg = await ctx.getConfig();
        cfg.unl = updatedUnlKeys;
        await ctx.updateConfig(cfg);
        appendLog(`NODE_REMOVED pubkey=${pubkey} lcl=${ctx.lclSeqNo}`);
        log(`Node removed — UNL now ${updatedUnlKeys.length}`);
        await reply(user, {
            type:'removeNode', version:CONTRACT_VERSION, status:'ok',
            removedPubkey:pubkey, newUnlCount:updatedUnlKeys.length,
            lclSeqNo:ctx.lclSeqNo,
            message:`Node removed. UNL is now ${updatedUnlKeys.length}.`
        });
    } catch(e) { log('removeNode error:', JSON.stringify(e)); await errReply(user, e.message || JSON.stringify(e)); }
};

const contract = async (ctx) => {
    log(`Round start lcl=${ctx.lclSeqNo} readonly=${ctx.readonly}`);
    const authPubkey = readFile(AUTHORIZED_PUBKEY_FILE, '');
    if (!authPubkey) log('WARNING: authorized_pubkey.txt missing');
    let counter = parseInt(readFile(COUNTER_FILE,'0')) || 0;
    if (!ctx.readonly) { counter += 1; writeFile(COUNTER_FILE, counter); log(`Counter → ${counter}`); }
    for (const user of ctx.users.list()) {
        for (const input of user.inputs) {
            let msg;
            try { const buf = await ctx.users.read(input); msg = JSON.parse(buf.toString()); }
            catch(e) { log(`Bad input: ${e.message}`); continue; }
            log(`type="${msg.type}" from ${user.publicKey.slice(0,16)}…`);
            switch(msg.type) {
                case 'status': await handleStatus(user,ctx,counter); break;
                case 'updateContract': if(!ctx.readonly) await handleUpdateContract(user,msg,authPubkey,ctx); break;
                case 'addNode': if(!ctx.readonly) await handleAddNode(user,msg,authPubkey,ctx); break;
                case 'removeNode': if(!ctx.readonly) await handleRemoveNode(user,msg,authPubkey,ctx); break;
                default: await errReply(user, `Unknown type: ${msg.type}`);
            }
        }
    }
    log(`Round end lcl=${ctx.lclSeqNo} counter=${counter}`);
};

const hpc = new HotPocket.Contract();
hpc.init(contract, null, true);
