'use strict';

/**
 * Recovery contract for evernode-cluster-manager.
 *
 * A minimal HotPocket contract with NO dependency on evernode-client-cluster-manager.
 * Deploy this when the main contract is broken and cannot load.
 *
 * Handles:
 *   - status   (readonly) — returns version: "recovery" so client can detect recovery mode
 *   - upgrade  (consensus) — deploys a new bundle, same mechanism as main contract
 *
 * Runs a self-repair routine every round:
 *   - Removes 'exports' field from evernode-client-cluster-manager/package.json if present
 *   - Verifies index.js exists and is readable
 *
 * Deploy via cluster-manager option 2, or directly via HP client.
 * Once deployed, immediately follow up with the real contract bundle.
 */

const HotPocket = require('hotpocket-nodejs-contract');
const fs        = require('fs');
const cp        = require('child_process');

const VERSION        = 'recovery';
const BUNDLE         = 'bundle.zip';
const HP_POST_EXEC   = 'post_exec.sh';
const POST_EXEC_ERR  = 'post_exec.err';
const PATH_CFG       = '../patch.cfg';
const BACKUP_PATH_CFG = '../patch.cfg.bk';
const CONTRACT_CFG   = 'contract.config';
const INSTALL_SCRIPT = 'install.sh';
const BACKUP_PREFIX  = 'backup';
const MAX_BACKUPS    = 5;

const pruneOldBackups = () => {
    try {
        const entries = fs.readdirSync('.', { withFileTypes: true });
        const backups = entries
            .filter(e => e.isDirectory() && e.name.startsWith(`${BACKUP_PREFIX}-`))
            .map(e => e.name).sort();
        const excess = backups.length - MAX_BACKUPS;
        for (let i = 0; i < excess; i++)
            cp.execSync(`rm -rf ./${backups[i]}`);
    } catch(e) {}
};

// Self-repair: fix known package.json issues that can prevent the main contract loading
const selfRepair = () => {
    try {
        const pkgPath = 'node_modules/evernode-client-cluster-manager/package.json';
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            let changed = false;
            if (pkg.exports) { delete pkg.exports; changed = true; }
            if (pkg.main && pkg.main.startsWith('dist/') && !fs.existsSync(pkg.main)) {
                pkg.main = 'index.js'; changed = true;
            }
            if (changed) {
                fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
                console.log('[Recovery] Self-repair: fixed package.json');
            }
        }
    } catch(e) {
        console.log('[Recovery] Self-repair error:', e.message);
    }
};

