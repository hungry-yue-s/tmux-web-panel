# Installs tmux-web-panel on a machine another panel manages over SSH.
#
# Not run directly: the managing panel uploads the source archive over SFTP,
# then streams this script to `sh -s` with these variables prepended:
#   TWP_ARCHIVE        archive path relative to $HOME (.cache/tmux-web-panel/panel.tgz)
#   TWP_PORT_CANDIDATES ports to try for the panel, first free wins
#   TWP_SUDO_PASSWORD  optional; only used for `sudo -S` when packages are missing
#
# Result: the panel runs as a user service bound to 127.0.0.1 in node-only
# mode, reachable only through the managing panel's SSH tunnel. Output lines
# starting with ">> " are progress steps; "TWP_RESULT=" is the final status.

set -eu

log() { printf '>> %s\n' "$*"; }
result() { printf 'TWP_RESULT=%s\n' "$1"; }
fail() { printf '!! %s\n' "$*" >&2; result failed; exit 1; }

PREFIX="$HOME/.local/share/tmux-web-panel"
APP="$PREFIX/app"
NODE_VERSION="22.12.0"
OS="$(uname -s)"
MACHINE="$(uname -m)"
PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin"
export PATH

# --- Privilege for package installs -----------------------------------------
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; return; fi
  if ! command -v sudo >/dev/null 2>&1; then return 1; fi
  if sudo -n true 2>/dev/null; then sudo -n "$@"; return; fi
  if [ -n "${TWP_SUDO_PASSWORD:-}" ]; then
    printf '%s\n' "$TWP_SUDO_PASSWORD" | sudo -S -p '' "$@"
    return
  fi
  result needs_password
  printf '!! installing packages needs sudo; provide the sudo password\n' >&2
  exit 3
}

# --- What tmux and the panel need ------------------------------------------
missing_tools() {
  for tool in git make autoconf automake bison pkg-config tar curl cc; do
    command -v "$tool" >/dev/null 2>&1 || printf '%s ' "$tool"
  done
  if command -v pkg-config >/dev/null 2>&1; then
    pkg-config --exists libevent_core || printf 'libevent '
    pkg-config --exists libutf8proc || printf 'utf8proc '
    if [ "$OS" = Darwin ]; then
      # macOS ships ncurses without a pkg-config file; the tmux build uses it directly.
      pkg-config --exists jemalloc || printf 'jemalloc '
    else
      { pkg-config --exists ncursesw || pkg-config --exists ncurses || pkg-config --exists tinfo; } || printf 'ncurses '
    fi
  fi
}

install_packages() {
  if [ "$OS" = Darwin ]; then
    command -v brew >/dev/null 2>&1 || fail "Homebrew is required on macOS: https://brew.sh"
    xcode-select -p >/dev/null 2>&1 || fail "Xcode Command Line Tools are required: run xcode-select --install"
    log "brew install build dependencies"
    brew install git autoconf automake bison pkg-config libevent utf8proc jemalloc
    return
  fi
  if command -v apt-get >/dev/null 2>&1; then
    log "apt-get install build dependencies"
    as_root env DEBIAN_FRONTEND=noninteractive apt-get update -y
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y git build-essential autoconf automake bison pkg-config libevent-dev libutf8proc-dev libncurses-dev curl tar
  elif command -v dnf >/dev/null 2>&1; then
    log "dnf install build dependencies"
    as_root dnf install -y git gcc make autoconf automake bison pkgconf-pkg-config libevent-devel utf8proc-devel ncurses-devel curl tar
  elif command -v yum >/dev/null 2>&1; then
    log "yum install build dependencies"
    as_root yum install -y git gcc make autoconf automake bison pkgconfig libevent-devel utf8proc-devel ncurses-devel curl tar
  elif command -v pacman >/dev/null 2>&1; then
    log "pacman install build dependencies"
    as_root pacman -S --needed --noconfirm git base-devel autoconf automake bison pkgconf libevent libutf8proc ncurses curl tar
  elif command -v apk >/dev/null 2>&1; then
    log "apk add build dependencies"
    as_root apk add git build-base autoconf automake bison pkgconf libevent-dev utf8proc-dev ncurses-dev curl tar bash
  elif command -v zypper >/dev/null 2>&1; then
    log "zypper install build dependencies"
    as_root zypper --non-interactive install git gcc make autoconf automake bison pkg-config libevent-devel utf8proc-devel ncurses-devel curl tar
  else
    fail "no supported package manager; install: $(missing_tools)"
  fi
}

