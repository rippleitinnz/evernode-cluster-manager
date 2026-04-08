#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
#  Evernode Cluster Manager — Deploy Script
#  Deploys a new cluster dynamically.
#  Usage: bash deploy.sh
# ══════════════════════════════════════════════════════════════

# ── Find .env ─────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/config/.env"
NODES_FILE="$PROJECT_DIR/config/cluster-nodes.json"

if [ ! -f "$ENV_FILE" ]; then
    echo "✗ Config not found at $ENV_FILE"
    echo "  Run setup.sh first."
    exit 1
fi

set -a; source "$ENV_FILE"; set +a

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║       Evernode Cluster Manager — Deploy             ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "  Config    : $ENV_FILE"
echo "  Round time: ${HP_ROUNDTIME}ms"
echo "  Threshold : ${HP_THRESHOLD}%"
echo "  Log level : ${HP_LOG_LEVEL}"
echo ""

# ── How many nodes? ───────────────────────────────────────────
while true; do
    read -rp "  How many nodes? (default $DEFAULT_NODE_COUNT, minimum 3): " NODE_COUNT
    NODE_COUNT="${NODE_COUNT:-$DEFAULT_NODE_COUNT}"
    if [[ "$NODE_COUNT" =~ ^[0-9]+$ ]] && [ "$NODE_COUNT" -ge 3 ]; then break; fi
    echo "  Must be a number >= 3."
done

# ── Collect host addresses ────────────────────────────────────
echo ""
echo "  Enter $NODE_COUNT host XRPL address(es)."
echo "  Repeat the same address to deploy multiple nodes on one host."
echo ""

HOSTS_FILE=$(mktemp)
declare -a HOST_ADDRS
for i in $(seq 1 "$NODE_COUNT"); do
    while true; do
        read -rp "  Host $i XRPL address: " HOST_ADDR
        if [[ -n "$HOST_ADDR" ]]; then
            echo "$HOST_ADDR" >> "$HOSTS_FILE"
            HOST_ADDRS+=("$HOST_ADDR")
            break
        fi
        echo "  Cannot be empty."
    done
done

# ── How many moments? ─────────────────────────────────────────
echo ""
while true; do
    read -rp "  Life moments per node? (default $DEFAULT_MOMENTS): " MOMENTS
    MOMENTS="${MOMENTS:-$DEFAULT_MOMENTS}"
    if [[ "$MOMENTS" =~ ^[0-9]+$ ]] && [ "$MOMENTS" -ge 1 ]; then break; fi
    echo "  Must be a number >= 1."
done

# ── Summary ───────────────────────────────────────────────────
echo ""
echo "── Summary ───────────────────────────────────────────────"
echo "  Nodes   : $NODE_COUNT"
echo "  Moments : $MOMENTS (~${MOMENTS}hr per node)"
echo "  Hosts   :"
cat "$HOSTS_FILE" | nl -w4 -s'. '
echo ""
read -rp "  Proceed? (yes/y): " CONFIRM
if [[ "$CONFIRM" != "yes" && "$CONFIRM" != "y" ]]; then
    echo "  Cancelled."
    rm -f "$HOSTS_FILE"
    exit 0
fi
echo ""

# ── Step 1 — Install contract dependencies ────────────────────
echo "[1/4] Installing contract dependencies..."
npm install --prefix "$PROJECT_DIR/contract" --silent
echo "      ✓ node_modules installed."
echo ""

# ── Step 2 — Write authorized_pubkey.txt ─────────────────────
echo "[2/4] Writing authorized_pubkey.txt..."
echo "$EV_USER_PUBLIC_KEY" > "$PROJECT_DIR/contract/authorized_pubkey.txt"
echo "      ✓ $EV_USER_PUBLIC_KEY"
echo ""

# ── Step 3 — Install client dependencies ─────────────────────
echo "[3/4] Installing client dependencies..."
npm install --prefix "$PROJECT_DIR/client" --silent
echo "      ✓ Done."
echo ""

# ── Step 4 — Deploy cluster ───────────────────────────────────
echo "[4/4] Running evdevkit cluster-create ($NODE_COUNT nodes, $MOMENTS moments)..."
unset EV_HP_OVERRIDE_CFG_PATH
export EV_HP_INIT_CFG_PATH="$PROJECT_DIR/config/hp-init.cfg"

sudo -E evdevkit cluster-create "$NODE_COUNT" -m "$MOMENTS" \
    "$PROJECT_DIR/contract" \
    /usr/bin/node \
    "$HOSTS_FILE" \
    -a index.js 2>&1 | tee "$PROJECT_DIR/cluster-info.json"

rm -f "$HOSTS_FILE"

# ── Extract contract ID ───────────────────────────────────────
CONTRACT_ID=$(grep -o 'contract_id.*' "$PROJECT_DIR/cluster-info.json" | grep -o '[0-9a-f-]\{36\}' | head -1)

# ── Save cluster-nodes.json ───────────────────────────────────
if [[ -n "$CONTRACT_ID" ]]; then
    echo ""
    echo "  Saving node details to cluster-nodes.json..."

    # Parse cluster-info.json with node to extract node details
    node -e "
const fs = require('fs');
const raw = fs.readFileSync('$PROJECT_DIR/cluster-info.json', 'utf8');
// Extract the JSON array from evdevkit output
const start = raw.indexOf('[');
const end = raw.lastIndexOf(']');
if (start === -1 || end === -1) { console.error('Could not parse cluster info'); process.exit(1); }
const arr = eval('(' + raw.slice(start, end+1) + ')');
const moments = $MOMENTS;
const momentSeconds = 3600;
const nodes = arr.map(n => ({
    pubkey: n.pubkey,
    name: n.name,
    host: n.host,
    domain: n.domain,
    userPort: parseInt(n.user_port),
    peerPort: parseInt(n.peer_port),
    createdTimestamp: n.created_timestamp,
    lifeMoments: moments
}));
fs.writeFileSync('$NODES_FILE', JSON.stringify(nodes, null, 2));
console.log('  ✓ Saved ' + nodes.length + ' node(s) to cluster-nodes.json');
nodes.forEach((n,i) => {
    const expiry = new Date((Math.floor(n.createdTimestamp/1000) + (n.lifeMoments * momentSeconds)) * 1000);
    console.log('    [' + i + '] ' + n.pubkey.slice(0,20) + '… expires ' + expiry.toUTCString());
});
" 2>/dev/null || echo "  ⚠ Could not save cluster-nodes.json — add nodes manually via cluster-manager."
fi

# ── Done ──────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║              Deployment Complete!                   ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
if [[ -n "$CONTRACT_ID" ]]; then
    echo "  Contract ID : $CONTRACT_ID"
    echo ""
    echo "  Manage your cluster:"
    echo "    node $PROJECT_DIR/client/cluster-manager.js <ip> <user_port> $CONTRACT_ID"
    echo ""
else
    echo "  ✗ Could not parse contract ID — check $PROJECT_DIR/cluster-info.json"
    echo ""
    echo "  Manage your cluster:"
    echo "    node $PROJECT_DIR/client/cluster-manager.js <ip> <user_port> <contract_id>"
    echo ""
fi
