#!/bin/bash
#
# Installs Papeleria for this user on macOS. Double-click it in Finder, or in
# Terminal run: bash "Install Papeleria.command"
#
# It downloads its own Node.js 22 (checked against the SHA-256 pinned in
# shared/node-runtime.txt), installs Papeleria from the papeleria-*.tgz in the
# zip into ~/.local/share/papeleria, and adds Papeleria.app to ~/Applications
# and the papeleria command to ~/.local/bin. Nothing needs an administrator.
# README.md, beside these folders, has the details; "Uninstall
# Papeleria.command" undoes it. Run it with --help for the options.

# The platform variables below are read by common.sh.
# shellcheck disable=SC2034
HERE=$(cd "$(dirname "$0")" && pwd -P)
if [ ! -f "$HERE/../shared/common.sh" ]; then
  echo "The installer's shared/ folder is missing. Extract the whole zip, then run the installer again." >&2
  exit 1
fi
# shellcheck source=../shared/common.sh
. "$HERE/../shared/common.sh"

PLATFORM=macOS
TARGET="$HOME/.local/share/papeleria"
BIN_DIR="$HOME/.local/bin"
LAUNCHER_FILE=Papeleria.command
UNINSTALLER='Uninstall Papeleria.command'
LAUNCHER_NAME='Papeleria.app in ~/Applications'
APP="$HOME/Applications/Papeleria.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

platform_check() {
  local release major arch
  [ "$(uname -s)" = Darwin ] || die "this is the installer for macOS, and this computer runs $(uname -s). Use the one in the Ubuntu or Windows folder."
  release=$(sw_vers -productVersion 2>/dev/null)
  major=${release%%.*}
  if ! [ "$major" -ge 11 ] 2>/dev/null; then
    die "this Mac runs macOS ${release:-of a version the installer cannot read}; Node.js 22 needs macOS 11 or later."
  fi
  [ "$major" -ge 14 ] || warn "this Mac runs macOS $release. Papeleria's target is macOS 14 or later; it is expected to work here, but that has not been tried."
  # Apple silicon says so even when this Terminal runs under Rosetta.
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
    arch=arm64
  else
    arch=x64
  fi
  NODE_ARCHIVE="node-v$(node_pin version)-darwin-$arch.tar.xz"
}

platform_plan() {
  [ "$NO_LAUNCHER" = 1 ] || detail "Papeleria.app in ~/Applications, which opens Papeleria in Terminal"
}

# Terminal's shells are login shells, which read these files.
platform_profile() {
  case ${SHELL##*/} in
    zsh) printf '%s\n' "${ZDOTDIR:-$HOME}/.zprofile" ;;
    bash)
      if [ -f "$HOME/.bash_profile" ]; then
        printf '%s\n' "$HOME/.bash_profile"
      elif [ -f "$HOME/.profile" ]; then
        printf '%s\n' "$HOME/.profile"
      else
        printf '%s\n' "$HOME/.bash_profile"
      fi
      ;;
  esac
}

# The app's icon: the favicon drawn at every size macOS asks for; without it
# the app shows the system's default icon.
platform_stage() {
  [ "$NO_LAUNCHER" = 1 ] && return 0
  if ! "$1/runtime/bin/node" "$SHARED/make-icons.mjs" "$1/app" iconset "$STAGE_ROOT/Papeleria.iconset" >/dev/null 2>&1 ||
    ! iconutil -c icns "$STAGE_ROOT/Papeleria.iconset" -o "$1/Papeleria.icns" >/dev/null 2>&1; then
    rm -f "$1/Papeleria.icns"
  fi
  rm -rf "$STAGE_ROOT/Papeleria.iconset"
}

# write_app <bundle>: Papeleria.app, whose one job is to open the launcher in
# a Terminal window. It is a shell script, made here, so it carries no
# download's quarantine.
write_app() {
  local version
  version=$(record_value version)
  version=${version%%-*}
  mkdir -p "$1/Contents/MacOS" "$1/Contents/Resources" || return 1
  cat > "$1/Contents/MacOS/Papeleria" <<EOF || return 1
#!/bin/sh
# Papeleria.app's program, $PAPELERIA_MARK: it opens the Papeleria
# launcher in a Terminal window. The Papeleria uninstaller removes this app.
launcher=$(shell_quote "$TARGET/$LAUNCHER_FILE")
if [ ! -f "\$launcher" ]; then
  /usr/bin/osascript -e 'display alert "Papeleria is not installed" message "Its installation is gone. Run the Papeleria installer again, or move this app to the Trash." as critical' >/dev/null 2>&1
  exit 1
fi
exec /usr/bin/open -a Terminal "\$launcher"
EOF
  chmod 755 "$1/Contents/MacOS/Papeleria" || return 1
  if [ -f "$TARGET/Papeleria.icns" ]; then
    cat "$TARGET/Papeleria.icns" > "$1/Contents/Resources/Papeleria.icns" || return 1
  fi
  cat > "$1/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>Papeleria</string>
	<key>CFBundleExecutable</key>
	<string>Papeleria</string>
	<key>CFBundleIconFile</key>
	<string>Papeleria</string>
	<key>CFBundleIdentifier</key>
	<string>moda.ross.papeleria</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>Papeleria</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>${version:-0}</string>
	<key>CFBundleVersion</key>
	<string>${version:-0}</string>
	<key>LSMinimumSystemVersion</key>
	<string>11.0</string>
</dict>
</plist>
EOF
}

platform_integrate() {
  local fresh="$HOME/Applications/.Papeleria-$$.app"
  if [ -e "$APP" ] && ! is_ours "$APP/Contents/MacOS/Papeleria"; then
    warn "$(pretty "$APP") exists and was not made by this installer, so it is left as it is. Start Papeleria with: open -a Terminal $(pretty "$TARGET/$LAUNCHER_FILE")"
    return 0
  fi
  rm -rf "$fresh"
  if ! write_app "$fresh"; then
    rm -rf "$fresh"
    warn "Papeleria.app could not be made in $(pretty "$HOME/Applications"). Start Papeleria with: open -a Terminal $(pretty "$TARGET/$LAUNCHER_FILE")"
    return 0
  fi
  if [ -e "$APP" ] && ! rm -rf "$APP"; then
    rm -rf "$fresh"
    warn "the old $(pretty "$APP") could not be replaced. If macOS asked whether Terminal may change other apps, allow it, then run the installer again."
    return 0
  fi
  mv "$fresh" "$APP" || {
    rm -rf "$fresh"
    warn "Papeleria.app could not be put in $(pretty "$HOME/Applications")."
    return 0
  }
  [ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$APP" >/dev/null 2>&1
  detail "App: Papeleria, in $(pretty "$APP")"
}

platform_next() {
  [ "$NO_LAUNCHER" = 1 ] || detail "To start it:               Papeleria in Applications, Launchpad or Spotlight"
  detail "To remove it:              \"Uninstall Papeleria.command\" in the zip, or in Terminal:"
  detail "                           bash ~/.local/share/papeleria/Uninstall\\ Papeleria.command"
}

papeleria_install "$@"
exit $?
