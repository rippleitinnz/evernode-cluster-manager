'use strict';
const HotPocket = require('hotpocket-nodejs-contract');
const fs = require('fs');
const child_process = require('child_process');

const VERSION   = '13.1.0';

const BUNDLE          = 'bundle.zip';
const HP_CFG_OVERRIDE = 'hp.cfg.override';
const CONTRACT_CFG    = 'contract.config';
const INSTALL_SCRIPT  = 'install.sh';
const PATH_CFG        = '../patch.cfg';
const BACKUP_PATH_CFG = '../patch.cfg.bk';
const HP_POST_EXEC    = 'post_exec.sh';
const POST_EXEC_ERR   = 'post_exec.err';
const BACKUP_PREFIX   = 'backup';
const MAX_BACKUPS     = 5;

const log  = (...a) => console.log(`[${VERSION}]`, ...a);
const send = async (user, obj) => user.send(obj);

let postExecErrors = {};

const loadPostExecErrors = () => {
    if (!fs.existsSync(POST_EXEC_ERR)) return;
    try { postExecErrors = JSON.parse(fs.readFileSync(POST_EXEC_ERR, 'utf8')); } catch { postExecErrors = {}; }
    fs.rmSync(POST_EXEC_ERR);
};

const pruneOldBackups = () => {
    try {
        const entries = fs.readdirSync('.', { withFileTypes: true });
        const backups = entries
            .filter(e => e.isDirectory() && e.name.startsWith(`${BACKUP_PREFIX}-`))
            .map(e => e.name).sort();
        const excess = backups.length - MAX_BACKUPS;
        for (let i = 0; i < excess; i++) {
            child_process.execSync(`rm -rf ./${backups[i]}`);
            log(`Removed old backup: ${backups[i]}`);
        }
    } catch(e) { log('Prune backups warning:', e.message); }
};

const handleStatus = async (user, ctx) => {
    log('status → sending reply');
    await send(user, {
        type: 'status', version: VERSION, lcl: ctx.lclSeqNo,
        readonly: ctx.readonly, contractId: ctx.contractId, publicKey: ctx.publicKey
    });
};

const handleReadPatchCfg = async (user, ctx) => {
    log('readPatchCfg -> reading patch.cfg via ctx.getConfig()');
    try {
        const cfg = await ctx.getConfig();
        await send(user, { type: 'readPatchCfg', version: VERSION, lcl: ctx.lclSeqNo, cfg });
    } catch(e) {
        log('readPatchCfg error:', e.message);
        await send(user, { type: 'error', message: e.message });
    }
};
const handleReadEnvVars = async (user, ctx) => {
    log('readEnvVars -> reading /contract/env.vars');
    try {
        const raw = fs.readFileSync('/contract/env.vars', 'utf8');
        await send(user, { type: 'readEnvVars', version: VERSION, lcl: ctx.lclSeqNo, content: raw });
    } catch(e) {
        if (e.code === 'ENOENT') {
            await send(user, { type: 'readEnvVars', version: VERSION, lcl: ctx.lclSeqNo, content: '(env.vars not present on this host — standard Sashimono installation)' });
        } else {
            log('readEnvVars error:', e.message);
            await send(user, { type: 'error', message: e.message });
        }
    }
};
const handleReadCfg = async (user, ctx) => {
    log('readCfg → reading /contract/cfg/hp.cfg');
    try {
        const raw = fs.readFileSync('/contract/cfg/hp.cfg', 'utf8');
        const cfg = JSON.parse(raw);
        log('readCfg → sending reply');
        await send(user, { type: 'readCfg', version: VERSION, lcl: ctx.lclSeqNo, cfg });
    } catch(e) {
        log('readCfg error:', e.message);
        await send(user, { type: 'error', message: e.message });
    }
};

