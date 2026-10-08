#!/usr/bin/env bash
# =============================================================================
# Deploy / update the news site on Ubuntu 22.04 / 24.04 (run as root).
#
# Lần đầu (cài mới):
#   bash deploy.sh --repo git@github.com:<user>/tiktok-aff.git --domain tenmien.com --email ban@gmail.com
#
# Chưa có tên miền (chạy bằng IP):
#   bash deploy.sh --repo git@github.com:<user>/tiktok-aff.git
#
# Cập nhật code về sau (chạy lại, không cần tham số):
#   bash /var/www/tiktok-aff/deploy.sh
# =============================================================================
set -euo pipefail

APP_NAME="news"
APP_DIR="/var/www/tiktok-aff"
BRANCH="main"
PORT="3000"
NODE_MAJOR="22"
REPO=""
DOMAIN=""
EMAIL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)   REPO="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --email)  EMAIL="$2"; shift 2 ;;
    --dir)    APP_DIR="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --port)   PORT="$2"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Tham số không hợp lệ: $1"; exit 1 ;;
  esac
done

c_green='\033[1;32m'; c_yellow='\033[1;33m'; c_red='\033[1;31m'; c_off='\033[0m'
step() { echo -e "\n${c_green}==> $*${c_off}"; }
warn() { echo -e "${c_yellow}[!] $*${c_off}"; }
die()  { echo -e "${c_red}[x] $*${c_off}"; exit 1; }
# `ssh -T git@github.com` always exits 1, so check its message instead of the exit code
github_ok() { local out; out=$(ssh -o BatchMode=yes -T git@github.com 2>&1 || true); [[ "$out" == *"successfully authenticated"* ]]; }

[[ $EUID -eq 0 ]] || die "Hãy chạy bằng root (hoặc sudo)."
command -v apt-get >/dev/null || die "Script này chỉ hỗ trợ Ubuntu/Debian."
export DEBIAN_FRONTEND=noninteractive

# -----------------------------------------------------------------------------
step "1/9 Cài gói hệ thống"
apt-get update -y
apt-get install -y git nginx build-essential python3 curl ca-certificates ufw

# -----------------------------------------------------------------------------
step "2/9 Kiểm tra swap (tránh hết RAM khi npm install)"
if ! swapon --show | grep -q .; then
  mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  if (( mem_mb < 2048 )); then
    fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "Đã tạo 1GB swap"
  fi
else
  echo "Đã có swap"
fi

