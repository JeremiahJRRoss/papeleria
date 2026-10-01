# shellcheck shell=bash
#
# The steps the macOS and Ubuntu installers and uninstallers share. Sourced,
# never run. Written for bash 3.2, the /bin/bash macOS ships, and later.
# Nothing here needs root: everything goes into the person's own folders.
#
# An installation is one folder, TARGET, holding runtime/ (Node.js), app/
# (Papeleria and its dependencies), the launcher, the uninstaller with this
# file beside it, and installation.txt, which records what else the
# installer added. The command in BIN_DIR, the PATH block in a shell startup
# file and the platform's launcher entry point into it.
#
# An installer sets these variables, defines the platform_* functions listed
# at papeleria_install, and calls papeleria_install "$@":
#
#   PLATFORM         the system's name, for messages (macOS, Ubuntu)
#   TARGET           the installation's folder
#   BIN_DIR          where the papeleria command goes
#   LAUNCHER_FILE    the launcher's file name in TARGET
#   UNINSTALLER      the uninstaller's file name, beside the installer and in TARGET
#   LAUNCHER_NAME    how the help names the launcher --no-launcher leaves out,
#                    or nothing where the launcher cannot be left out
#   HERE             the folder of the script that was run
#
# An uninstaller sets PLATFORM, TARGET and BIN_DIR, defines its platform_*
# functions and calls papeleria_uninstall "$@".

SHARED=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
PAPELERIA_MARK='written by the Papeleria installer'
BLOCK_BEGIN='# >>> papeleria >>>'
BLOCK_END='# <<< papeleria <<<'
NODE_MIRROR=${PAPELERIA_NODE_MIRROR:-https://nodejs.org/dist}
PROFILE_FILES='.bashrc .bash_profile .profile .zprofile .zshrc'

ASSUME_YES=0
NO_LAUNCHER=0
NO_PATH=0
KEEP_STATE=0
TARBALL=''
SOURCE=''
STAGE_ROOT=''
ACTION=installer

say() { printf '%s\n' "$*"; }
detail() { printf '  %s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() {
  printf '\nThe %s stopped: %s\n' "$ACTION" "$*" >&2
  exit 1
}

# pretty <path>: the path with the home folder shown as ~.
pretty() {
  case $1 in
    "$HOME") printf '~' ;;
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# shell_quote <text>: the text as one single-quoted shell word.
shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# ask <question> <default y|n>: status 0 for yes. With --yes the answer is
# yes; with no terminal to ask on, it is the default.
ask() {
  local answer hint='[Y/n]'
  [ "$ASSUME_YES" = 1 ] && return 0
  [ "$2" = n ] && hint='[y/N]'
  if [ ! -t 0 ]; then
    [ "$2" = y ]
    return
  fi
  printf '\n%s %s ' "$1" "$hint"
  IFS= read -r answer || answer=''
  case $answer in
    [yY]*) return 0 ;;
    [nN]*) return 1 ;;
  esac
  [ "$2" = y ]
}

path_has() {
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
  esac
  return 1
}

# is_ours <file>: the file exists and one of these installers wrote it.
is_ours() {
  [ -f "$1" ] && grep -qF "$PAPELERIA_MARK" "$1"
}

# record_value <key>: that key's value in the installation's record, or nothing.
record_value() {
  [ -f "$TARGET/installation.txt" ] || return 0
  awk -v key="$1" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$TARGET/installation.txt"
}

# json_field <field>: the first "field": "value" in the JSON on stdin. Enough
# for the name and version at the top of a package.json.
json_field() {
  awk -v key="\"$1\"" 'index($0, key) { sub(/^[^:]*:[ \t]*"/, ""); sub(/".*$/, ""); print; exit }'
}

# node_pin <key>: the pinned version for "version", or an archive's SHA-256.
node_pin() {
  awk -v key="$1" '
    /^#/ { next }
    key == "version" && $1 == "version" { print $2; exit }
    key != "version" && $2 == key { print $1; exit }
  ' "$SHARED/node-runtime.txt"
}

