#!/bin/bash
# ============================================================
#  CRMONCE HR System — App Deployment (run after deploy.sh)
#  Run on VPS: bash /var/www/hr-system/deploy-app.sh
# ============================================================
set -e

DOMAIN="hr.crmonce.com"
APP_DIR="/var/www/hr-system"

echo ""
echo "======================================"
echo "  Deploying CRMONCE HR System"
echo "======================================"
echo ""

cd $APP_DIR

# ── 1. Install Backend Dependencies ───────────────────────
echo "[1/5] Installing backend dependencies..."
cd $APP_DIR/backend
npm ci --production
cd $APP_DIR

# ── 2. Build Frontend (if not already built) ──────────────
if [ ! -d "$APP_DIR/frontend/dist" ]; then
  echo "[2/5] Building frontend..."
  cd $APP_DIR/frontend
  npm ci
  npm run build
  cd $APP_DIR
else
  echo "[2/5] Frontend already built — skipping"
fi

# ── 3. Setup Production .env ──────────────────────────────
echo "[3/5] Configuring production environment..."
if [ ! -f "$APP_DIR/backend/.env" ]; then
  cp $APP_DIR/backend/.env.example $APP_DIR/backend/.env
  echo "  ⚠️  Created .env from example — EDIT IT with your actual values!"
  echo "  nano $APP_DIR/backend/.env"
else
  # Update FRONTEND_URL for production
  sed -i "s|FRONTEND_URL=.*|FRONTEND_URL=https://$DOMAIN|g" $APP_DIR/backend/.env
  sed -i "s|NODE_ENV=.*|NODE_ENV=production|g" $APP_DIR/backend/.env
  echo "  ✅ Updated FRONTEND_URL and NODE_ENV in .env"
fi

# ── 4. Nginx Configuration ────────────────────────────────
echo "[4/5] Configuring Nginx..."

cat > /etc/nginx/sites-available/hr-system << 'NGINXCONF'
# Redirect HTTP → HTTPS
server {
    listen 80;
    server_name hr.crmonce.com;
    return 301 https://$host$request_uri;
}

# Main HTTPS server
server {
    listen 443 ssl http2;
    server_name hr.crmonce.com;

    # SSL (Let's Encrypt — will be configured by certbot)
    ssl_certificate     /etc/letsencrypt/live/hr.crmonce.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hr.crmonce.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # Security headers
    add_header X-Frame-Options           "SAMEORIGIN"   always;
    add_header X-XSS-Protection          "1; mode=block" always;
    add_header X-Content-Type-Options    "nosniff"       always;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;

    # Gzip
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    # React frontend
    root /var/www/hr-system/frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2|woff|ttf)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # API proxy
    location /api/ {
        proxy_pass         http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }

    # Socket.io
    location /socket.io/ {
        proxy_pass         http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_read_timeout 3600s;
    }

    # Uploads
    location /uploads/ {
        alias /var/www/hr-system/backend/uploads/;
        expires 7d;
    }

    location ~ /\. { deny all; }
}
NGINXCONF

ln -sf /etc/nginx/sites-available/hr-system /etc/nginx/sites-enabled/hr-system
rm -f /etc/nginx/sites-enabled/default

# First start without SSL (for certbot)
cat > /etc/nginx/sites-available/hr-system-temp << 'TEMPCONF'
server {
    listen 80;
    server_name hr.crmonce.com;
    root /var/www/hr-system/frontend/dist;
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
    location /api/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
    location /socket.io/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
TEMPCONF

# Use temp config first (no SSL)
cp /etc/nginx/sites-available/hr-system-temp /etc/nginx/sites-enabled/hr-system
nginx -t && systemctl restart nginx
echo "  ✅ Nginx configured (HTTP mode)"

# ── 5. Start App with PM2 ────────────────────────────────
echo "[5/5] Starting app with PM2..."
cd $APP_DIR
pm2 delete hr-backend 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

echo ""
echo "======================================"
echo "  ✅ Deployment complete!"
echo "======================================"
echo ""
echo "App running at: http://$DOMAIN"
echo ""
echo "REMAINING STEPS:"
echo ""
echo "1. Point DNS: Add A record for 'hr' → 157.173.220.90"
echo "   at your domain registrar for crmonce.com"
echo ""
echo "2. After DNS propagates, get SSL certificate:"
echo "   certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m admin@crmonce.com"
echo ""
echo "3. Then restore full Nginx config:"
echo "   cp /etc/nginx/sites-available/hr-system /etc/nginx/sites-enabled/hr-system"
echo "   nginx -t && systemctl reload nginx"
echo ""
echo "4. Verify: https://$DOMAIN"
echo ""