# -----------------------------------------------------------------------------
step "3/9 Cài Node.js ${NODE_MAJOR} và PM2"
current_major=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)
if [[ "${current_major:-0}" -lt "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
echo "Node $(node -v), npm $(npm -v)"
command -v pm2 >/dev/null || npm install -g pm2

# -----------------------------------------------------------------------------
step "4/9 Lấy source code"
if [[ -d "$APP_DIR/.git" ]]; then
  cd "$APP_DIR"
  git fetch origin "$BRANCH"
  git reset --hard "origin/$BRANCH"   # data/, uploads/, .env are git-ignored and stay untouched
else
  [[ -n "$REPO" ]] || die "Lần đầu cài cần --repo <link GitHub>."

  if [[ "$REPO" == git@* ]]; then
    mkdir -p ~/.ssh && chmod 700 ~/.ssh
    ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null
    if ! github_ok; then
      [[ -f ~/.ssh/id_ed25519 ]] || ssh-keygen -t ed25519 -N "" -C "deploy@$(hostname)" -f ~/.ssh/id_ed25519
      echo
      warn "VPS chưa có quyền đọc repo GitHub. Thêm key dưới đây vào:"
      warn "GitHub → repo → Settings → Deploy keys → Add deploy key (không cần tick Write access)"
      echo
      cat ~/.ssh/id_ed25519.pub
      echo
      read -rp "Thêm xong thì bấm Enter để tiếp tục... " _
      github_ok || die "Vẫn chưa kết nối được GitHub. Kiểm tra lại deploy key."
    fi
  fi

  mkdir -p "$(dirname "$APP_DIR")"
  git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

# -----------------------------------------------------------------------------
step "5/9 Cài package Node"
if [[ -f package-lock.json ]]; then npm ci --omit=dev; else npm install --omit=dev; fi
mkdir -p data public/uploads

# -----------------------------------------------------------------------------
step "6/9 Tạo file cấu hình .env"
FIRST_ADMIN_PASS=""
if [[ ! -f .env ]]; then
  FIRST_ADMIN_PASS=$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-14)
  cat > .env <<EOF
PORT=${PORT}
SESSION_SECRET=$(openssl rand -hex 32)
ADMIN_USER=admin
ADMIN_PASS=${FIRST_ADMIN_PASS}
EOF
  chmod 600 .env
  echo "Đã tạo .env"
else
  echo ".env đã có, giữ nguyên"
  PORT=$(grep -E '^PORT=' .env | cut -d= -f2 || true)
  PORT=${PORT:-3000}
fi
# Nginx (www-data) needs to read static files directly
chown -R root:root "$APP_DIR"
chmod 755 "$APP_DIR" "$APP_DIR/public" "$APP_DIR/public/uploads"

# -----------------------------------------------------------------------------
step "7/9 Chạy app bằng PM2"
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 reload ecosystem.config.js --update-env
else
  pm2 start ecosystem.config.js
fi
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null
systemctl enable pm2-root >/dev/null 2>&1 || true

# -----------------------------------------------------------------------------
step "8/9 Cấu hình Nginx"
SERVER_NAME="_"
[[ -n "$DOMAIN" ]] && SERVER_NAME="$DOMAIN www.$DOMAIN"
NGINX_CONF="/etc/nginx/sites-available/$APP_NAME"

# Only (re)write the config on first install or when a domain is passed, so certbot's SSL edits are preserved
if [[ ! -f "$NGINX_CONF" || -n "$DOMAIN" ]]; then
  cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${SERVER_NAME};

    client_max_body_size 10M;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    location /uploads/ {
        alias ${APP_DIR}/public/uploads/;
        expires 30d;
        access_log off;
    }

    location /css/ {
        alias ${APP_DIR}/public/css/;
        expires 7d;
        access_log off;
    }

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
EOF
  ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/$APP_NAME"
  rm -f /etc/nginx/sites-enabled/default
fi
nginx -t
systemctl enable nginx >/dev/null 2>&1
systemctl reload nginx

ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
echo "Tường lửa: chỉ mở SSH, HTTP, HTTPS"

# -----------------------------------------------------------------------------
step "9/9 SSL (HTTPS)"
PUBLIC_IP=$(curl -s4 --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')
if [[ -n "$DOMAIN" ]]; then
  DOMAIN_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}' || true)
  if [[ "$DOMAIN_IP" != "$PUBLIC_IP" ]]; then
    warn "Tên miền $DOMAIN đang trỏ về '${DOMAIN_IP:-không có}', không phải IP VPS ($PUBLIC_IP)."
    warn "Trỏ bản ghi A của $DOMAIN và www.$DOMAIN về $PUBLIC_IP, đợi vài phút rồi chạy lại script với --domain."
  elif [[ -z "$EMAIL" ]]; then
    warn "Thiếu --email nên bỏ qua cài SSL."
  else
    apt-get install -y certbot python3-certbot-nginx
    www_flag=()
    getent ahostsv4 "www.$DOMAIN" >/dev/null && www_flag=(-d "www.$DOMAIN")
    certbot --nginx --non-interactive --agree-tos --redirect -m "$EMAIL" -d "$DOMAIN" "${www_flag[@]}"
  fi
else
  echo "Không có --domain, bỏ qua SSL."
fi

# -----------------------------------------------------------------------------
SITE_URL="http://${PUBLIC_IP}"
[[ -n "$DOMAIN" ]] && SITE_URL="https://${DOMAIN}"

echo -e "\n${c_green}================ HOÀN TẤT ================${c_off}"
echo "Website : $SITE_URL"
echo "Admin   : $SITE_URL/admin"
if [[ -n "$FIRST_ADMIN_PASS" ]]; then
  echo "Tài khoản admin: admin / ${FIRST_ADMIN_PASS}"
  warn "Lưu lại mật khẩu này (cũng nằm trong $APP_DIR/.env). Nên đổi trong trang Cài đặt."
  warn "Nếu bạn copy database cũ (data/app.db) lên, mật khẩu là mật khẩu trong database cũ."
fi
echo
echo "Lệnh hữu ích:"
echo "  pm2 logs $APP_NAME        # xem log"
echo "  pm2 restart $APP_NAME     # khởi động lại"
echo "  bash $APP_DIR/deploy.sh   # cập nhật code mới từ GitHub"
