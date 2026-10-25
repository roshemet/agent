#!/usr/bin/env bash
# Sets up the finance-cloud scraper on a Debian 13 machine (a Google Cloud VM, or a
# mini-PC at home). One command, as root, on the box:
#
#   sudo bash /opt/finance-scraper/scripts/scrape/linux/setup-debian.sh
#
# It installs Debian's Chromium and the TPM libraries, then Node from nodejs.org (checked
# against the checksum pinned below), then hands over to `finance-scraper setup`
# (scripts/scrape/box.mjs), which checks everything before it changes anything. Safe to
# run again: it skips what is done.
set -euo pipefail

# Node 24 LTS (supported to 2028-04-30). Change both lines together, on purpose: the
# checksum is node-<version>-linux-x64.tar.gz's line in nodejs.org/dist/<version>/SHASUMS256.txt.
NODE_VERSION=v24.21.0
NODE_SHA256=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff
REPO=/opt/finance-scraper

die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "Run it as root: sudo bash $0"
[ -f "$REPO/scripts/scrape/box.mjs" ] || die "The code must be in $REPO first (scripts/scrape/README.md, \"The scraper box\", step 4)."
. /etc/os-release
if [ "${ID:-}" != debian ] || [ "${VERSION_ID:-}" != 13 ]; then
  echo "⚠ This is ${PRETTY_NAME:-an unknown system}, not Debian 13: the package names below are Debian 13's."
fi
[ "$(dpkg --print-architecture)" = amd64 ] || die "This needs an x86-64 machine: the scraper's browser is not built for $(dpkg --print-architecture) here."

echo "Step 1/2: Debian packages (Chromium, the TPM libraries)…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || die "apt-get update failed. Is the machine online? (On Google Cloud it goes out through Cloud NAT.)"
# Debian 13 names the TPM libraries with a version and a t64 suffix
# (libtss2-esys-3.0.2-0t64 …): find them rather than guess.
tss=()
for lib in esys rc mu tcti-device; do
  pkg=$(apt-cache search --names-only "^libtss2-${lib}[-0-9.]*0(t64)?\$" | awk '{print $1}' | sort -r | head -n1)
  [ -n "$pkg" ] || die "No package found for the TPM library libtss2-${lib}. Is this Debian 13?"
  tss+=("$pkg")
done
apt-get install -y -qq --no-install-recommends ca-certificates curl git chromium fonts-liberation "${tss[@]}" >/dev/null \
  || die "apt-get install failed (its message is above)."
missing=""
for so in libtss2-esys.so.0 libtss2-rc.so.0 libtss2-mu.so.0 libtss2-tcti-device.so.0; do
  ldconfig -p | grep -q "$so" || missing="$missing $so"
done
[ -z "$missing" ] || die "Installed ${tss[*]}, but these TPM libraries are still missing:$missing"
echo "  ✓ $(chromium --version 2>/dev/null || echo 'Chromium') · TPM libraries: ${tss[*]}"

echo "Step 2/2: Node $NODE_VERSION (the official build, checked against its pinned checksum)…"
if [ "$(/opt/node/bin/node --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL --retry 3 -o "$tmp/node.tar.gz" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.gz" \
    || die "Could not download Node from nodejs.org."
  echo "$NODE_SHA256  $tmp/node.tar.gz" | sha256sum -c --quiet - \
    || die "The Node download does not match its pinned checksum. Nothing was installed."
  rm -rf /opt/node.new
  mkdir -p /opt/node.new
  # --no-same-owner: the archive's files belong to uid 1001, which may be a real user here,
  # and the scraper's key passes through this node binary.
  tar -xzf "$tmp/node.tar.gz" -C /opt/node.new --strip-components=1 --no-same-owner
  chown -R root:root /opt/node.new
  rm -rf /opt/node
  mv /opt/node.new /opt/node
fi
echo "  ✓ Node $(/opt/node/bin/node --version) in /opt/node"

# Fetch updates later through the same read-only deploy key the clone used.
if [ -f /root/.ssh/finance-cloud-deploy ]; then
  git -C "$REPO" config core.sshCommand "ssh -i /root/.ssh/finance-cloud-deploy -o IdentitiesOnly=yes"
fi

exec /opt/node/bin/node "$REPO/scripts/scrape/box.mjs" setup "$@"