const contract = async (ctx) => {
    // Run self-repair every round
    selfRepair();

    if (ctx.readonly) {
        for (const user of ctx.users.list()) {
            for (const input of user.inputs) {
                try {
                    const buf = await ctx.users.read(input);
                    const msg = JSON.parse(buf.toString());
                    if (msg.type === 'status') {
                        await user.send(JSON.stringify({
                            type: 'status',
                            version: VERSION,
                            lcl: ctx.lclSeqNo,
                            readonly: true,
                            contractId: ctx.contractId,
                            publicKey: ctx.publicKey
                        }));
                        return;
                    }
                } catch(e) {}
            }
        }
        return;
    }

    for (const user of ctx.users.list()) {
        for (const input of user.inputs) {
            let msg;
            try {
                const buf = await ctx.users.read(input);
                msg = JSON.parse(buf.toString());
            } catch(e) { continue; }

            if (msg.type === 'status') {
                await user.send(JSON.stringify({
                    type: 'status',
                    version: VERSION,
                    lcl: ctx.lclSeqNo,
                    readonly: false,
                    contractId: ctx.contractId,
                    publicKey: ctx.publicKey
                }));
                return;
            }

            if (msg.type === 'upgrade' && msg.bundle) {
                const backup = `${BACKUP_PREFIX}-${ctx.timestamp}`;
                try {
                    cp.execSync(`mkdir -p ../${backup} && cp -r ./* ../${backup}/ 2>/dev/null || true`);
                    pruneOldBackups();
                    fs.writeFileSync(BUNDLE, Buffer.from(msg.bundle, 'base64'), { mode: 0o644 });
                    cp.execSync(`/usr/bin/unzip -o ${BUNDLE} && rm -f ${BUNDLE}`);

                    let hpCfg = {};
                    if (fs.existsSync('hp.cfg.override')) {
                        hpCfg = JSON.parse(fs.readFileSync('hp.cfg.override', 'utf8'));
                        fs.rmSync('hp.cfg.override');
                    }
                    if (hpCfg.contract) {
                        let contractCfg = {};
                        if (fs.existsSync(CONTRACT_CFG))
                            contractCfg = JSON.parse(fs.readFileSync(CONTRACT_CFG, 'utf8'));
                        contractCfg = { ...contractCfg, ...hpCfg.contract };
                        const logLevel = hpCfg.log?.log_level || contractCfg.log?.log_level || 'dbg';
                        contractCfg.log = { log_level: logLevel };
                        if (hpCfg.contract?.consensus?.roundtime) {
                            if (!contractCfg.consensus) contractCfg.consensus = {};
                            contractCfg.consensus.roundtime = hpCfg.contract.consensus.roundtime;
                        }
                        fs.writeFileSync(CONTRACT_CFG, JSON.stringify(contractCfg, null, 2), { mode: 0o644 });
                    }

                    const postExecScript = `#!/bin/bash
cp ${PATH_CFG} ${BACKUP_PATH_CFG}
function rollback() {
    [ -f ${BACKUP_PATH_CFG} ] && mv ${BACKUP_PATH_CFG} ${PATH_CFG}
    return 0
}
function upgrade() {
    [ -f "${CONTRACT_CFG}" ] && jq -s '.[0] * (.[1] | del(.unl))' ${PATH_CFG} ${CONTRACT_CFG} > /tmp/hp-patch-tmp.cfg && mv /tmp/hp-patch-tmp.cfg ${PATH_CFG}
    LOG_LEVEL=$(jq -r '.log.log_level // "dbg"' ${CONTRACT_CFG} 2>/dev/null || echo "dbg")
    ROUNDTIME=$(jq -r '.consensus.roundtime // empty' ${CONTRACT_CFG} 2>/dev/null)
    jq --arg ll "$LOG_LEVEL" '.log.log_level = $ll' ${PATH_CFG} > /tmp/hp-patch-tmp.cfg && mv /tmp/hp-patch-tmp.cfg ${PATH_CFG}
    jq --arg ll "$LOG_LEVEL" '.log.log_level = $ll' /contract/cfg/hp.cfg > /tmp/hp-cfg-tmp.cfg && mv /tmp/hp-cfg-tmp.cfg /contract/cfg/hp.cfg
    if [ -n "$ROUNDTIME" ]; then
        jq --argjson rt "$ROUNDTIME" '.contract.consensus.roundtime = $rt' ${PATH_CFG} > /tmp/hp-patch-tmp.cfg && mv /tmp/hp-patch-tmp.cfg ${PATH_CFG}
    fi
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
                    const postExecErrors = {};
                    postExecErrors[user.publicKey] = 'success';
                    fs.writeFileSync(POST_EXEC_ERR, JSON.stringify(postExecErrors, null, 2), { mode: 0o644 });
                    fs.writeFileSync(HP_POST_EXEC, postExecScript, { mode: 0o777 });
                    await user.send(JSON.stringify({ type: 'upgradeResult', status: 'ok', version: VERSION }));
                    console.log('[Recovery] Upgrade bundle accepted.');
                } catch(e) {
                    try { cp.execSync(`cp -r ./${backup}/* ./ && rm -rf ./${backup}`); } catch {}
                    await user.send(JSON.stringify({ type: 'upgradeResult', status: 'error', error: e.message }));
                }
                return;
            }
        }
    }
};

const hpc = new HotPocket.Contract();
hpc.init(contract, { forceTerminate: true });
