#!/bin/bash
#
# Removes Papeleria from this user's account on Ubuntu: what install.sh
# added, and the key Papeleria keeps for its image caches. Your pieces are
# never touched. Run it from the zip (bash Ubuntu/uninstall.sh), or run the
# copy the installer keeps: bash ~/.local/share/papeleria/uninstall.sh
# Run it with --help for the options.

# The platform variables below are read by common.sh.
# shellcheck disable=SC2034
HERE=$(cd "$(dirname "$0")" && pwd -P)
# The installed copy has common.sh beside it; the zip has it in shared/.
if [ -f "$HERE/common.sh" ]; then
  # shellcheck source=../shared/common.sh
  . "$HERE/common.sh"
elif [ -f "$HERE/../shared/common.sh" ]; then
  # shellcheck source=../shared/common.sh
  . "$HERE/../shared/common.sh"
else
  echo "The uninstaller's common.sh is missing. Run the uninstaller from the extracted zip." >&2
  exit 1
fi

PLATFORM=Ubuntu
case ${XDG_DATA_HOME:-} in
  /*) DATA_HOME=$XDG_DATA_HOME ;;
  *) DATA_HOME="$HOME/.local/share" ;;
esac
TARGET="$DATA_HOME/papeleria"
BIN_DIR="$HOME/.local/bin"
DESKTOP_FILE="$DATA_HOME/applications/papeleria.desktop"

platform_state_dir() {
  case ${XDG_STATE_HOME:-} in
    /*) printf '%s/papeleria' "$XDG_STATE_HOME" ;;
    *) printf '%s/.local/state/papeleria' "$HOME" ;;
  esac
}

platform_uninstall_plan() {
  is_ours "$DESKTOP_FILE" || return 0
  detail "Papeleria in the app grid, $(pretty "$DESKTOP_FILE")"
}

platform_uninstall() {
  if is_ours "$DESKTOP_FILE"; then
    rm -f "$DESKTOP_FILE" && detail "Removed $(pretty "$DESKTOP_FILE")"
  fi
}

# One line, read whole before it runs: the installed copy removes its own folder.
papeleria_uninstall "$@"; exit $?
