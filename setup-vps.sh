#!/bin/bash
# ============================================================
#  HR System — Hostinger VPS Initial Setup Script
#  Run as root on a fresh Ubuntu 22.04 VPS:
#    chmod +x setup-vps.sh && ./setup-vps.sh
# ============================================================
set -e

DOMAIN="hr.crmonce.com"
APP_DIR="/var/www/hr-system"
NODE_VERSION="20"

echo "======================================"
echo "  HR System VPS Setup"
echo "======================================"

# ── 1. System update ───────────────────────────────────────
echo -e "\n[1/9] Updating system packages..."
apt-get update -y && apt-get upgrade -y
apt-get install -y curl git nginx certbot python3-certbot-nginx ufw build-essential

# ── 2. Node.js ─────────────────────────────────────────────
echo -e "\n[2/9] Installing Node.js $NODE_VERSION..."
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
apt-get install -y nodejs
node -v && npm -v

# ── 3. PM2 ─────────────────────────────────────────────────
echo -e "\n[3/9] Installing PM2..."
npm install -g pm2
pm2 startup systemd -u root --hp /root | tail -1 | bash

# ── 4. Redis ───────────────────────────────────────────────
echo -e "\n[4/9] Installing Redis..."
apt-get install -y redis-server
systemctl enable redis-server
systemctl start redis-server

# ── 5. PostgreSQL ──────────────────────────────────────────
echo -e "\n[5/9] Installing PostgreSQL..."
apt-get install -y postgresql postgresql-contrib
systemctl enable postgresql
systemctl start postgresql
sudo -u postgres psql -c "CREATE DATABASE hr_system;" 2>/dev/null || echo "DB may already exist"
sudo -u postgres psql -c "CREATE USER hr_user WITH ENCRYPTED PASSWORD 'YourStrongPassword123!';" 2>/dev/null || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE hr_system TO hr_user;" 2>/dev/null || true

# ── 6. Firewall ────────────────────────────────────────────
echo -e "\n[6/9] Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# ── 7. App directory ───────────────────────────────────────
echo -e "\n[7/9] Setting up app directory..."
mkdir -p $APP_DIR/backend/uploads
mkdir -p $APP_DIR/frontend/dist
mkdir -p /var/log/hr-system

# Clone your repo (update URL)
if [ ! -d "$APP_DIR/.git" ]; then
  echo "  → Clone your repo: git clone https://github.com/youruser/hr-system $APP_DIR"
  echo "  → Then run: cd $APP_DIR && git checkout main"
fi

# ── 8. Nginx config ────────────────────────────────────────
echo -e "\n[8/9] Configuring Nginx..."
if [ -f "$APP_DIR/nginx.conf" ]; then
  # Replace placeholder domain
  sed "s/yourdomain.com/$DOMAIN/g" $APP_DIR/nginx.conf > /etc/nginx/sites-available/hr-system
  ln -sf /etc/nginx/sites-available/hr-system /etc/nginx/sites-enabled/hr-system
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
  echo "  ✅ Nginx configured"
else
  echo "  ⚠️  nginx.conf not found in $APP_DIR — copy it manually"
fi

# ── 9. SSL Certificate ─────────────────────────────────────
echo -e "\n[9/9] SSL Certificate (Let's Encrypt)..."
echo "  Run this after pointing your domain DNS to this VPS IP:"
echo "  certbot --nginx -d $DOMAIN -d www.$DOMAIN --non-interactive --agree-tos -m admin@$DOMAIN"

# ── Done ───────────────────────────────────────────────────
echo -e "\n======================================"
echo "  ✅ VPS setup complete!"
echo "======================================"
echo ""
echo "Next steps:"
echo "  1. Upload your code to $APP_DIR"
echo "  2. Copy .env.example to .env and fill in your values"
echo "  3. cd $APP_DIR/backend && npm ci --production"
echo "  4. cd $APP_DIR/frontend && npm ci && npm run build"
echo "  5. pm2 start $APP_DIR/ecosystem.config.js"
echo "  6. pm2 save"
echo "  7. node $APP_DIR/backend/scripts/setup-d365-entities.js"
echo "  8. node $APP_DIR/backend/scripts/seed.js"
echo "  9. Run certbot for SSL"
echo ""