const handleUpgrade = async (user, bundleBase64, ctx) => {
    log('upgrade → starting');
    const backup = `${BACKUP_PREFIX}-${ctx.timestamp}`;
    try {
        child_process.execSync(`mkdir -p ../${backup} && cp -r ./* ../${backup}/ 2>/dev/null || true`);
        pruneOldBackups();
        log('upgrade → backup created:', backup);

        fs.writeFileSync(BUNDLE, Buffer.from(bundleBase64, 'base64'), { mode: 0o644 });
        child_process.execSync(`/usr/bin/unzip -o ${BUNDLE} && rm -f ${BUNDLE}`);
        log('upgrade → bundle extracted');

        let hpCfg = {};
        if (fs.existsSync(HP_CFG_OVERRIDE)) {
            hpCfg = JSON.parse(fs.readFileSync(HP_CFG_OVERRIDE, 'utf8'));
            fs.rmSync(HP_CFG_OVERRIDE);
        }

        if (hpCfg.contract) {
            let contractCfg = {};
            if (fs.existsSync(CONTRACT_CFG))
                contractCfg = JSON.parse(fs.readFileSync(CONTRACT_CFG, 'utf8'));
            contractCfg = { ...contractCfg, ...hpCfg.contract };
            // Always set log level to dbg so hp.log is generated on all nodes
            contractCfg.log = { log_level: 'dbg' };
            fs.writeFileSync(CONTRACT_CFG, JSON.stringify(contractCfg, null, 2), { mode: 0o644 });
            log('upgrade → contract.config updated');
        }

        if (hpCfg.mesh?.known_peers?.length > 0) {
            await ctx.updatePeers(hpCfg.mesh.known_peers);
            log('upgrade → peers updated');
        }

        const postExecScript = `#!/bin/bash
cp ${PATH_CFG} ${BACKUP_PATH_CFG}

function print_err() {
    local error=$1
    log=$(jq . ${POST_EXEC_ERR})
    for key in $(jq -c 'keys[]' <<<$log); do
        log=$(jq ".$key = \\"$error\\"" <<<$log)
    done
    echo $log >${POST_EXEC_ERR}
}

function rollback() {
    [ -f ${BACKUP_PATH_CFG} ] && mv ${BACKUP_PATH_CFG} ${PATH_CFG}
    return 0
}

function upgrade() {
    [ -f "${CONTRACT_CFG}" ] && jq -s '.[0] * (.[1] | del(.unl))' ${PATH_CFG} ${CONTRACT_CFG} > /tmp/hp-patch-tmp.cfg && mv /tmp/hp-patch-tmp.cfg ${PATH_CFG}
    # Set log level to dbg so hp.log is generated
    jq '.log.log_level = "dbg"' ${PATH_CFG} > /tmp/hp-patch-tmp.cfg && mv /tmp/hp-patch-tmp.cfg ${PATH_CFG}
    jq '.log.log_level = "dbg"' /contract/cfg/hp.cfg > /tmp/hp-cfg-tmp.cfg && mv /tmp/hp-cfg-tmp.cfg /contract/cfg/hp.cfg
    if [ -f "${INSTALL_SCRIPT}" ]; then
        echo "${INSTALL_SCRIPT} found. Executing..."
        chmod +x ${INSTALL_SCRIPT}
        ./${INSTALL_SCRIPT}
        installcode=$?
        rm ${INSTALL_SCRIPT}
        if [ "$installcode" -eq "0" ]; then
            echo "${INSTALL_SCRIPT} executed successfully."
            return 0
        else
            echo "${INSTALL_SCRIPT} ended with exit code: $installcode"
            print_err "InstallScriptFailed"
            return 1
        fi
    fi
}

upgrade
upgradecode=$?

if [ "$upgradecode" -eq "0" ]; then
    echo "Upgrade successful."
else
    echo "Upgrade failed. Rolling back."
    rollback
fi

exit $?
`;
        postExecErrors[user.publicKey] = 'success';
        fs.writeFileSync(POST_EXEC_ERR, JSON.stringify(postExecErrors, null, 2), { mode: 0o644 });
        fs.writeFileSync(HP_POST_EXEC, postExecScript, { mode: 0o777 });
        log('upgrade → post_exec.sh written');

        await send(user, { type: 'upgradeResult', status: 'ok', version: VERSION });
    } catch(e) {
        log('upgrade error:', e.message);
        try { child_process.execSync(`cp -r ./${backup}/* ./ && rm -rf ./${backup}`); } catch {}
        await send(user, { type: 'upgradeResult', status: 'error', error: e.message });
    }
};

const handleRemovePeer = async (user, msg, ctx) => {
    const { peerIp, peerPort } = msg;
    if (!peerIp || !peerPort) { await send(user, { type: 'error', message: 'removePeer requires peerIp and peerPort' }); return; }
    log(`removePeer → ${peerIp}:${peerPort}`);
    try {
        await ctx.updatePeers([], [`${peerIp}:${peerPort}`]);
        log(`removePeer → done`);
        await send(user, { type: 'removePeer', status: 'ok', version: VERSION });
    } catch(e) {
        log('removePeer error:', e.message);
        await send(user, { type: 'error', message: e.message });
    }
};

const handleAddNode = async (user, msg, ctx) => {
    const { pubkey, ip, peerPort } = msg;
    if (!pubkey || !ip || !peerPort) {
        await send(user, { type: 'error', message: 'addNode requires pubkey, ip, peerPort' });
        return;
    }
    log(`addNode → ${pubkey.slice(0,16)}... ${ip}:${peerPort}`);
    try {
        const cfg = await ctx.getConfig();
        if (cfg.unl.includes(pubkey)) {
            await send(user, { type: 'error', message: 'Node already in UNL' });
            return;
        }
        cfg.unl.push(pubkey);
        await ctx.updateConfig(cfg);
        await ctx.updatePeers([`${ip}:${peerPort}`]);
        log(`addNode → UNL now ${cfg.unl.length}`);
        await send(user, { type: 'addNode', status: 'ok', version: VERSION, newUnlCount: cfg.unl.length, lcl: ctx.lclSeqNo });
    } catch(e) {
        log('addNode error:', e.message);
        await send(user, { type: 'error', message: e.message });
    }
};