# papeleria_running: a papeleria command from this installation is running.
papeleria_running() {
  command -v pgrep >/dev/null 2>&1 || return 1
  pgrep -f "$TARGET/app/lib/src/cli/index.js" >/dev/null 2>&1
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    if [ -t 2 ]; then
      curl --fail --location --retry 3 --connect-timeout 30 --progress-bar --output "$2" "$1"
    else
      curl --fail --location --retry 3 --connect-timeout 30 --silent --show-error --output "$2" "$1"
    fi
  elif command -v wget >/dev/null 2>&1; then
    if [ -t 2 ]; then
      wget --quiet --show-progress --tries=3 --timeout=30 --output-document="$2" "$1"
    else
      wget --quiet --tries=3 --timeout=30 --output-document="$2" "$1"
    fi
  else
    die "neither curl nor wget is installed, so Node.js cannot be downloaded. Install one (on Ubuntu: sudo apt install curl), then run the installer again."
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    die "neither sha256sum nor shasum is installed, so the download cannot be checked."
  fi
}

# npm_in <folder> <npm arguments...>: the staged runtime's npm, run there.
npm_in() {
  local folder=$1
  shift
  (cd "$folder" && PATH="$NODE_DIR/bin:$PATH" npm_config_update_notifier=false \
    "$NODE_DIR/bin/node" "$NODE_DIR/lib/node_modules/npm/bin/npm-cli.js" "$@")
}

# install_node <folder>: the pinned Node.js, checked against its SHA-256.
install_node() {
  local folder=$1 version expected actual archive url
  version=$(node_pin version)
  expected=$(node_pin "$NODE_ARCHIVE")
  [ -n "$version" ] && [ -n "$expected" ] || die "node-runtime.txt names no $NODE_ARCHIVE."
  archive="$STAGE_ROOT/$NODE_ARCHIVE"
  url="$NODE_MIRROR/v$version/$NODE_ARCHIVE"
  detail "Downloading $url"
  fetch "$url" "$archive" || die "$url could not be downloaded. Check the network connection and any proxy settings, then run the installer again."
  actual=$(sha256_of "$archive")
  [ "$actual" = "$expected" ] || die "the download's SHA-256 is $actual, not $expected as node-runtime.txt pins, so it was not used. Run the installer again; if this repeats, the file served is not the Node.js release the installer names."
  detail "SHA-256 matches the pinned $expected"
  mkdir -p "$folder" && tar -xf "$archive" -C "$folder" --strip-components=1 || die "$NODE_ARCHIVE could not be unpacked."
  rm -f "$archive"
  # C headers and the release notes: nothing Papeleria runs reads them.
  rm -rf "$folder/include" "$folder/CHANGELOG.md"
  [ "$("$folder/bin/node" --version 2>/dev/null)" = "v$version" ] || die "the unpacked Node.js does not run on this computer ($folder/bin/node)."
}

# pack_source <source folder> <destination folder>: builds the tarball from a
# source download as the repository's own release proof does, then leaves
# the download as it came.
pack_source() {
  local source=$1 destination=$2 had_modules=0 had_lib=0
  [ -d "$source/node_modules" ] && had_modules=1
  [ -d "$source/lib" ] && had_lib=1
  detail "Installing the build tools (npm ci)"
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm_in "$source" ci --ignore-scripts --no-audit --no-fund --cache "$STAGE_ROOT/npm-cache" \
    || die "npm could not install the build tools. The messages above say why."
  detail "Building (npm run build)"
  npm_in "$source" run build >/dev/null || die "the build failed. The messages above say why."
  detail "Packing (npm pack)"
  npm_in "$source" pack --loglevel=warn --pack-destination "$destination" --cache "$STAGE_ROOT/npm-cache" >/dev/null \
    || die "npm pack failed. The messages above say why."
  [ "$had_modules" = 1 ] || rm -rf "${source:?}/node_modules"
  [ "$had_lib" = 1 ] || rm -rf "${source:?}/lib"
}

