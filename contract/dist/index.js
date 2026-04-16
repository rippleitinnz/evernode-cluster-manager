/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ({

/***/ 875:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ({

/***/ 782:
/***/ ((__unused_webpack_module, __webpack_exports__, __nccwpck_require2_) => {

"use strict";
__nccwpck_require2_.r(__webpack_exports__);
/* harmony export */ __nccwpck_require2_.d(__webpack_exports__, {
/* harmony export */   "controlMessages": () => (/* binding */ controlMessages),
/* harmony export */   "clientProtocols": () => (/* binding */ clientProtocols),
/* harmony export */   "constants": () => (/* binding */ constants),
/* harmony export */   "writeAsync": () => (/* binding */ writeAsync),
/* harmony export */   "writevAsync": () => (/* binding */ writevAsync),
/* harmony export */   "readAsync": () => (/* binding */ readAsync),
/* harmony export */   "invokeCallback": () => (/* binding */ invokeCallback),
/* harmony export */   "errHandler": () => (/* binding */ errHandler)
/* harmony export */ });
const fs = __nccwpck_require2_(147);

const controlMessages = {
    peerChangeset: "peer_changeset"
}
Object.freeze(controlMessages);

const clientProtocols = {
    json: "json",
    bson: "bson"
}
Object.freeze(clientProtocols);

const constants = {
    MAX_SEQ_PACKET_SIZE: 128 * 1024,
    PATCH_CONFIG_PATH: "../patch.cfg",
    POST_EXEC_SCRIPT_NAME: "post_exec.sh"
}
Object.freeze(constants);

function writeAsync(fd, buf) {
    return new Promise(resolve => fs.write(fd, buf, resolve));
}
function writevAsync(fd, bufList) {
    return new Promise(resolve => fs.writev(fd, bufList, resolve));
}
function readAsync(fd, buf, offset, size) {
    return new Promise(resolve => fs.read(fd, buf, 0, size, offset, resolve));
}

async function invokeCallback(callback, ...args) {
    if (!callback)
        return;

    if (callback.constructor.name === 'AsyncFunction') {
        await callback(...args).catch(errHandler);
    }
    else {
        callback(...args);
    }
}

function errHandler(err) {
    console.log(err);
}

/***/ }),

/***/ 244:
/***/ ((__unused_webpack_module, __webpack_exports__, __nccwpck_require2_) => {

"use strict";
// ESM COMPAT FLAG
__nccwpck_require2_.r(__webpack_exports__);

// EXPORTS
__nccwpck_require2_.d(__webpack_exports__, {
  "HotPocketContract": () => (/* binding */ HotPocketContract)
});

// EXTERNAL MODULE: ./src/common.js
var common = __nccwpck_require2_(782);
;// CONCATENATED MODULE: ./src/patch-config.js


const fs = __nccwpck_require2_(147);

// Handles patch config manipulation.
class PatchConfig {

    // Loads the config value if there's a patch config file. Otherwise throw error.
    getConfig() {
        if (!fs.existsSync(common.constants.PATCH_CONFIG_PATH))
            throw "Patch config file does not exist.";

        return new Promise((resolve, reject) => {
            fs.readFile(common.constants.PATCH_CONFIG_PATH, 'utf8', function (err, data) {
                if (err) reject(err);
                else resolve(JSON.parse(data));
            });
        });
    }

    updateConfig(config) {

        this.validateConfig(config);

        return new Promise((resolve, reject) => {
            // Format json to match with the patch.cfg json format created by HP at the startup.
            fs.writeFile(common.constants.PATCH_CONFIG_PATH, JSON.stringify(config, null, 4), (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    validateConfig(config) {
        // Validate all config fields.
        if (!config.version)
            throw "Contract version is not specified.";
        if (!config.unl || !config.unl.length)
            throw "UNL list cannot be empty.";
        for (let publicKey of config.unl) {
            // Public keys are validated against length, ed prefix and hex characters.
            if (!publicKey.length)
                throw "UNL public key not specified.";
            else if (!(/^(e|E)(d|D)[0-9a-fA-F]{64}$/g.test(publicKey)))
                throw "Invalid UNL public key specified.";
        }
        if (!config.bin_path || !config.bin_path.length)
            throw "Binary path cannot be empty.";
        if (config.consensus.mode != "public" && config.consensus.mode != "private")
            throw "Invalid consensus mode configured in patch file. Valid values: public|private";
        if (config.consensus.roundtime < 1 && config.consensus.roundtime > 3600000)
            throw "Round time must be between 1 and 3600000ms inclusive.";
        if (config.consensus.stage_slice < 1 || config.consensus.stage_slice > 33)
            throw "Stage slice must be between 1 and 33 percent inclusive.";
        if (config.consensus.threshold < 1 || config.consensus.threshold > 100)
            throw "Consensus threshold must be between 1 and 100 percent inclusive.";
        if (config.npl.mode != "public" && config.npl.mode != "private")
            throw "Invalid npl mode configured in patch file. Valid values: public|private";
        if (config.round_limits.user_input_bytes < 0 || config.round_limits.user_output_bytes < 0 || config.round_limits.npl_output_bytes < 0 ||
            config.round_limits.proc_cpu_seconds < 0 || config.round_limits.proc_mem_bytes < 0 || config.round_limits.proc_ofd_count < 0)
            throw "Invalid round limits.";
        if (config.max_input_ledger_offset < 0)
            throw "Invalid max input ledger offset";
    }
}
;// CONCATENATED MODULE: ./src/contract-context.js



// HotPocket contract context which is passed into every smart contract invocation.

class ContractContext {

    #patchConfig = null;
    #controlChannel = null;

    constructor(hpargs, users, unl, controlChannel) {
        this.#patchConfig = new PatchConfig();
        this.#controlChannel = controlChannel;
        this.contractId = hpargs.contract_id;
        this.publicKey = hpargs.public_key;
        this.privateKey = hpargs.private_key;
        this.readonly = hpargs.readonly;
        this.timestamp = hpargs.timestamp;
        this.users = users;
        this.unl = unl; // Not available in readonly mode.
        this.lclSeqNo = hpargs.lcl_seq_no; // Not available in readonly mode.
        this.lclHash = hpargs.lcl_hash; // Not available in readonly mode.
    }

    // Returns the config values in patch config.
    getConfig() {
        return this.#patchConfig.getConfig();
    }

    // Updates the config with given config object and save the patch config.
    updateConfig(config) {
        return this.#patchConfig.updateConfig(config);
    }

    // Updates the known-peers this node must attempt connections to.
    // toAdd: Array of strings containing peers to be added. Each string must be in the format of "<ip>:<port>".
    updatePeers(toAdd, toRemove) {
        return this.#controlChannel.send({
            type: common.controlMessages.peerChangeset,
            add: toAdd || [],
            remove: toRemove || []
        });
    }
}
;// CONCATENATED MODULE: ./src/control.js
const control_fs = __nccwpck_require2_(147);


class ControlChannel {

    #fd = null;
    #readStream = null;

    constructor(fd) {
        this.#fd = fd;
    }

    consume(onMessage) {

        if (this.#readStream)
            throw "Control channel already consumed.";

        this.#readStream = control_fs.createReadStream(null, { fd: this.#fd, highWaterMark: common.constants.MAX_SEQ_PACKET_SIZE });
        this.#readStream.on("data", onMessage);
        this.#readStream.on("error", (err) => { });
    }

    send(obj) {
        const buf = Buffer.from(JSON.stringify(obj));
        if (buf.length > common.constants.MAX_SEQ_PACKET_SIZE)
            throw ("Control message exceeds max size " + common.constants.MAX_SEQ_PACKET_SIZE);
        return (0,common.writeAsync)(this.#fd, buf);
    }

    close() {
        this.#readStream && this.#readStream.close();
    }
}
;// CONCATENATED MODULE: ./src/npl.js


const npl_fs = __nccwpck_require2_(147);

// Represents the node-party-line that can be used to communicate with unl nodes.
class NplChannel {

    #fd = null;
    #readStream = null;

    constructor(fd) {
        this.#fd = fd;
    }

    consume(onMessage) {

        if (this.#readStream)
            throw "NPL channel already consumed.";

        this.#readStream = npl_fs.createReadStream(null, { fd: this.#fd, highWaterMark: common.constants.MAX_SEQ_PACKET_SIZE });

        // When hotpocket is sending the npl messages, first it sends the public key of the particular node
        // and then the message, First data buffer is taken as public key and the second one as message,
        // then npl message object is constructed and the event is emmited.
        let publicKey = null;

        this.#readStream.on("data", (data) => {
            if (!publicKey) {
                publicKey = data.toString();
            }
            else {
                onMessage(publicKey, data);
                publicKey = null;
            }
        });

        this.#readStream.on("error", (err) => { });
    }

    send(msg) {
        const buf = Buffer.from(msg);
        if (buf.length > common.constants.MAX_SEQ_PACKET_SIZE)
            throw ("NPL message exceeds max size " + common.constants.MAX_SEQ_PACKET_SIZE);
        return (0,common.writeAsync)(this.#fd, buf);
    }

    close() {
        this.#readStream && this.#readStream.close();
    }
}

;// CONCATENATED MODULE: ./src/unl.js


class UnlCollection {

    #readonly = null;
    #pendingTasks = null;
    #channel = null;

    constructor(readonly, unl, channel, pendingTasks) {
        this.nodes = {};
        this.#readonly = readonly;
        this.#pendingTasks = pendingTasks;

        if (!readonly) {
            for (const [publicKey, stat] of Object.entries(unl)) {
                this.nodes[publicKey] = new UnlNode(publicKey, stat.active_on);
            }

            this.#channel = channel;
        }
    }

    // Returns the unl node for the specified public key. Returns null if not found.
    find(publicKey) {
        return this.nodes[publicKey];
    }

    // Returns all the unl nodes.
    list() {
        return Object.values(this.nodes);
    }

    count() {
        return Object.keys(this.nodes).length;
    }

    // Registers for NPL messages.
    onMessage(callback) {

        if (this.#readonly)
            throw "NPL messages not available in readonly mode.";

        this.#channel.consume((publicKey, msg) => {
            this.#pendingTasks.push((0,common.invokeCallback)(callback, this.nodes[publicKey], msg));
        });
    }

    // Broadcasts a message to all unl nodes (including self if self is part of unl).
    async send(msg) {
        if (this.#readonly)
            throw "NPL messages not available in readonly mode.";

        await this.#channel.send(msg);
    }
}

// Represents a node that's part of unl.
class UnlNode {

    constructor(publicKey, activeOn) {
        this.publicKey = publicKey;
        this.activeOn = activeOn;
    }
}
;// CONCATENATED MODULE: ./src/user.js


class UsersCollection {

    #users = {};
    #infd = null;

    constructor(userInputsFd, usersObj, clientProtocol) {
        this.#infd = userInputsFd;

        Object.entries(usersObj).forEach(([publicKey, arr]) => {

            const outfd = arr[0]; // First array element is the output fd.
            arr.splice(0, 1); // Remove first element (output fd). The rest are pairs of msg offset/length tuples.

            const channel = new UserChannel(outfd, clientProtocol);
            this.#users[publicKey] = new User(publicKey, channel, arr);
        });
    }

    // Returns the User for the specified public key. Returns null if not found.
    find(publicKey) {
        return this.#users[publicKey]
    }

    // Returns all the currently connected users.
    list() {
        return Object.values(this.#users);
    }

    count() {
        return Object.keys(this.#users).length;
    }

    async read(input) {
        const [offset, size] = input;
        const buf = Buffer.alloc(size);
        await (0,common.readAsync)(this.#infd, buf, offset, size);
        return buf;
    }
}

class User {

    #channel = null;

    constructor(publicKey, channel, inputs) {
        this.publicKey = publicKey;
        this.inputs = inputs;
        this.#channel = channel;
    }

    async send(msg) {
        await this.#channel.send(msg);
    }
}

class UserChannel {

    #outfd = null;
    #clientProtocol = null;

    constructor(outfd, clientProtocol) {
        this.#outfd = outfd;
        this.#clientProtocol = clientProtocol;
    }

    send(msg) {
        const messageBuf = this.serialize(msg);
        let headerBuf = Buffer.alloc(4);
        // Writing message length in big endian format.
        headerBuf.writeUInt32BE(messageBuf.byteLength)
        return (0,common.writevAsync)(this.#outfd, [headerBuf, messageBuf]);
    }

    serialize(msg) {

        if (!msg)
            throw "Cannot serialize null content.";

        if (Buffer.isBuffer(msg))
            return msg;
        else if (this.#clientProtocol == common.clientProtocols.bson)
            return Buffer.from(msg);
        else // json
            return Buffer.from(JSON.stringify(msg));
    }
}
;// CONCATENATED MODULE: ./src/hotpocket-contract.js







const hotpocket_contract_fs = __nccwpck_require2_(147);
const tty = __nccwpck_require2_(224);

class HotPocketContract {

    #controlChannel = null;
    #clientProtocol = null;
    #forceTerminate = false;

    init(contractFunc, clientProtocol = common.clientProtocols.json, forceTerminate = false) {

        return new Promise(resolve => {
            if (this.#controlChannel) { // Already initialized.
                resolve(false);
                return;
            }

            this.#clientProtocol = clientProtocol;

            // Check whether we are running on a console and provide error.
            if (tty.isatty(process.stdin.fd)) {
                console.error("Error: HotPocket smart contracts must be executed via HotPocket.");
                resolve(false);
                return;
            }

            this.#forceTerminate = forceTerminate;

            // Parse HotPocket args.
            hotpocket_contract_fs.readFile(process.stdin.fd, 'utf8', (err, argsJson) => {
                const hpargs = JSON.parse(argsJson);
                this.#controlChannel = new ControlChannel(hpargs.control_fd);
                this.#executeContract(hpargs, contractFunc);
                resolve(true);
            });
        });
    }

    #executeContract(hpargs, contractFunc) {
        // Keeps track of all the tasks (promises) that must be awaited before the termination.
        const pendingTasks = [];
        const nplChannel = new NplChannel(hpargs.npl_fd);

        const users = new UsersCollection(hpargs.user_in_fd, hpargs.users, this.#clientProtocol);
        const unl = new UnlCollection(hpargs.readonly, hpargs.unl, nplChannel, pendingTasks);
        const executionContext = new ContractContext(hpargs, users, unl, this.#controlChannel);

        (0,common.invokeCallback)(contractFunc, executionContext).catch(common.errHandler).finally(() => {
            // Wait for any pending tasks added during execution.
            Promise.all(pendingTasks).catch(common.errHandler).finally(() => {
                nplChannel.close();
                this.#terminate();
            });
        });
    }

    #terminate() {
        this.#controlChannel.close();
        if (this.#forceTerminate)
            process.kill(process.pid, 'SIGINT');
    }
}

/***/ }),

/***/ 53:
/***/ ((module, __unused_webpack_exports, __nccwpck_require2_) => {

const { clientProtocols, constants } = __nccwpck_require2_(782);
const { HotPocketContract } = __nccwpck_require2_(244);

module.exports = {
    Contract: HotPocketContract,
    clientProtocols,
    POST_EXEC_SCRIPT_NAME: constants.POST_EXEC_SCRIPT_NAME,
}

/***/ }),

/***/ 147:
/***/ ((module) => {

"use strict";
module.exports = __nccwpck_require__(147);

/***/ }),

/***/ 224:
/***/ ((module) => {

"use strict";
module.exports = __nccwpck_require__(224);

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __nccwpck_require2_(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		var threw = true;
/******/ 		try {
/******/ 			__webpack_modules__[moduleId](module, module.exports, __nccwpck_require2_);
/******/ 			threw = false;
/******/ 		} finally {
/******/ 			if(threw) delete __webpack_module_cache__[moduleId];
/******/ 		}
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/define property getters */
/******/ 	(() => {
/******/ 		// define getter functions for harmony exports
/******/ 		__nccwpck_require2_.d = (exports, definition) => {
/******/ 			for(var key in definition) {
/******/ 				if(__nccwpck_require2_.o(definition, key) && !__nccwpck_require2_.o(exports, key)) {
/******/ 					Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 				}
/******/ 			}
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	(() => {
/******/ 		__nccwpck_require2_.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	(() => {
/******/ 		// define __esModule on exports
/******/ 		__nccwpck_require2_.r = (exports) => {
/******/ 			if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 				Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 			}
/******/ 			Object.defineProperty(exports, '__esModule', { value: true });
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/compat */
/******/ 	
/******/ 	if (typeof __nccwpck_require2_ !== 'undefined') __nccwpck_require2_.ab = __dirname + "/";
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	var __webpack_exports__ = __nccwpck_require2_(53);
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;

/***/ }),

/***/ 81:
/***/ ((module) => {

"use strict";
module.exports = require("child_process");

/***/ }),

/***/ 147:
/***/ ((module) => {

"use strict";
module.exports = require("fs");

/***/ }),

/***/ 224:
/***/ ((module) => {

"use strict";
module.exports = require("tty");

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __nccwpck_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		var threw = true;
/******/ 		try {
/******/ 			__webpack_modules__[moduleId](module, module.exports, __nccwpck_require__);
/******/ 			threw = false;
/******/ 		} finally {
/******/ 			if(threw) delete __webpack_module_cache__[moduleId];
/******/ 		}
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/compat */
/******/ 	
/******/ 	if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = __dirname + "/";
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
// This entry need to be wrapped in an IIFE because it need to be in strict mode.
(() => {
"use strict";

const HotPocket = __nccwpck_require__(875);
const fs = __nccwpck_require__(147);
const child_process = __nccwpck_require__(81);

const VERSION   = '10.0.0';

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

const handleReadCfg = async (user, ctx) => {
    log('readCfg → reading patch.cfg');
    try {
        const cfg = await ctx.getConfig();
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

})();

module.exports = __webpack_exports__;
/******/ })()
;