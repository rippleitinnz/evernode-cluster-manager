#!/usr/bin/env bash
# v3.0 — deploy.sh
# Deploys a cluster dynamically — prompts for hosts and node count via CLI
# No host addresses hardcoded.

P="/home/chris/v3.0"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║        v3.0 — Cluster Deploy             ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Load env ──────────────────────────────────────────────────────────────────
set -a; source "$P/.env"; set +a

# ── How many nodes? ───────────────────────────────────────────────────────────
while true; do
    read -rp "How many nodes to deploy? (minimum 3): " NODE_COUNT
    if [[ "$NODE_COUNT" =~ ^[0-9]+$ ]] && [ "$NODE_COUNT" -ge 3 ]; then
        break
    fi
    echo "  Must be a number >= 3."
done

# ── Collect host addresses ────────────────────────────────────────────────────
echo ""
echo "Enter $NODE_COUNT host XRPL address(es)."
echo "You can repeat the same host address to deploy multiple nodes on one host."
echo ""

HOSTS_FILE=$(mktemp)
for i in $(seq 1 "$NODE_COUNT"); do
    while true; do
        read -rp "  Host $i XRPL address: " HOST_ADDR
        if [[ -n "$HOST_ADDR" ]]; then
            echo "$HOST_ADDR" >> "$HOSTS_FILE"
            break
        fi
        echo "  Cannot be empty."
    done
done

echo ""
echo "── Summary ──────────────────────────────────────────"
echo "  Nodes     : $NODE_COUNT"
echo "  Hosts     :"
cat "$HOSTS_FILE" | nl -w4 -s'. '
echo ""

# ── How many moments? ─────────────────────────────────────────────────────────
while true; do
    read -rp "Life moments per node? (minimum 3 recommended): " MOMENTS
    if [[ "$MOMENTS" =~ ^[0-9]+$ ]] && [ "$MOMENTS" -ge 1 ]; then
        break
    fi
    echo "  Must be a number >= 1."
done

echo ""
read -rp "Proceed with deployment? (yes/no): " CONFIRM
if [[ "$CONFIRM" != "yes" && "$CONFIRM" != "y" ]]; then
    echo "  Cancelled."
    rm -f "$HOSTS_FILE"
    exit 0
fi

echo ""

# ── Step 1 — Install contract dependencies ────────────────────────────────────
echo "[1/4] Installing contract dependencies (node_modules into contract/)..."
npm install --prefix "$P/contract" --silent
echo "      Done — node_modules will be included in bundle."
echo ""

# ── Step 2 — Write authorized_pubkey.txt ─────────────────────────────────────
echo "[2/4] Writing authorized_pubkey.txt..."
echo "$EV_USER_PUBLIC_KEY" > "$P/contract/authorized_pubkey.txt"
echo "      $EV_USER_PUBLIC_KEY"
echo ""

# ── Step 3 — Install client dependencies ─────────────────────────────────────
echo "[3/4] Installing client dependencies..."
npm install --prefix "$P/client" --silent
echo "      Done."
echo ""

# ── Step 4 — Deploy cluster ───────────────────────────────────────────────────
echo "[4/4] Running evdevkit cluster-create ($NODE_COUNT nodes, $MOMENTS moments)..."
unset EV_HP_OVERRIDE_CFG_PATH
export EV_HP_INIT_CFG_PATH="$P/hp-init.cfg"
sudo -E evdevkit cluster-create "$NODE_COUNT" -m "$MOMENTS" \
    "$P/contract" \
    /usr/bin/node \
    "$HOSTS_FILE" \
    -a index.js 2>&1 | tee "$P/cluster-info.json"

rm -f "$HOSTS_FILE"

# ── Extract contract ID from output ──────────────────────────────────────────
CONTRACT_ID=$(grep -o 'contract_id.*' "$P/cluster-info.json" | grep -o '[0-9a-f-]\{36\}' | head -1)

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║         Deployment Complete!             ║"
echo "╚══════════════════════════════════════════╝"
echo ""
if [[ -n "$CONTRACT_ID" ]]; then
    echo "  Contract ID : $CONTRACT_ID"
    echo ""
    echo "► HOST: bash $P/host/post-deploy-patch.sh $CONTRACT_ID"
    echo "► Then: node $P/client/cluster-manager.js evernode.onledger.net <user_port>"
else
    echo "  Could not parse contract ID from output — check $P/cluster-info.json"
    echo ""
    echo "► HOST: bash $P/host/post-deploy-patch.sh <contract_id>"
    echo "► Then: node $P/client/cluster-manager.js evernode.onledger.net <user_port>"
fi
echo ""