# install_app <tarball> <app folder>: the package and the dependency tree its
# npm-shrinkwrap.json pins, with no package's install script run (security
# audit F11: none of them needs one).
install_app() {
  mkdir -p "$2" && tar -xzf "$1" -C "$2" --strip-components=1 || die "$1 could not be unpacked."
  [ -f "$2/npm-shrinkwrap.json" ] || die "$(basename "$1") holds no npm-shrinkwrap.json, so its dependencies cannot be installed at the versions it was tested with. Use a tarball made by npm pack in the repository."
  npm_in "$2" ci --omit=dev --include=optional --ignore-scripts --no-audit --no-fund --cache "$STAGE_ROOT/npm-cache" \
    || die "npm could not install Papeleria's dependencies. The messages above say why; check the network connection and any proxy settings, then run the installer again."
}

# check_install <installation folder> <version>: the command answers, the
# image library loads, and a sample deck builds.
check_install() {
  local node="$1/runtime/bin/node" cli="$1/app/lib/src/cli/index.js" got library scratch report
  got=$("$node" "$cli" --version 2>&1)
  [ "$got" = "$2" ] || die "papeleria --version printed \"$got\", not $2."
  detail "papeleria --version: $got"
  library=$(cd "$1/app" && "$node" -e 'const s = require("sharp"); process.stdout.write(`sharp ${s.versions.sharp}, libvips ${s.versions.vips}`)' 2>&1) \
    || die "the image library, sharp, does not load on this computer: $library"
  detail "Image library: $library"
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/papeleria-check.XXXXXX") || die "no temporary folder for the check."
  if report=$(cd "$scratch" && export PAPELERIA_STATE_HOME="$scratch/state" PAPELERIA_NO_BROWSER=1 &&
    "$node" "$cli" new deck check-deck >/dev/null 2>&1 && "$node" "$cli" build check-deck 2>&1); then
    rm -rf "$scratch"
    detail "Sample deck: $(printf '%s\n' "$report" | tail -n 1)"
  else
    rm -rf "$scratch"
    printf '%s\n' "$report" >&2
    die "a sample deck did not build with the new installation."
  fi
}

# write_shim <path>: the papeleria command, which starts the installation's
# Node.js with its CLI.
write_shim() {
  local temporary="$1.papeleria.$$"
  cat > "$temporary" <<EOF || return 1
#!/bin/sh
# The papeleria command, $PAPELERIA_MARK; the Papeleria uninstaller removes it.
node=$(shell_quote "$TARGET/runtime/bin/node")
cli=$(shell_quote "$TARGET/app/lib/src/cli/index.js")
if [ ! -x "\$node" ] || [ ! -f "\$cli" ]; then
  echo "papeleria: the installation this command starts is gone (\$cli). Install Papeleria again, or delete \$0." >&2
  exit 2
fi
exec "\$node" "\$cli" "\$@"
EOF
  chmod 755 "$temporary" && mv -f "$temporary" "$1"
}

# add_path_block <file> <folder>: puts the folder on PATH for new shells.
add_path_block() {
  {
    [ ! -s "$1" ] || printf '\n'
    printf '%s\n' "$BLOCK_BEGIN"
    printf '# Added by the Papeleria installer, so new terminals find the papeleria command.\n'
    printf '# The Papeleria uninstaller removes this block.\n'
    printf 'case ":${PATH}:" in *:%s:*) ;; *) export PATH=%s:"${PATH}" ;; esac\n' "$(shell_quote "$2")" "$(shell_quote "$2")"
    printf '%s\n' "$BLOCK_END"
  } >> "$1"
}

# remove_path_block <file>: takes the block out again, with the blank line
# written before it, and leaves every other line as it was. A file the block
# was all of goes too.
remove_path_block() {
  local temporary="$1.papeleria.$$" status
  awk -v begin="$BLOCK_BEGIN" -v end="$BLOCK_END" '
    skip { if ($0 == end) skip = 0; next }
    $0 == begin { skip = 1; blank = 0; next }
    { if (blank) print ""; blank = 0 }
    $0 == "" { blank = 1; next }
    { print }
    END { if (blank) print "" }
  ' "$1" > "$temporary" && cat "$temporary" > "$1"
  status=$?
  rm -f "$temporary"
  [ "$status" != 0 ] || [ -s "$1" ] || rm -f "$1"
  return "$status"
}

