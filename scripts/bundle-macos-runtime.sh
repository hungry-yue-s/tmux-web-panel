#!/usr/bin/env bash
# Build-time only. The installed app never downloads or compiles components.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME="${1:?Usage: bundle-macos-runtime.sh OUTPUT_RUNTIME_DIRECTORY}"
CACHE="${TMUX_PANEL_BUILD_CACHE:-$PROJECT_DIR/dist/macos-build-cache}"
NODE_VERSION="${TMUX_PANEL_NODE_VERSION:-24.22.1}"
MINIMUM_MACOS="${TMUX_PANEL_MINIMUM_MACOS:-13.5}"
ARCH="${TMUX_PANEL_ARCH:-$(uname -m)}"
[[ "$ARCH" == x86_64 ]] && ARCH=x64
case "$ARCH" in arm64) MACHINE=arm64;; x64) MACHINE=x86_64;; *) echo "Unsupported macOS architecture: $ARCH" >&2; exit 1;; esac
if [[ "$(uname -m)" == arm64 && "$MACHINE" == x86_64 ]]; then
  /usr/bin/arch -x86_64 /usr/bin/true 2>/dev/null || { echo 'Intel packaging requires a native Intel runner or an already installed Rosetta.' >&2; exit 1; }
  exec /usr/bin/arch -x86_64 /bin/bash "$0" "$@"
fi
[[ "$(uname -s)" == Darwin && "$(uname -m)" == "$MACHINE" ]] || {
  echo "Build $ARCH on a native $MACHINE macOS runner; cross-architecture npm/native builds are not supported." >&2; exit 1;
}
[[ "$NODE_VERSION" =~ ^24\.[0-9]+\.[0-9]+$ ]] || { echo 'Use a pinned Node 24 LTS version.' >&2; exit 1; }
for command_name in curl shasum tar make cmake autoconf automake patch pkg-config rsync xcrun git; do
  command -v "$command_name" >/dev/null || { echo "Build tool missing: $command_name" >&2; exit 1; }
