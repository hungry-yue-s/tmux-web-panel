#!/bin/sh
# Optional Mosh components. Safe to stream to sh -s; no repository path needed.
set +x
set -eu
unset anymux_mosh_password
anymux_mosh_password=${ANYMUX_SUDO_PASSWORD:-}
unset ANYMUX_SUDO_PASSWORD TWP_SUDO_PASSWORD
LC_ALL=C
export LC_ALL
PATH="${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin"
export PATH

log() { printf '>> %s\n' "$*"; }
finish() {
  printf 'ANYMUX_COMPONENT_RESULT=%s\n' "$1"
  [ -z "${2:-}" ] || printf 'ANYMUX_COMPONENT_REASON=%s\n' "$2"
  case "$1" in ready|skipped) exit 0 ;; needs_password) exit 3 ;; *) exit 1 ;; esac
}
role=${ANYMUX_MOSH_ROLE:-both}
case "$role" in client|server|both) ;; *) finish failed invalid_role ;; esac
# This script also arrives on stdin (`sh -s`) without its siblings, so the
# pre-rename names (TMUX_PANEL_*, TWP_*) are read here rather than through legacy-env.sh.
ANYMUX_MOSH_CLIENT=${ANYMUX_MOSH_CLIENT:-${TMUX_PANEL_MOSH_CLIENT:-}}
ANYMUX_MOSH_SERVER=${ANYMUX_MOSH_SERVER:-${TMUX_PANEL_MOSH_SERVER:-}}
if [ "${ANYMUX_SKIP_MOSH:-${TMUX_PANEL_SKIP_MOSH:-${TWP_SKIP_MOSH:-0}}}" = 1 ]; then finish skipped opted_out; fi

usable() {
  anymux_binary=$1
  anymux_override=$2
  if [ -n "$anymux_override" ]; then anymux_path=$anymux_override
  else anymux_path=$(command -v "$anymux_binary" 2>/dev/null) || return 1; fi
  [ -x "$anymux_path" ] || return 1
  anymux_version=$("$anymux_path" --version 2>/dev/null) || return 1
  printf '%s\n' "$anymux_version" | grep -Eq "^$anymux_binary \\(mosh [0-9]+([.][0-9]+)+[A-Za-z0-9.+_-]*\\)"
}
ready() {
  if [ "$role" != server ]; then usable mosh-client "${ANYMUX_MOSH_CLIENT:-}" || return 1; fi
  if [ "$role" != client ]; then usable mosh-server "${ANYMUX_MOSH_SERVER:-}" || return 1; fi
}
log "checking Mosh components ($role)"
if ready; then finish ready; fi
if { [ "$role" != server ] && [ -n "${ANYMUX_MOSH_CLIENT:-}" ]; } ||
   { [ "$role" != client ] && [ -n "${ANYMUX_MOSH_SERVER:-}" ]; }; then
  finish maintenance_required configured_component_unusable
fi

os=$(uname -s)
case "$os" in
  Darwin)
    [ "$(id -u)" != 0 ] || finish unsupported brew_requires_user
    command -v brew >/dev/null 2>&1 || {
      log 'Homebrew is required; install it from https://brew.sh, then retry this component.'
      finish unsupported homebrew_missing
    }
    manager=brew
    # brew install otherwise updates metadata, upgrades dependants and cleans old kegs.
    export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_UPGRADE=1
    export HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ASK=1
    ;;
  Linux)
    manager=''
    for candidate in apt-get dnf yum pacman apk zypper; do
      if command -v "$candidate" >/dev/null 2>&1; then manager=$candidate; break; fi
    done
    [ -n "$manager" ] || finish unsupported package_manager_missing
    ;;
  *) finish unsupported platform ;;
esac

# Validate sudo separately. The package manager gets closed stdin, never a password.
privilege=user
password_verified=0
if [ "$manager" != brew ] && [ "$(id -u)" != 0 ]; then
  command -v sudo >/dev/null 2>&1 || finish needs_password sudo_unavailable
  if ! sudo -n true >/dev/null 2>&1; then
    [ -n "$anymux_mosh_password" ] || finish needs_password sudo_required
    if ! printf '%s\n' "$anymux_mosh_password" | sudo -S -p '' -v >/dev/null 2>&1; then
      finish needs_password sudo_auth_failed
    fi
    password_verified=1
  fi
  privilege=sudo
