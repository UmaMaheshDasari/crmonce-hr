#!/bin/bash
# ============================================================
#  CRMONCE HR System — Hostinger VPS Deployment
#  Domain: hr.crmonce.com | IP: 157.173.220.90
#
#  Run this script on the VPS as root:
#    bash deploy.sh
# ============================================================
set -e

DOMAIN="hr.crmonce.com"
APP_DIR="/var/www/hr-system"
NODE_VERSION="20"

echo ""
echo "======================================"
echo "  CRMONCE HR System — VPS Setup"
echo "  Domain: $DOMAIN"
echo "======================================"
echo ""

# ── 1. System Update ──────────────────────────────────────
echo "[1/8] Updating system..."
apt-get update -y && apt-get upgrade -y
apt-get install -y curl git nginx certbot python3-certbot-nginx ufw build-essential unzip

# ── 2. Node.js 20 ─────────────────────────────────────────
echo ""
echo "[2/8] Installing Node.js $NODE_VERSION..."
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y nodejs
fi
echo "  Node: $(node -v) | npm: $(npm -v)"

# ── 3. PM2 ─────────────────────────────────────────────────
echo ""
echo "[3/8] Installing PM2..."
npm install -g pm2
pm2 startup systemd -u root --hp /root 2>/dev/null | tail -1 | bash 2>/dev/null || true

# ── 4. Firewall ────────────────────────────────────────────
echo ""
echo "[4/8] Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw allow 9922/tcp  # ZKTeco device push port
ufw --force enable

# ── 5. App Directory ───────────────────────────────────────
echo ""
echo "[5/8] Setting up app directory..."
mkdir -p $APP_DIR
mkdir -p /var/log/hr-system

echo ""
echo "======================================"
echo "  System setup complete!"
echo "======================================"
echo ""
echo "NEXT: Upload the project files to $APP_DIR"
echo ""
echo "From your LOCAL PC, run:"
echo "  scp -r /path/to/hr-system/* root@157.173.220.90:$APP_DIR/"
echo ""
echo "Then run: bash $APP_DIR/deploy-app.sh"
echo ""