done
[[ -f "$PROJECT_DIR/vendor/tmux/tmux.c" ]] || { echo 'Initialize the vendor/tmux Git submodule before building.' >&2; exit 1; }
mkdir -p "$CACHE/downloads" "$RUNTIME/bin" "$RUNTIME/lib" "$RUNTIME/app" "$RUNTIME/licenses"
CACHE="$(cd "$CACHE" && pwd)"
RUNTIME="$(cd "$RUNTIME" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tmux-panel-runtime.XXXXXX")"
cleanup() {
  local status=$?
  if [[ "$status" != 0 ]]; then
    if [[ -f "$WORK/tmux/config.log" ]]; then cp "$WORK/tmux/config.log" "$CACHE/last-$ARCH-tmux-config.log"; fi
  fi
  if [[ "$status" != 0 && "${TMUX_PANEL_KEEP_BUILD:-0}" == 1 ]]; then
    echo "Preserved failed build: $WORK" >&2
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT
JOBS="${TMUX_BUILD_JOBS:-$(sysctl -n hw.ncpu)}"
if [[ -z "${TMUX_BUILD_JOBS:-}" && "$JOBS" -gt 4 ]]; then JOBS=4; fi
export MACOSX_DEPLOYMENT_TARGET="$MINIMUM_MACOS"
export SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
export CFLAGS="-O2 -arch $MACHINE -mmacosx-version-min=$MINIMUM_MACOS"
export CXXFLAGS="$CFLAGS"
# Keep architecture selection in one place for reproducible link arguments.
export LDFLAGS="-mmacosx-version-min=$MINIMUM_MACOS"
export CC="$(xcrun --find clang)" CXX="$(xcrun --find clang++)"

fetch_checked() {
  local url="$1" name="$2" checksum="$3" output="$CACHE/downloads/$2"
  if [[ -f "$output" ]] && [[ "$(shasum -a 256 "$output" | awk '{print $1}')" == "$checksum" ]]; then
    printf '%s\n' "$output"; return;
  fi
  curl --fail --location --silent --show-error --retry 3 --connect-timeout 20 --max-time 300 "$url" -o "$output.partial"
  [[ "$(shasum -a 256 "$output.partial" | awk '{print $1}')" == "$checksum" ]] || {
    rm -f "$output.partial"; echo "Checksum verification failed: $name" >&2; return 1;
  }
  mv "$output.partial" "$output"
  printf '%s\n' "$output"
}

# Official Node archives are self-contained; do not ship Homebrew's libnode.
NODE_ARCHIVE="node-v$NODE_VERSION-darwin-$ARCH.tar.gz"
NODE_BASE="https://nodejs.org/dist/v$NODE_VERSION"
NODE_CHECKSUMS="$CACHE/downloads/node-v$NODE_VERSION-SHASUMS256.txt"
if [[ ! -f "$NODE_CHECKSUMS" ]]; then
  curl --fail --location --silent --show-error --retry 3 --connect-timeout 20 --max-time 90 "$NODE_BASE/SHASUMS256.txt" -o "$WORK/node-checksums.txt"
  mv "$WORK/node-checksums.txt" "$NODE_CHECKSUMS"
fi
NODE_SHA="$(awk -v file="$NODE_ARCHIVE" '$2 == file {print $1}' "$NODE_CHECKSUMS")"
[[ "$NODE_SHA" =~ ^[0-9a-f]{64}$ ]] || { echo 'Official Node checksum was not found.' >&2; exit 1; }
NODE_TARBALL="$(fetch_checked "$NODE_BASE/$NODE_ARCHIVE" "$NODE_ARCHIVE" "$NODE_SHA")"
mkdir "$WORK/node"
tar -xzf "$NODE_TARBALL" --strip-components=1 -C "$WORK/node"
install -m 755 "$WORK/node/bin/node" "$RUNTIME/bin/node"
cp "$WORK/node/LICENSE" "$RUNTIME/licenses/Node-LICENSE.txt"
export PATH="$WORK/node/bin:$PATH"

# Static dependencies are compiled for the advertised minimum OS. Copying a
# current Homebrew bottle can silently introduce a macOS 26-only dependency.
PREFIX="$CACHE/static-$ARCH-$MINIMUM_MACOS-v2"
if [[ ! -f "$PREFIX/.static-components-complete-v4" ]]; then
  mkdir -p "$PREFIX" "$WORK/deps"
  event_archive="$(fetch_checked 'https://github.com/libevent/libevent/releases/download/release-2.1.13-stable/libevent-2.1.13-stable.tar.gz' libevent-2.1.13.tar.gz f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c)"
  unicode_archive="$(fetch_checked 'https://github.com/JuliaStrings/utf8proc/archive/refs/tags/v2.12.0.tar.gz' utf8proc-2.12.0.tar.gz f564011d38b2888d583d510b08e69ffa15aa117155db1b9b49ef1dfe1fa25111)"
  for name in event unicode; do mkdir "$WORK/deps/$name"; done
  tar -xf "$event_archive" --strip-components=1 -C "$WORK/deps/event"
  tar -xf "$unicode_archive" --strip-components=1 -C "$WORK/deps/unicode"
  if [[ ! -f "$PREFIX/lib/libevent_core.a" || ! -f "$PREFIX/lib/pkgconfig/libevent_core.pc" ]]; then
    cmake -S "$WORK/deps/event" -B "$WORK/deps/event-build" -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_INSTALL_PREFIX="$PREFIX" -DCMAKE_OSX_DEPLOYMENT_TARGET="$MINIMUM_MACOS" -DCMAKE_OSX_ARCHITECTURES="$MACHINE" -DCMAKE_C_FLAGS="-O2 -mmacosx-version-min=$MINIMUM_MACOS" -DCMAKE_CXX_FLAGS="-O2 -mmacosx-version-min=$MINIMUM_MACOS" -DEVENT__LIBRARY_TYPE=STATIC -DEVENT__DISABLE_OPENSSL=ON -DEVENT__DISABLE_TESTS=ON -DEVENT__DISABLE_SAMPLES=ON -DEVENT__DISABLE_BENCHMARK=ON
    cmake --build "$WORK/deps/event-build" --parallel "$JOBS"
    cmake --install "$WORK/deps/event-build"
  fi
  if [[ ! -f "$PREFIX/lib/libutf8proc.a" || ! -f "$PREFIX/lib/pkgconfig/libutf8proc.pc" ]]; then
    cmake -S "$WORK/deps/unicode" -B "$WORK/deps/unicode-build" -DCMAKE_INSTALL_PREFIX="$PREFIX" -DCMAKE_OSX_DEPLOYMENT_TARGET="$MINIMUM_MACOS" -DCMAKE_OSX_ARCHITECTURES="$MACHINE" -DCMAKE_C_FLAGS="-O2 -mmacosx-version-min=$MINIMUM_MACOS" -DCMAKE_CXX_FLAGS="-O2 -mmacosx-version-min=$MINIMUM_MACOS" -DBUILD_SHARED_LIBS=OFF -DUTF8PROC_ENABLE_TESTING=OFF
    cmake --build "$WORK/deps/unicode-build" --parallel "$JOBS"
    cmake --install "$WORK/deps/unicode-build"
  fi
  mkdir -p "$PREFIX/licenses"
  cp "$WORK/deps/event/LICENSE" "$PREFIX/licenses/libevent-LICENSE.txt"
  cp "$WORK/deps/unicode/LICENSE.md" "$PREFIX/licenses/utf8proc-LICENSE.md"
  touch "$PREFIX/.static-components-complete-v4"
fi
for name in libevent-LICENSE.txt utf8proc-LICENSE.md; do
  cp "$PREFIX/licenses/$name" "$RUNTIME/licenses/"
done
# macOS ships the curses APIs tmux needs; use its SDK/library and tools rather
# than shipping another curses runtime and its build-only executables.
mkdir -p "$RUNTIME/share/terminfo"
for terminal_name in tmux-256color xterm-256color; do
  /usr/bin/infocmp -x "$terminal_name" >> "$WORK/terminfo.src"
done
/usr/bin/tic -x -o "$RUNTIME/share/terminfo" "$WORK/terminfo.src"

echo 'Building the bundled project tmux (not the installed service binary)...'
mkdir "$WORK/tmux"
(cd "$PROJECT_DIR/vendor/tmux" && git ls-files -z | tar --null -T - -cf -) | tar -xf - -C "$WORK/tmux"
bash "$SCRIPT_DIR/apply-tmux-patches.sh" "$WORK/tmux"
mkdir "$WORK/pkgconfig"
for name in libevent_core.pc libutf8proc.pc; do cp "$PREFIX/lib/pkgconfig/$name" "$WORK/pkgconfig/"; done
(
  cd "$WORK/tmux"
  export PKG_CONFIG_LIBDIR="$WORK/pkgconfig" PKG_CONFIG_PATH="$WORK/pkgconfig"
  export CPPFLAGS="-I$PREFIX/include"
  export LDFLAGS="$LDFLAGS -L$SDKROOT/usr/lib -L$PREFIX/lib"
  # Select the system SDK stub explicitly, even if an older local build cache
  # happens to contain a different ncursesw archive.
  export LIBNCURSES_CFLAGS="-isystem $SDKROOT/usr/include"
  export LIBNCURSES_LIBS="$SDKROOT/usr/lib/libncurses.tbd"
  # New SDKs expose optional curses APIs without deployment availability.
  # tmux's established tparm fallback also works on the minimum supported OS.
  export ac_cv_func_tiparm=no ac_cv_func_tiparm_s=no
  sh autogen.sh
  ./configure --prefix="$WORK/tmux-install" --enable-optimizations --disable-debug --enable-utf8proc --disable-jemalloc
  make -j"$JOBS"
)
install -m 755 "$WORK/tmux/tmux" "$RUNTIME/bin/tmux"
/usr/bin/strip -S "$RUNTIME/bin/tmux"
/usr/bin/codesign --force --sign - "$RUNTIME/bin/tmux"
cp "$PROJECT_DIR/vendor/tmux/COPYING" "$RUNTIME/licenses/tmux-COPYING.txt"

echo 'Copying server resources and installing production dependencies...'
[[ -f "$SCRIPT_DIR/desktop-runtime.mjs" ]] || { echo 'Missing desktop-runtime.mjs installation helper.' >&2; exit 1; }
cp "$PROJECT_DIR/package.json" "$PROJECT_DIR/package-lock.json" "$RUNTIME/app/"
for name in server public scripts relay; do
  mkdir -p "$RUNTIME/app/$name"
  rsync -a --delete --exclude='relay-config.js' --exclude='*.pem' --exclude='*.key' --exclude='*.crt' --exclude='.env' "$PROJECT_DIR/$name/" "$RUNTIME/app/$name/"
done
mkdir -p "$RUNTIME/app/plugins/tmux-agent" "$RUNTIME/app/skills/tmux-panel"
rsync -a --delete "$PROJECT_DIR/plugins/tmux-agent/" "$RUNTIME/app/plugins/tmux-agent/"
rsync -a --delete "$PROJECT_DIR/skills/tmux-panel/" "$RUNTIME/app/skills/tmux-panel/"
# tmux-resurrect: session protection saves tmux with it.
mkdir -p "$RUNTIME/app/vendor/tmux-plugins"
rsync -a --delete "$PROJECT_DIR/vendor/tmux-plugins/" "$RUNTIME/app/vendor/tmux-plugins/"
# tmux source, so the app can install the panel on a Linux or macOS machine it
# manages (the remote installer builds tmux from it). Source only, no build output.
mkdir -p "$RUNTIME/app/vendor/tmux"
rsync -a --delete --exclude='.git' --exclude='*.o' --exclude='tmux' --exclude='config.log' --exclude='config.status' --exclude='Makefile' \
  "$PROJECT_DIR/vendor/tmux/" "$RUNTIME/app/vendor/tmux/"
cat > "$RUNTIME/licenses/THIRD-PARTY-NOTICES.md" <<'NOTICES'
# Bundled components

- Node.js: Node-LICENSE.txt (includes Node's third-party notices).
- tmux: tmux-COPYING.txt; source is the project's vendor/tmux submodule.
- tmux-resurrect: ../app/vendor/tmux-plugins/tmux-resurrect/LICENSE.md (MIT).
- libevent and utf8proc: their license files in this directory.
- macOS ncurses and system frameworks: supplied by macOS, not copied into this runtime.
- Maple Mono: ../app/public/fonts/OFL-MapleMono.txt.
- Symbols Nerd Font Mono: ../app/public/fonts/LICENSE-SymbolsNerdFont.txt (upstream v3.4.0 and glyph-source notices).
- npm production packages: each package's original notices in ../app/node_modules/.
- Tmux Panel: ../app/package.json declares ISC. This source checkout does not contain a root project license text; the declaration is retained as metadata and does not replace a license grant.
NOTICES
"$WORK/node/bin/node" "$WORK/node/lib/node_modules/npm/bin/npm-cli.js" ci --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org --prefix "$RUNTIME/app"
# Keep the matching addon only; all other platform prebuilds are irrelevant and
# can prevent Apple's notarization service from identifying the app's code.
find "$RUNTIME/app/node_modules/node-pty/prebuilds" -mindepth 1 -maxdepth 1 -type d ! -name "darwin-$ARCH" -exec rm -rf {} +
TMUX_SOURCE_COMMIT="$(git -C "$PROJECT_DIR/vendor/tmux" rev-parse HEAD)"
if [[ -n "$(git -C "$PROJECT_DIR/vendor/tmux" status --porcelain)" ]]; then TMUX_SOURCE_COMMIT=''; fi
TMUX_PANEL_ARCH="$ARCH" TMUX_PANEL_MINIMUM_MACOS="$MINIMUM_MACOS" TMUX_PANEL_NODE_SOURCE="$NODE_BASE/$NODE_ARCHIVE" TMUX_PANEL_TMUX_SOURCE_COMMIT="$TMUX_SOURCE_COMMIT" \
  "$RUNTIME/bin/node" "$SCRIPT_DIR/verify-macos-runtime.mjs" "$RUNTIME" --write-manifest
echo "Bundled runtime: $RUNTIME"
