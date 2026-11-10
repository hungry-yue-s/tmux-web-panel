# Sourced by the service and build scripts. Anymux was called tmux-web-panel:
# a variable set under the old name (TMUX_PANEL_*, TMUX_WEB_PANEL_*, TWP_*)
# sets the ANYMUX_* of the same suffix unless that one is set already, the
# same rule as lib/legacy-names.js. Only names are read from `env`; values are
# never parsed.
eval "$(env | sed -nE 's/^(TMUX_WEB_PANEL|TMUX_PANEL|TWP)_([A-Z0-9_]+)=.*/: "${ANYMUX_\2=${\1_\2}}"; export ANYMUX_\2;/p')"

# $HOME/<base>/anymux, or <base>/tmux-web-panel while only that one exists (the
# panel moves it when it starts; until then scripts keep using it).
# Usage: anymux_dir .config | .cache | .local/share
anymux_dir() {
  if [ ! -e "$HOME/$1/anymux" ] && [ -e "$HOME/$1/tmux-web-panel" ]; then
    printf '%s\n' "$HOME/$1/tmux-web-panel"
  else
    printf '%s\n' "$HOME/$1/anymux"
  fi
}
