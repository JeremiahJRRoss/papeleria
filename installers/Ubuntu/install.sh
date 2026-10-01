#!/bin/bash
#
# Installs Papeleria for this user on Ubuntu 26.04 desktop. In a terminal, in
# the folder the zip was extracted to:
#
#   bash Ubuntu/install.sh
#
# It downloads its own Node.js 22 (checked against the SHA-256 pinned in
# shared/node-runtime.txt), installs Papeleria from the papeleria-*.tgz in the
# zip into ~/.local/share/papeleria, adds the papeleria command to
# ~/.local/bin and Papeleria to the app grid. Nothing needs sudo. README.md,
# beside these folders, has the details; Ubuntu/uninstall.sh undoes it.
# Run it with --help for the options.

# The platform variables below are read by common.sh.
# shellcheck disable=SC2034
HERE=$(cd "$(dirname "$0")" && pwd -P)
if [ ! -f "$HERE/../shared/common.sh" ]; then
  echo "The installer's shared/ folder is missing. Extract the whole zip, then run the installer again." >&2
  exit 1
fi
# shellcheck source=../shared/common.sh
. "$HERE/../shared/common.sh"

PLATFORM=Ubuntu
case ${XDG_DATA_HOME:-} in
  /*) DATA_HOME=$XDG_DATA_HOME ;;
  *) DATA_HOME="$HOME/.local/share" ;;
esac
TARGET="$DATA_HOME/papeleria"
BIN_DIR="$HOME/.local/bin"
LAUNCHER_FILE=launcher.sh
UNINSTALLER=uninstall.sh
LAUNCHER_NAME='Papeleria in the app grid'
DESKTOP_FILE="$DATA_HOME/applications/papeleria.desktop"

platform_check() {
  local arch release='' glibc major minor
  [ "$(uname -s)" = Linux ] || die "this is the installer for Ubuntu, and this computer runs $(uname -s). Use the one in the macOS or Windows folder."
  case $(uname -m) in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "Node.js 22 has no build for this processor ($(uname -m)). Papeleria needs an x86_64 or ARM64 computer." ;;
  esac
  glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{ print $2 }')
  [ -n "$glibc" ] || die "this system's C library is not glibc; the Node.js builds the installer uses need glibc 2.28 or later, as Ubuntu has."
  major=${glibc%%.*}
  minor=${glibc#*.}
  minor=${minor%%.*}
  if [ "$major" -lt 2 ] || { [ "$major" = 2 ] && [ "$minor" -lt 28 ]; }; then
    die "this system has glibc $glibc; the Node.js 22 builds need 2.28 or later."
  fi
  if [ -r /etc/os-release ]; then
    release=$(. /etc/os-release && printf '%s %s' "${NAME:-}" "${VERSION_ID:-}")
  fi
  case $release in
    'Ubuntu 26.04') ;;
    Ubuntu*) warn "this is $release. The installer is written for Ubuntu 26.04 and is expected to work on other recent releases." ;;
    *) warn "this is ${release:-a Linux the installer does not recognise}, not Ubuntu. The installer is written for Ubuntu 26.04 and may work here." ;;
  esac
  if command -v xz >/dev/null 2>&1; then
    NODE_ARCHIVE="node-v$(node_pin version)-linux-$arch.tar.xz"
  else
    NODE_ARCHIVE="node-v$(node_pin version)-linux-$arch.tar.gz"
  fi
}

platform_plan() {
  [ "$NO_LAUNCHER" = 1 ] || detail "Papeleria in the app grid ($(pretty "$DESKTOP_FILE"))"
}

platform_profile() {
  case ${SHELL##*/} in
    bash) printf '%s\n' "$HOME/.bashrc" ;;
    zsh) printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc" ;;
  esac
}

# The app grid's icon: the favicon drawn as a 256-pixel tile, or the SVG
# itself when that cannot be drawn.
platform_stage() {
  [ "$NO_LAUNCHER" = 1 ] && return 0
  "$1/runtime/bin/node" "$SHARED/make-icons.mjs" "$1/app" png "$1/papeleria.png" >/dev/null 2>&1 || rm -f "$1/papeleria.png"
}

# write_desktop_entry <icon>: the app grid's entry, which runs the launcher in
# the default terminal (Terminal=true).
write_desktop_entry() {
  cat > "$DESKTOP_FILE" <<EOF
# The Papeleria launcher, $PAPELERIA_MARK; the Papeleria uninstaller removes it.
[Desktop Entry]
Type=Application
Name=Papeleria
GenericName=Publisher
Comment=Make and edit decks, comics and printable documents
Exec=/bin/bash "$TARGET/$LAUNCHER_FILE"
Icon=$1
Terminal=true
Categories=Office;Publishing;
Keywords=deck;slides;comic;document;publish;
StartupNotify=false
EOF
}

platform_integrate() {
  local icon
  case $TARGET in
    *[\"\`\$\\%]*)
      warn "the installation's path holds a character an app grid entry cannot carry, so Papeleria is not in the app grid. Start it with: bash $(pretty "$TARGET/$LAUNCHER_FILE")"
      return 0
      ;;
  esac
  if [ -e "$DESKTOP_FILE" ] && ! is_ours "$DESKTOP_FILE"; then
    warn "$(pretty "$DESKTOP_FILE") exists and was not written by this installer, so it is left as it is."
    return 0
  fi
  icon="$TARGET/papeleria.png"
  [ -f "$icon" ] || icon="$TARGET/app/theme/marks/papeleria-favicon.svg"
  if ! mkdir -p "$(dirname "$DESKTOP_FILE")" || ! write_desktop_entry "$icon"; then
    warn "$(pretty "$DESKTOP_FILE") could not be written, so Papeleria is not in the app grid."
    return 0
  fi
  detail "App grid: Papeleria ($(pretty "$DESKTOP_FILE"))"
}

platform_next() {
  [ "$NO_LAUNCHER" = 1 ] || detail "To start it:               Papeleria in the app grid (Show Apps, then type Papeleria)"
  detail "To remove it:              bash $(pretty "$TARGET/$UNINSTALLER")"
}

papeleria_install "$@"
exit $?