const handleRemoveNode = async (user, msg, ctx) => {
    const { pubkey } = msg;
    if (!pubkey) {
        await send(user, { type: 'error', message: 'removeNode requires pubkey' });
        return;
    }
    log(`removeNode → ${pubkey.slice(0,16)}...`);
    try {
        const cfg = await ctx.getConfig();
        const updated = cfg.unl.filter(k => k !== pubkey);
        if (updated.length === cfg.unl.length) {
            await send(user, { type: 'error', message: 'Node not found in UNL' });
            return;
        }
        if (updated.length < 2) {
            await send(user, { type: 'error', message: 'Cannot remove — would break quorum' });
            return;
        }
        cfg.unl = updated;
        await ctx.updateConfig(cfg);
        if (msg.ip && msg.peerPort) {
            await ctx.updatePeers([], [`${msg.ip}:${msg.peerPort}`]);
            log(`removeNode → removed peer ${msg.ip}:${msg.peerPort}`);
        }
        log(`removeNode → UNL now ${cfg.unl.length}`);
        await send(user, { type: 'removeNode', status: 'ok', version: VERSION, newUnlCount: cfg.unl.length, lcl: ctx.lclSeqNo });
    } catch(e) {
        log('removeNode error:', e.message);
        await send(user, { type: 'error', message: e.message });
    }
};

const contract = async (ctx) => {
    log(`lcl=${ctx.lclSeqNo} readonly=${ctx.readonly}`);
    loadPostExecErrors();

    for (const user of ctx.users.list()) {
        if (postExecErrors[user.publicKey]) {
            if (postExecErrors[user.publicKey] !== 'success') {
                await send(user, { type: 'upgradeResult', status: 'error', error: postExecErrors[user.publicKey] });
            }
            delete postExecErrors[user.publicKey];
        }

        for (const input of user.inputs) {
            let msg;
            try {
                const buf = await ctx.users.read(input);
                msg = JSON.parse(buf.toString());
            } catch(e) { log('Bad input:', e.message); continue; }

            log(`type="${msg.type}" readonly=${ctx.readonly} from ${user.publicKey.slice(0,16)}...`);

            if (ctx.readonly) {
                switch (msg.type) {
                    case 'status':  await handleStatus(user, ctx); break;
                    case 'readCfg': await handleReadCfg(user, ctx); break;
                    case 'readPatchCfg': await handleReadPatchCfg(user, ctx); break;
                    case 'readEnvVars': await handleReadEnvVars(user, ctx); break;
                    case 'readContractLog':
                        try {
                            const n = parseInt(msg.lines) || 100;
                            const logFile = msg.logFile === 'stderr' ? 'rw.stderr.log' : 'rw.stdout.log';
                            const lines = child_process.execSync(`tail -${n} /contract/log/contract/${logFile} 2>/dev/null || echo "no log"`).toString();
                            await send(user, { type: 'readContractLog', version: VERSION, logFile, lines });
                        } catch(e) { await send(user, { type: 'error', message: e.message }); }
                        break;
                    case 'readLog':
                        try {
                            const n = parseInt(msg.lines) || 100;
                            const lines = child_process.execSync(`tail -${n} /contract/log/hp.log 2>/dev/null || echo "no log"`).toString();
                            await send(user, { type: 'readLog', version: VERSION, lines });
                        } catch(e) { await send(user, { type: 'error', message: e.message }); }
                        break;
                    case 'readContractLog':
                        try {
                            const n = parseInt(msg.lines) || 100;
                            const logFile = msg.logFile === 'stderr' ? 'rw.stderr.log' : 'rw.stdout.log';
                            const lines = child_process.execSync(`tail -${n} /contract/log/contract/${logFile} 2>/dev/null || echo "no log"`).toString();
                            await send(user, { type: 'readContractLog', version: VERSION, logFile, lines });
                        } catch(e) { await send(user, { type: 'error', message: e.message }); }
                        break;
                    case 'readLog':
                        try {
                            const n = parseInt(msg.lines) || 100;
                            const lines = child_process.execSync(`tail -${n} /contract/log/hp.log 2>/dev/null || echo "no log"`).toString();
                            await send(user, { type: 'readLog', version: VERSION, lines });
                        } catch(e) { await send(user, { type: 'error', message: e.message }); }
                        break;
                    default: await send(user, { type: 'error', message: `Unknown readonly type: ${msg.type}` });
                }
            } else {
                switch (msg.type) {
                    case 'status':     await handleStatus(user, ctx); break;
                    case 'upgrade':    await handleUpgrade(user, msg.bundle, ctx); break;
                    case 'addNode':    await handleAddNode(user, msg, ctx); break;
                    case 'removeNode': await handleRemoveNode(user, msg, ctx); break;
                    case 'removePeer':  await handleRemovePeer(user, msg, ctx); break;
                    default: await send(user, { type: 'error', message: `Unknown type: ${msg.type}` });
                }
            }
        }
    }
};

const hpc = new HotPocket.Contract();
hpc.init(contract);
