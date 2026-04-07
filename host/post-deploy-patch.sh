#!/usr/bin/env bash
# v3.0 — host/post-deploy-patch.sh
# HOST SIDE ONLY. Run after client/deploy.sh.
# Usage: bash /home/chris/v3.0/host/post-deploy-patch.sh <contract_id>
CONTRACT_ID="${1}"
[ -z "$CONTRACT_ID" ] && echo "Usage: bash post-deploy-patch.sh <contract_id>" && exit 1
echo ""; echo "╔══════════════════════════════════════════╗"
echo "║    v3.0 — Host Post-Deploy Patch         ║"; echo "╚══════════════════════════════════════════╝"
echo "Contract ID: $CONTRACT_ID"; echo ""
evernode list | python3 -c "
import json,sys,subprocess
data=json.load(sys.stdin)
for i in data:
    if i['contract_id']!='$CONTRACT_ID': continue
    name=i['name']; sashi=i['user']; port=i['user_port']
    cfg=f'/home/{sashi}/{name}/cfg/hp.cfg'
    print(f'Patching {name[:16]}... port={port}')
    with open(cfg) as f: c=json.load(f)
    c['log']['log_level']='dbg'
    c['contract']['round_limits']['user_input_bytes']=10485760
    c['contract']['round_limits']['user_output_bytes']=10485760
    c['contract']['round_limits']['npl_output_bytes']=10485760
    with open(cfg,'w') as f: json.dump(c,f,indent=4)
    cid=subprocess.check_output(['sudo','-u',sashi,'docker','ps','-aq'],text=True).strip()
    r=subprocess.run(['sudo','-u',sashi,'docker','restart',cid],capture_output=True,text=True)
    print('  Restarted.' if r.returncode==0 else f'  Error: {r.stderr}')
"
echo ""; echo "Done. Verify:"; echo "  watch -n 3 'bash /home/chris/v3.0/host/check-consensus.sh $CONTRACT_ID'"