fi
unset anymux_mosh_password
run() {
  if [ "$privilege" = sudo ]; then sudo -n env LC_ALL=C "$@" </dev/null
  else "$@" </dev/null; fi
}
maintenance() { log 'The package transaction needs manual maintenance; SSH remains available.'; finish maintenance_required "${1:-unsafe_package_plan}"; }
package_failed() {
  if printf '%s\n' "$1" | grep -Eiq 'password is required|authentication failure'; then
    if [ "$password_verified" = 1 ]; then finish maintenance_required sudo_noninteractive_unavailable; fi
    finish needs_password sudo_required
  fi
  if printf '%s\n' "$1" | grep -Eiq 'permission denied|not writable|access denied'; then finish failed package_permission_denied; fi
  if printf '%s\n' "$1" | grep -Eiq 'could not resolve|couldn.t resolve|network is unreachable|failed to download|failed to fetch|connection timed out|could not connect'; then finish failed package_network_unavailable; fi
  if printf '%s\n' "$1" | grep -Eiq 'cache.*(missing|unavailable)|no.*cache|database.*(missing|not found)|unable to locate package|no match for argument|target not found'; then finish failed package_cache_unavailable; fi
  if printf '%s\n' "$1" | grep -Eiq 'could not get lock|unable to lock|another.*(process|instance)|lock.*held'; then finish failed package_manager_locked; fi
  finish failed "${2:-package_install_failed}"
}
safe_plan() {
  # New Mosh/library packages are allowed. Never replace shared libraries, init or network services.
  if printf '%s\n' "$plan" | grep -Eiq 'systemd|openrc|udev|dbus|openssh-server|sshd|kernel|linux-image|initramfs|firewalld|networkmanager'; then maintenance service_transaction; fi
}
log "checking $manager transaction without upgrading the system"
case "$manager" in
  brew)
    if ! plan=$(run brew install --formula --dry-run mosh 2>&1); then package_failed "$plan" package_plan_failed; fi
    printf '%s\n' "$plan" | grep -Eq '^==> Would install [1-9][0-9]* formul(a|ae):$' || maintenance unknown_package_plan
    printf '%s\n' "$plan" | grep -Eq '^mosh$' || maintenance unknown_package_plan
    if printf '%s\n' "$plan" | grep -Eiq 'Would (upgrade|reinstall|remove)| -> '; then maintenance shared_package_change; fi
    safe_plan
    if ! output=$(run brew install --formula mosh 2>&1); then package_failed "$output"; fi
    ;;
  apt-get)
    if ! plan=$(run env DEBIAN_FRONTEND=noninteractive apt-get -s --no-install-recommends --no-remove install mosh 2>&1); then package_failed "$plan" package_plan_failed; fi
    printf '%s\n' "$plan" | grep -Eq '^0 upgraded, [1-9][0-9]* newly installed, 0 to remove' || maintenance shared_package_change
    printf '%s\n' "$plan" | grep -Eq '^Inst mosh[ :]' || maintenance unknown_package_plan
    if printf '%s\n' "$plan" | grep -Eq '^Remv |^Inst [^[:space:]]+[[:space:]]+\['; then maintenance shared_package_change; fi
    safe_plan
    # Pin every new target and make --no-upgrade apply to dependencies too, not just mosh.
    targets=$(printf '%s\n' "$plan" | awk '/^Inst / { sub(/^\(/, "", $3); print $2 "=" $3 }')
    set -- env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y --no-install-recommends --no-upgrade --no-remove
    for target in $targets; do
      case "$target" in *[!A-Za-z0-9.+:~_=-]*|*=) maintenance unknown_package_plan ;; esac
      set -- "$@" "$target"
    done
    if ! output=$(run "$@" 2>&1); then package_failed "$output"; fi
    ;;
  dnf|yum)
    # --assumeno may return 1 for the deliberate refusal; require a recognized install-only summary.
    plan_status=0
    plan=$(run "$manager" --assumeno --setopt=metadata_expire=-1 install mosh 2>&1) || plan_status=$?
    if ! printf '%s\n' "$plan" | grep -Eq '^Transaction Summary'; then
      [ "$plan_status" = 0 ] || package_failed "$plan" package_plan_failed
      maintenance unknown_package_plan
    fi
    printf '%s\n' "$plan" | grep -Eq '^Install[[:space:]]+[1-9][0-9]*[[:space:]]+Package|^[[:space:]]*Installing:[[:space:]]+[1-9]' || maintenance unknown_package_plan
    # DNF5 also prints "remove 0 B" in its size note; only action headings signal removal.
    if printf '%s\n' "$plan" | grep -Eiq '^[[:space:]]*(Upgrad(e|ing)|Updat(e|ing)|Downgrad(e|ing)|Remov(e|ing)|Reinstall(ing)?|Obsolet(e|ing|ed)|Replac(e|ing))([[:space:]:]|$)'; then maintenance shared_package_change; fi
    safe_plan
    if ! output=$(run "$manager" -y --setopt=metadata_expire=-1 install mosh 2>&1); then package_failed "$output"; fi
    ;;
  pacman)
    # Never -Sy: a rolling system must be maintained separately, not partially upgraded here.
    if ! pending=$(run pacman -Qu 2>&1); then [ -z "$pending" ] || maintenance package_database_unavailable; fi
    [ -z "$pending" ] || maintenance system_upgrade_pending
    if ! plan=$(run pacman -Sp --needed --print-format '%n' mosh 2>&1); then package_failed "$plan" package_plan_failed; fi
    printf '%s\n' "$plan" | grep -qx mosh || maintenance unknown_package_plan
    if printf '%s\n' "$plan" | grep -Evq '^[A-Za-z0-9@+_.:-]+$'; then maintenance unknown_package_plan; fi
    safe_plan
    for package in $plan; do
      case "$package" in *[!A-Za-z0-9@+_.:-]*|'') maintenance unknown_package_plan ;; esac
      if run pacman -Q "$package" >/dev/null 2>&1; then maintenance shared_package_change; fi
      # Print targets alone do not describe removals caused by conflicts/replaces.
      if ! info=$(run pacman -Si "$package" 2>&1); then maintenance unknown_package_plan; fi
      printf '%s\n' "$info" | grep -Eq '^Conflicts With[[:space:]]*:[[:space:]]*None$' || maintenance shared_package_change
      printf '%s\n' "$info" | grep -Eq '^Replaces[[:space:]]*:[[:space:]]*None$' || maintenance shared_package_change
    done
    if ! output=$(run pacman -S --needed --noconfirm mosh 2>&1); then package_failed "$output"; fi
    ;;
  apk)
    if ! plan=$(run apk add --simulate mosh 2>&1); then package_failed "$plan" package_plan_failed; fi
    printf '%s\n' "$plan" | grep -Eq 'Installing mosh \(' || maintenance unknown_package_plan
    if printf '%s\n' "$plan" | grep -Eiq 'Upgrad|Downgrad|Purg|Remov|Reinstall|Replac'; then maintenance shared_package_change; fi
    safe_plan
    if ! output=$(run apk add mosh 2>&1); then package_failed "$output"; fi
    ;;
  zypper)
    if ! plan=$(run zypper --non-interactive --no-refresh install --dry-run --no-recommends mosh 2>&1); then package_failed "$plan" package_plan_failed; fi
    printf '%s\n' "$plan" | grep -Eq '[1-9][0-9]* new packages? to install|NEW packages? (is|are) going to be installed' || maintenance unknown_package_plan
    printf '%s\n' "$plan" | grep -Eq '(^|[[:space:]])mosh([[:space:]]|$)' || maintenance unknown_package_plan
    if printf '%s\n' "$plan" | grep -Eiq 'Upgrad|Downgrad|Remov|Reinstall|vendor change'; then maintenance shared_package_change; fi
    safe_plan
    if ! output=$(run zypper --non-interactive --no-refresh install --no-recommends mosh 2>&1); then package_failed "$output"; fi
    ;;
esac
log 'verifying installed Mosh executables and versions'
if ready; then finish ready; fi
finish failed component_verification_failed