# profiles_with_block: every shell startup file holding the installer's PATH
# block: the usual ones in the home folder, and the one the record names.
profiles_with_block() {
  local file recorded
  recorded=$(record_value profile)
  for file in $PROFILE_FILES; do
    if [ -f "$HOME/$file" ] && grep -qF "$BLOCK_BEGIN" "$HOME/$file"; then
      printf '%s\n' "$HOME/$file"
    fi
  done
  case " $PROFILE_FILES " in
    *" ${recorded#"$HOME/"} "*) ;;
    *)
      if [ -n "$recorded" ] && [ -f "$recorded" ] && grep -qF "$BLOCK_BEGIN" "$recorded"; then
        printf '%s\n' "$recorded"
      fi
      ;;
  esac
}

# remove_state_key <folder>: the installation key Papeleria keeps for the
# user (it signs the image caches); the folder goes when nothing else is in it.
remove_state_key() {
  rm -rf "$1/installation-key" "$1/installation-key.lock" "$1"/installation-key.*.tmp
  rmdir "$1" 2>/dev/null || true
}

cleanup_stage() {
  if [ -n "$STAGE_ROOT" ] && [ -d "$STAGE_ROOT" ]; then
    rm -rf "$STAGE_ROOT"
  fi
}

install_usage() {
  cat <<EOF
Installs Papeleria for this user on $PLATFORM: its own Node.js $(node_pin version),
the papeleria command and the Papeleria launcher. Nothing needs an administrator.

Options:
  --yes             Do not ask before installing
  --tarball FILE    Install this papeleria-<version>.tgz
EOF
  [ -z "$LAUNCHER_NAME" ] || printf '  --no-launcher     Leave out %s\n' "$LAUNCHER_NAME"
  cat <<EOF
  --no-path         Never edit a shell startup file to put $(pretty "$BIN_DIR") on PATH
  --help            Print this help

Environment:
  PAPELERIA_NODE_MIRROR   A mirror of https://nodejs.org/dist to download Node.js from;
                          the file must still match the SHA-256 in node-runtime.txt
EOF
}

# find_tarball: sets TARBALL, or SOURCE to a copy of the repository to build
# one from.
find_tarball() {
  local candidate found='' count=0
  if [ -n "$TARBALL" ]; then
    [ -f "$TARBALL" ] || die "$TARBALL does not exist."
    TARBALL="$(cd "$(dirname "$TARBALL")" && pwd -P)/$(basename "$TARBALL")"
    return 0
  fi
  for candidate in "$HERE"/../papeleria-*.tgz; do
    [ -f "$candidate" ] || continue
    found=$candidate
    count=$((count + 1))
  done
  [ "$count" -le 1 ] || die "there is more than one papeleria-*.tgz next to this folder. Keep the one to install, or name it with --tarball."
  if [ "$count" = 1 ]; then
    TARBALL="$(cd "$(dirname "$found")" && pwd -P)/$(basename "$found")"
    return 0
  fi
  # A download of the repository: installers/<system>/ sits in the application root.
  candidate=$(cd "$HERE/../.." 2>/dev/null && pwd -P)
  if [ -n "$candidate" ] && [ -f "$candidate/package.json" ] && [ "$(json_field name < "$candidate/package.json")" = papeleria ]; then
    SOURCE=$candidate
    return 0
  fi
  die "no papeleria-<version>.tgz is next to this folder, and this is not a copy of the repository to build one from. Run the installer from the extracted Papeleria zip."
}

