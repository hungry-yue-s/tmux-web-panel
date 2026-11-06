#!/usr/bin/env bash
# Runs inside MSYS2; the PowerShell entry point owns versioned publication.
set -euo pipefail
source_directory="${1:?source directory required}"
install_directory="${2:?installation staging directory required}"
patch_script="${3:?patch script required}"
build_jobs="${4:-2}"
case "$build_jobs" in ''|*[!0-9]*|0) echo 'invalid build jobs' >&2; exit 1;; esac
if [[ ! -f "$source_directory/tmux.c" ]]; then echo 'tmux source is missing' >&2; exit 1; fi
if [[ -e "$install_directory/tmux.exe" ]]; then echo 'refusing to overwrite an existing tmux executable' >&2; exit 1; fi
build_directory="$(mktemp -d "${TMPDIR:-/tmp}/twp-tmux-build.XXXXXXXX")"
trap 'rm -rf "$build_directory"' EXIT
mkdir -p "$build_directory/source" "$build_directory/install"
(cd "$source_directory" && tar --exclude=.git -cf - .) | tar -xf - -C "$build_directory/source"
bash "$patch_script" "$build_directory/source"
(
  cd "$build_directory/source"
  sh autogen.sh
  # MSYS ncurses headers live below ncursesw; configure's C23 feature test must
  # not replace the MSYS runtime's feature-selection macros.
  CPPFLAGS="${CPPFLAGS:-} -I/usr/include/ncursesw -U_XOPEN_SOURCE" ./configure \
    --build=x86_64-pc-msys --disable-debug --prefix="$build_directory/install"
  make -s -j"$build_jobs"
  make -s install
)
if [[ ! -f "$build_directory/install/bin/tmux.exe" ]]; then echo 'build did not produce tmux.exe' >&2; exit 1; fi
mkdir -p "$install_directory"
install -m 755 "$build_directory/install/bin/tmux.exe" "$install_directory/tmux.exe"