# --- Node.js: an official build under $PREFIX, unless a recent one exists ----
node_major() { "$1" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0; }

ensure_node() {
  if command -v node >/dev/null 2>&1 && [ "$(node_major node)" -ge 20 ]; then
    NODE_BIN="$(command -v node)"
    NPM="npm"
    return
  fi
  case "$OS" in Linux) node_os=linux ;; Darwin) node_os=darwin ;; *) fail "unsupported OS $OS" ;; esac
  case "$MACHINE" in x86_64|amd64) node_arch=x64 ;; aarch64|arm64) node_arch=arm64 ;; *) fail "unsupported CPU $MACHINE" ;; esac
  dir="$PREFIX/node-v$NODE_VERSION-$node_os-$node_arch"
  if [ ! -x "$dir/bin/node" ]; then
    log "download Node.js $NODE_VERSION"
    mkdir -p "$PREFIX"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$node_os-$node_arch.tar.gz" | tar -xz -C "$PREFIX"
  fi
  NODE_BIN="$dir/bin/node"
  NPM="$NODE_BIN $dir/lib/node_modules/npm/bin/npm-cli.js"
  # npm lifecycle scripts invoke node by name, including node-pty's installer.
  PATH="$dir/bin:$PATH"
  export PATH
}

port_in_use() {
  if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | grep -q "[:.]$1 "; return; fi
  if command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; return; fi
  netstat -an 2>/dev/null | grep LISTEN | grep -q "[:.]$1 "
}

# --- Steps ------------------------------------------------------------------
[ -f "$HOME/$TWP_ARCHIVE" ] || fail "archive missing: $TWP_ARCHIVE"

need="$(missing_tools)"
if [ -n "$need" ]; then
  log "missing: $need"
  install_packages
  need="$(missing_tools)"
  [ -z "$need" ] || fail "still missing after install: $need"
fi

ensure_node
log "node $("$NODE_BIN" -v)"

log "unpack panel"
mkdir -p "$PREFIX"
rm -rf "$APP.new"
mkdir -p "$APP.new"
tar -xzf "$HOME/$TWP_ARCHIVE" -C "$APP.new"
[ -f "$APP.new/vendor/tmux/tmux.c" ] || fail "the archive has no tmux source (vendor/tmux)"
if [ -d "$APP" ]; then rm -rf "$APP.old"; mv "$APP" "$APP.old"; fi
mv "$APP.new" "$APP"
rm -rf "$APP.old"

log "npm ci"
(cd "$APP" && $NPM ci --omit=dev --no-audit --no-fund)

PORT=""
for candidate in $TWP_PORT_CANDIDATES; do
  if ! port_in_use "$candidate"; then PORT="$candidate"; break; fi
done
[ -n "$PORT" ] || fail "no free port among: $TWP_PORT_CANDIDATES"

log "install service on 127.0.0.1:$PORT (builds tmux; this takes a few minutes)"
(cd "$APP" && HOST=127.0.0.1 PORT="$PORT" NODE_BIN="$NODE_BIN" NODE_ONLY=1 bash scripts/install-service.sh install)

log "wait for the pairing file"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  [ -f "$HOME/.config/tmux-web-panel/node.json" ] && { result succeeded; exit 0; }
  sleep 1
done
fail "the panel service did not start (no pairing file)"
