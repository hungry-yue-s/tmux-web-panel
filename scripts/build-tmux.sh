#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMUX_SOURCE_DIR="${TMUX_SOURCE_DIR:-$PROJECT_DIR/vendor/tmux}"
TMUX_INSTALL_PREFIX="${TMUX_INSTALL_PREFIX:-$HOME/.local/share/tmux-web-panel}"
TMUX_INSTALL_BIN="$TMUX_INSTALL_PREFIX/bin/tmux"

if [[ ! -f "$TMUX_SOURCE_DIR/tmux.c" ]]; then
  echo "Initializing tmux submodule..."
  git -C "$PROJECT_DIR" submodule update --init --recursive -- vendor/tmux
fi

if [[ ! -f "$TMUX_SOURCE_DIR/tmux.c" ]]; then
  echo "Error: tmux source is missing at $TMUX_SOURCE_DIR" >&2
  exit 1
fi

for command_name in autoconf automake bison git install make pkg-config tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Error: required build command not found: $command_name" >&2
    exit 1
  fi
done

pkg_config_path="${PKG_CONFIG_PATH:-}"
if command -v brew >/dev/null 2>&1; then
  for formula in jemalloc libevent utf8proc ncurses; do
    formula_prefix="$(brew --prefix "$formula" 2>/dev/null || true)"
    if [[ -n "$formula_prefix" ]]; then
      if [[ -n "$pkg_config_path" ]]; then
        pkg_config_path="$formula_prefix/lib/pkgconfig:$pkg_config_path"
      else
        pkg_config_path="$formula_prefix/lib/pkgconfig"
      fi
    fi
  done
fi
export PKG_CONFIG_PATH="$pkg_config_path"

if ! pkg-config --exists libevent_core; then
  echo "Error: libevent development files are required" >&2
  exit 1
fi
if ! pkg-config --exists libutf8proc; then
  echo "Error: utf8proc development files are required" >&2
  exit 1
fi

platform="$(uname -s)"
configure_flags=(
  --enable-optimizations
  --disable-debug
  --enable-utf8proc
)
if [[ "$platform" == "Darwin" ]]; then
  if ! pkg-config --exists jemalloc; then
    echo "Error: jemalloc is required for the project-managed macOS tmux build" >&2
    exit 1
  fi
  configure_flags+=(--enable-jemalloc)
elif pkg-config --exists jemalloc; then
  configure_flags+=(--enable-jemalloc)
else
  configure_flags+=(--disable-jemalloc)
fi

if [[ -n "${TMUX_BUILD_JOBS:-}" ]]; then
  build_jobs="$TMUX_BUILD_JOBS"
elif command -v nproc >/dev/null 2>&1; then
  build_jobs="$(nproc)"
elif [[ "$platform" == "Darwin" ]]; then
  build_jobs="$(sysctl -n hw.ncpu)"
else
  build_jobs=4
fi

build_root="$(mktemp -d "${TMPDIR:-/tmp}/tmux-web-panel-build.XXXXXX")"
cleanup() {
  rm -rf "$build_root"
}
trap cleanup EXIT

build_source="$build_root/source"
build_prefix="$build_root/install"
mkdir -p "$build_source"
(cd "$TMUX_SOURCE_DIR" && tar --exclude=.git -cf - .) | tar -xf - -C "$build_source"

echo "Building tmux from $TMUX_SOURCE_DIR"
echo "Source commit: $(git -C "$TMUX_SOURCE_DIR" rev-parse HEAD 2>/dev/null || echo working-tree)"
(
  cd "$build_source"
  sh autogen.sh
  ./configure --prefix="$build_prefix" "${configure_flags[@]}"
  make -s -j"$build_jobs"
  make -s install
)

staged_bin="$build_prefix/bin/tmux"
if [[ ! -x "$staged_bin" ]]; then
  echo "Error: build completed without a tmux executable" >&2
  exit 1
fi

mkdir -p "$TMUX_INSTALL_PREFIX/bin"
new_bin="$TMUX_INSTALL_PREFIX/bin/.tmux.new.$$"
install -m 755 "$staged_bin" "$new_bin"
if [[ -x "$TMUX_INSTALL_BIN" ]]; then
  install -m 755 "$TMUX_INSTALL_BIN" "$TMUX_INSTALL_PREFIX/bin/tmux.previous"
fi
mv -f "$new_bin" "$TMUX_INSTALL_BIN"

echo "Installed project-managed $($TMUX_INSTALL_BIN -V)"
echo "Binary: $TMUX_INSTALL_BIN"
