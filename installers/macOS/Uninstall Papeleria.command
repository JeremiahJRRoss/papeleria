#!/bin/bash
#
# Removes Papeleria from this user's account on macOS: what "Install
# Papeleria.command" added, and the key Papeleria keeps for its image caches.
# Your pieces are never touched. Double-click it in Finder, or run the copy
# the installer keeps, in Terminal:
#
#   bash ~/.local/share/papeleria/Uninstall\ Papeleria.command
#
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

PLATFORM=macOS
TARGET="$HOME/.local/share/papeleria"
BIN_DIR="$HOME/.local/bin"
APP="$HOME/Applications/Papeleria.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

platform_state_dir() {
  printf '%s/Library/Application Support/Papeleria' "$HOME"
}

platform_uninstall_plan() {
  is_ours "$APP/Contents/MacOS/Papeleria" || return 0
  detail "Papeleria.app, $(pretty "$APP")"
}

platform_uninstall() {
  is_ours "$APP/Contents/MacOS/Papeleria" || return 0
  [ -x "$LSREGISTER" ] && "$LSREGISTER" -u "$APP" >/dev/null 2>&1
  if rm -rf "$APP"; then
    detail "Removed $(pretty "$APP")"
  else
    warn "$(pretty "$APP") could not be removed; move it to the Trash yourself."
  fi
}

# One line, read whole before it runs: the installed copy removes its own folder.
papeleria_uninstall "$@"; exit $?