# papeleria_install: the whole installation. The platform supplies
#   platform_check          the system and processor are supported; sets NODE_ARCHIVE
#   platform_plan           lines naming what it adds, for the summary
#   platform_stage <dir>    files of its own in the staged installation ($version is set)
#   platform_profile        the shell startup file for the PATH block, or nothing
#   platform_integrate      its launcher, once the installation is in place
#   platform_next           lines saying how to start and remove Papeleria
papeleria_install() {
  local version name staged created_bin_dir='' profile='' previous=''
  while [ $# -gt 0 ]; do
    case $1 in
      --yes | -y) ASSUME_YES=1 ;;
      --tarball)
        [ $# -ge 2 ] || die "--tarball needs a file."
        TARBALL=$2
        shift
        ;;
      --tarball=*) TARBALL=${1#--tarball=} ;;
      --no-launcher)
        [ -n "$LAUNCHER_NAME" ] || die "--no-launcher: on $PLATFORM the launcher is part of the installation."
        NO_LAUNCHER=1
        ;;
      --no-path) NO_PATH=1 ;;
      --help | -h)
        install_usage
        exit 0
        ;;
      *) die "unknown option $1. Run with --help for the options." ;;
    esac
    shift
  done

  say "Papeleria installer for $PLATFORM"
  [ "$(id -u)" != 0 ] || die "run it as yourself, not as root or with sudo: it installs into your own folders."
  [ -n "${HOME:-}" ] && [ -d "$HOME" ] || die "HOME is not set to a folder."
  platform_check
  find_tarball

  if [ -n "$TARBALL" ]; then
    name=$(tar -xzOf "$TARBALL" package/package.json 2>/dev/null | json_field name)
    version=$(tar -xzOf "$TARBALL" package/package.json 2>/dev/null | json_field version)
    [ "$name" = papeleria ] && [ -n "$version" ] || die "$TARBALL is not a Papeleria package."
  else
    version=$(json_field version < "$SOURCE/package.json")
  fi
  if [ -e "$TARGET" ]; then
    is_ours "$TARGET/installation.txt" || die "$(pretty "$TARGET") exists and was not made by this installer, so it is left alone. Move it away, then run the installer again."
    previous=$(record_value version)
    created_bin_dir=$(record_value created_bin_dir)
  fi
  if [ -e "$BIN_DIR/papeleria" ] && ! is_ours "$BIN_DIR/papeleria"; then
    die "$(pretty "$BIN_DIR/papeleria") exists and was not written by this installer (an npm install -g, perhaps). Remove that installation first (npm uninstall -g papeleria, with the same --prefix), then run the installer again."
  fi
  if papeleria_running; then
    die "Papeleria is running from $(pretty "$TARGET"). Stop it first (Ctrl C in its window, or close the window), then run the installer again."
  fi

  step "This installs, for $(id -un) only:"
  if [ -n "$TARBALL" ]; then
    detail "Papeleria $version, from $(basename "$TARBALL")"
  else
    detail "Papeleria $version, built from the source in $(pretty "$SOURCE")"
  fi
  detail "Node.js $(node_pin version), for Papeleria's use alone ($NODE_ARCHIVE)"
  detail "into $(pretty "$TARGET")"
  detail "the papeleria command, in $(pretty "$BIN_DIR")"
  platform_plan
  [ -z "$previous" ] || detail "It replaces the Papeleria $previous installed there."
  detail "It downloads Node.js from $NODE_MIRROR and Papeleria's dependencies from the npm registry."
  ask "Install?" y || die "nothing was installed."

  # Everything is made beside the installation, then moved into place, so a
  # failure leaves any earlier installation as it was.
  STAGE_ROOT="$(dirname "$TARGET")/.papeleria-install-$$"
  trap cleanup_stage EXIT
  trap 'exit 130' INT TERM HUP
  mkdir -p "$STAGE_ROOT" || die "$(pretty "$(dirname "$TARGET")") is not writable."
  staged="$STAGE_ROOT/$(basename "$TARGET")"
  mkdir -p "$staged" || die "$(pretty "$staged") could not be made."
  NODE_DIR="$staged/runtime"

  step "1/4  Node.js $(node_pin version)"
  install_node "$NODE_DIR"

  step "2/4  Papeleria $version"
  if [ -z "$TARBALL" ]; then
    pack_source "$SOURCE" "$STAGE_ROOT"
    TARBALL="$STAGE_ROOT/papeleria-$version.tgz"
    [ -f "$TARBALL" ] || die "npm pack wrote no papeleria-$version.tgz."
  fi
  detail "Installing its dependencies (npm ci, at the versions the package pins)"
  install_app "$TARBALL" "$staged/app"
  rm -rf "$STAGE_ROOT/npm-cache"

  step "3/4  Checking the new installation"
  check_install "$staged" "$version"

  step "4/4  Putting it in place"
  cat "$SHARED/common.sh" > "$staged/common.sh" &&
    cat "$SHARED/launcher.sh" > "$staged/$LAUNCHER_FILE" && chmod 755 "$staged/$LAUNCHER_FILE" &&
    cat "$HERE/$UNINSTALLER" > "$staged/$UNINSTALLER" && chmod 755 "$staged/$UNINSTALLER" ||
    die "the launcher and the uninstaller could not be copied."
  if [ "$NO_PATH" = 0 ] && ! path_has "$BIN_DIR"; then
    profile=$(platform_profile)
  fi
  # The uninstaller removes the command's folder only if an installation made it.
  [ -d "$BIN_DIR" ] || created_bin_dir=1
  platform_stage "$staged"
  {
    printf '# Papeleria installation, %s. The uninstaller reads this file.\n' "$PAPELERIA_MARK"
    printf 'version=%s\n' "$version"
    printf 'node=%s\n' "$(node_pin version)"
    printf 'installed=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'command=%s\n' "$BIN_DIR/papeleria"
    printf 'created_bin_dir=%s\n' "${created_bin_dir:-0}"
    printf 'profile=%s\n' "$profile"
  } > "$staged/installation.txt" || die "installation.txt could not be written."

  if [ -e "$TARGET" ]; then
    mv "$TARGET" "$STAGE_ROOT/previous" || die "the installation in $(pretty "$TARGET") could not be moved aside. Close anything using it, then run the installer again."
  fi
  if ! mv "$staged" "$TARGET"; then
    [ -e "$STAGE_ROOT/previous" ] && mv "$STAGE_ROOT/previous" "$TARGET"
    die "the new installation could not be moved to $(pretty "$TARGET")."
  fi
  detail "Installed in $(pretty "$TARGET")"

  mkdir -p "$BIN_DIR" && write_shim "$BIN_DIR/papeleria" || die "$(pretty "$BIN_DIR/papeleria") could not be written."
  detail "Command: $(pretty "$BIN_DIR/papeleria")"
  if [ -n "$profile" ] && [ -f "$profile" ] && grep -qF "$BLOCK_BEGIN" "$profile"; then
    detail "PATH: $(pretty "$profile") already puts $(pretty "$BIN_DIR") on it"
  elif [ -n "$profile" ]; then
    if add_path_block "$profile" "$BIN_DIR"; then
      detail "PATH: added $(pretty "$BIN_DIR") in $(pretty "$profile"), for new terminal windows"
    else
      warn "$(pretty "$profile") could not be changed; add $(pretty "$BIN_DIR") to your PATH yourself."
    fi
  elif ! path_has "$BIN_DIR"; then
    warn "$(pretty "$BIN_DIR") is not on your PATH. Add it, or run $(pretty "$BIN_DIR/papeleria") by its full path."
  fi
  [ "$NO_LAUNCHER" = 1 ] || platform_integrate

  step "Papeleria $version is installed."
  platform_next
  detail "In a new terminal window:  papeleria --help"
  if command -v papeleria >/dev/null 2>&1 && [ "$(command -v papeleria)" != "$BIN_DIR/papeleria" ]; then
    warn "another papeleria, $(command -v papeleria), comes first on your PATH. Remove it, or run $(pretty "$BIN_DIR/papeleria")."
  fi
}

