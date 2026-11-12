#!/usr/bin/env bash
# Deploy gleEmbroidery on the TSB droplet. Run as root (re-execs with sudo):
#   curl -fsSL https://raw.githubusercontent.com/kevinskey/gleembroidery/main/deploy.sh | bash
#
# Clones/updates this repo, builds it, and swaps the build into the nginx root
# that serves threads.tshirtbrothers.com. The previous build is kept next to it
# as <root>.prev, so a bad deploy is one `mv` to undo.
#
# This mirrors StoneCut's deploy.sh deliberately: the two tools are siblings on
# the same droplet, and an operator who has recovered one should recognise the
# other.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E bash -s < <(cat "$0" 2>/dev/null || curl -fsSL https://raw.githubusercontent.com/kevinskey/gleembroidery/main/deploy.sh)
fi

SRC=/var/www/gleembroidery-src
REF="${GLEEMBROIDERY_REF:-main}"
HOST=threads.tshirtbrothers.com
DOCROOT=/var/www/gleembroidery/html

if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch -q origin
else
  git clone -q https://github.com/kevinskey/gleembroidery.git "$SRC"
fi
git -C "$SRC" reset -q --hard "origin/$REF"
cd "$SRC"

echo "==> building gleembroidery $(git rev-parse --short HEAD) ($REF)"
npm install --no-audit --no-fund
if ! npm run build; then
  # npm bug #4828: a macOS lockfile can leave Linux native binaries out of
  # node_modules. A clean reinstall is the documented recovery.
  echo "==> build failed; clean reinstall and retry"
  rm -rf node_modules package-lock.json
  npm install --no-audit --no-fund
  npm run build
fi
[ -f dist/index.html ] || { echo "!! no dist/index.html after build"; exit 1; }

# The engine's own tests run before anything is published. This tool writes
# files that drive a needle through a customer's garment; a deploy that skips
# verification is not a saving.
echo "==> verifying"
npx tsx scripts/selftest.mts
if command -v python3 >/dev/null && python3 -c 'import pyembroidery' 2>/dev/null; then
  npx tsx scripts/fixtures.mts >/dev/null
  python3 scripts/independent-check.py
else
  echo "!! pyembroidery not installed on this host — the independent DST check"
  echo "   and the machine-safety gate did NOT run. Install with:"
  echo "   pip3 install pyembroidery"
fi

mkdir -p "$(dirname "$DOCROOT")"
if [ -d "$DOCROOT" ]; then
  rm -rf "$DOCROOT.prev"
  mv "$DOCROOT" "$DOCROOT.prev"
fi
cp -r dist "$DOCROOT"
chown -R www-data:www-data "$DOCROOT" 2>/dev/null || true

nginx -t && systemctl reload nginx

echo "==> DEPLOYED to https://$HOST"
echo "    bundle: $(grep -o 'index-[A-Za-z0-9_-]*\.js' "$DOCROOT/index.html" | head -1)"
echo "    rollback: rm -rf $DOCROOT && mv $DOCROOT.prev $DOCROOT && systemctl reload nginx"
