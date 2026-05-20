'use strict';
const HotPocket      = require('hotpocket-nodejs-contract');
const ClusterManager = require('evernode-client-cluster-manager');
const VERSION   = '1.2.1.2';
const contract = async (ctx) => {
    if (await ClusterManager.init(ctx, VERSION)) return;
    if (ctx.readonly) return;
    if (ctx.lclSeqNo % 15 === 0) {
        await ctx.unl.send(JSON.stringify({ type: 'keepalive', lcl: ctx.lclSeqNo }));
    }
};
const hpc = new HotPocket.Contract();
hpc.init(contract);