uninstall_usage() {
  cat <<EOF
Removes Papeleria from this user's account on $PLATFORM: the installation in
$(pretty "$TARGET"), the papeleria command, the launcher, the PATH lines the
installer added, and the key Papeleria keeps in $(pretty "$(platform_state_dir)").
Your pieces are never touched.

Options:
  --yes          Do not ask before removing
  --keep-state   Keep Papeleria's key for its image caches
  --help         Print this help
EOF
}

# uninstall_items: one line for each thing the uninstaller would remove.
uninstall_items() {
  local file version
  if is_ours "$TARGET/installation.txt"; then
    version=$(record_value version)
    detail "the installation, $(pretty "$TARGET")${version:+ (Papeleria $version)}"
  fi
  is_ours "$command" && detail "the papeleria command, $(pretty "$command")"
  profiles_with_block | while IFS= read -r file; do
    detail "the PATH lines the installer added to $(pretty "$file")"
  done
  platform_uninstall_plan
  return 0
}

# papeleria_uninstall: the platform supplies
#   platform_state_dir        the folder Papeleria keeps its installation key in
#   platform_uninstall_plan   lines for what it removes of its own
#   platform_uninstall        removes those
papeleria_uninstall() {
  local command state file items kept=''
  ACTION=uninstaller
  while [ $# -gt 0 ]; do
    case $1 in
      --yes | -y) ASSUME_YES=1 ;;
      --keep-state) KEEP_STATE=1 ;;
      --help | -h)
        uninstall_usage
        exit 0
        ;;
      *) die "unknown option $1. Run with --help for the options." ;;
    esac
    shift
  done

  say "Papeleria uninstaller for $PLATFORM"
  [ "$(id -u)" != 0 ] || die "run it as yourself, not as root or with sudo: Papeleria is installed in your own folders."
  command=$(record_value command)
  [ -n "$command" ] || command="$BIN_DIR/papeleria"
  state=$(platform_state_dir)

  items=$(uninstall_items)
  if [ -z "$items" ]; then
    say "Papeleria is not installed for $(id -un): there is nothing to remove."
    [ ! -e "$TARGET" ] || say "$(pretty "$TARGET") exists but was not made by the Papeleria installer, so it is left alone."
    exit 0
  fi
  step "This removes:"
  printf '%s\n' "$items"
  if [ "$KEEP_STATE" = 0 ] && [ -z "${PAPELERIA_STATE_HOME:-}" ] && [ -e "$state/installation-key" ]; then
    detail "Papeleria's installation key, in $(pretty "$state")"
  fi
  say "Your pieces, wherever they are, stay as they are."
  ask "Remove Papeleria?" n || die "nothing was removed."
  if papeleria_running; then
    die "Papeleria is running from $(pretty "$TARGET"). Stop it first (Ctrl C in its window, or close the window), then run the uninstaller again."
  fi

  step "Removing"
  platform_uninstall
  if is_ours "$command"; then
    rm -f "$command" && detail "Removed $(pretty "$command")"
    [ "$(record_value created_bin_dir)" != 1 ] || rmdir "$(dirname "$command")" 2>/dev/null || true
  fi
  profiles_with_block | while IFS= read -r file; do
    remove_path_block "$file" && detail "Removed the PATH lines from $(pretty "$file")"
  done
  if is_ours "$TARGET/installation.txt"; then
    cd / || true
    rm -rf "$TARGET" || die "$(pretty "$TARGET") could not be removed completely. Remove what is left of it yourself."
    detail "Removed $(pretty "$TARGET")"
  fi
  if [ "$KEEP_STATE" = 1 ]; then
    kept="Papeleria's installation key stays in $(pretty "$state"), as asked."
  elif [ -n "${PAPELERIA_STATE_HOME:-}" ]; then
    kept="PAPELERIA_STATE_HOME is set, so the key in the folder it names stays: that folder is yours."
  elif [ -e "$state/installation-key" ]; then
    remove_state_key "$state"
    detail "Removed Papeleria's installation key from $(pretty "$state")"
  fi

  step "Papeleria is removed."
  [ -z "$kept" ] || detail "$kept"
  detail "In each piece, dist/ and .papeleria/ are generated; delete them yourself if you no longer want them."
}
