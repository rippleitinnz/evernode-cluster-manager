'use strict';
const HotPocket      = require('hotpocket-nodejs-contract');
const ClusterManager = require('evernode-client-cluster-manager');

const VERSION = '1.1.2';

const contract = async (ctx) => {
    if (await ClusterManager.init(ctx, VERSION)) return;
    // Your business logic here
};

const hpc = new HotPocket.Contract();
hpc.init(contract);
