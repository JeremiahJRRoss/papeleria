#!/bin/bash
#
# The Papeleria launcher. The Papeleria app (macOS) and the app grid entry
# (Ubuntu) open it in a terminal window. It asks what to open, lets you pick
# the folder with the system's folder picker, makes a new piece when asked,
# and runs the editor in this window: Ctrl C, or closing the window, stops
# the editor. The installers copy it into the installation, beside runtime/
# and app/. Written for bash 3.2 and later.

here=$(cd "$(dirname "$0")" && pwd -P)
node="$here/runtime/bin/node"
cli="$here/app/lib/src/cli/index.js"

# Everything the launcher says goes to stderr, so that stdout carries only
# the folder a picker returns.
tell() { printf '%s\n' "$*" >&2; }

pause() {
  printf '\n%s ' "${1:-Press Return to close this window.}" >&2
  IFS= read -r _ || true
}

# typed_folder <prompt>: a folder typed, or dragged onto the window.
typed_folder() {
  local reply
  tell ""
  tell "$1"
  printf 'Drag the folder onto this window, or type its path, then press Return (Return alone goes back): ' >&2
  IFS= read -r reply || return 1
  # Dragging adds a space, and quotes or backslashes around special characters.
  reply=$(printf '%s' "$reply" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  case $reply in
    \'*\') reply=${reply#\'} && reply=${reply%\'} ;;
    \"*\") reply=${reply#\"} && reply=${reply%\"} ;;
    *\\*) reply=$(printf '%s' "$reply" | sed 's/\\\(.\)/\1/g') ;;
  esac
  # A typed ~ stands for the home folder, as it would at a prompt.
  # shellcheck disable=SC2088
  case $reply in
    '~') reply=$HOME ;;
    '~/'*) reply="$HOME/${reply#'~/'}" ;;
  esac
  [ -n "$reply" ] || return 1
  if [ ! -d "$reply" ]; then
    tell "There is no folder at $reply."
    return 1
  fi
  (cd "$reply" && pwd -P)
}

# choose_folder <prompt>: the folder picked, on stdout; status 1 when the
# picker was cancelled. Where there is no picker, the path is typed.
choose_folder() {
  local chosen start
  if [ "$(uname -s)" = Darwin ]; then
    if chosen=$(osascript -e 'on run argv' -e 'activate' \
      -e 'return POSIX path of (choose folder with prompt (item 1 of argv) default location (path to documents folder))' \
      -e 'end run' "$1" 2>&1); then
      :
    else
      case $chosen in
        *-128*) return 1 ;;
      esac
      typed_folder "$1"
      return
    fi
  elif [ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ] && command -v zenity >/dev/null 2>&1; then
    start=$(xdg-user-dir DOCUMENTS 2>/dev/null) || start=''
    [ -d "$start" ] || start=$HOME
    chosen=$(zenity --file-selection --directory --title="$1" --filename="$start/" 2>/dev/null) || return 1
  elif [ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ] && command -v kdialog >/dev/null 2>&1; then
    chosen=$(kdialog --title "$1" --getexistingdirectory "$HOME" 2>/dev/null) || return 1
  else
    typed_folder "$1"
    return
  fi
  chosen=${chosen%/}
  [ -n "$chosen" ] || return 1
  printf '%s\n' "$chosen"
}

# empty_folder <folder>: nothing in it but, on a Mac, the .DS_Store Finder may
# leave in a folder it has shown, which goes, since new needs an empty folder.
empty_folder() {
  local entries
  entries=$(ls -A "$1" 2>/dev/null) || return 1
  if [ "$entries" = .DS_Store ] && [ "$(uname -s)" = Darwin ]; then
    rm -f "$1/.DS_Store"
    entries=''
  fi
  [ -z "$entries" ]
}

# run_editor <folder>: the editor, in this window, until Ctrl C or the window
# closes. The trap keeps this script alive through Ctrl C, which the editor
# handles, so an error stays on screen.
run_editor() {
  local status
  tell ""
  trap ':' INT
  (cd "$(dirname "$1")" && "$node" "$cli" edit "$(basename "$1")")
  status=$?
  trap - INT
  [ "$status" = 0 ] || pause "The editor stopped with an error. Press Return to close this window."
  exit "$status"
}

open_piece() {
  local folder
  folder=$(choose_folder 'Choose the piece folder: the one that holds papeleria.yaml.') || return 0
  if [ ! -f "$folder/papeleria.yaml" ] && [ ! -f "$folder/papeleria.json" ]; then
    tell ""
    tell "$folder holds no papeleria.yaml, so it is not a Papeleria piece. Choose the folder that holds it, or make a new piece."
    return 0
  fi
  run_editor "$folder"
}

new_piece() {
  local template=$1 place folder name
  place=$(choose_folder "Choose where the new $template goes. An empty folder becomes the $template itself.") || return 0
  if empty_folder "$place"; then
    folder=$place
  else
    tell ""
    tell "$place is not empty, so the $template goes in a new folder inside it."
    printf 'Name for the new folder [my-%s]: ' "$template" >&2
    IFS= read -r name || return 0
    name=${name:-my-$template}
    case $name in
      */* | . | ..)
        tell "A folder name cannot hold a / or be . or ..; nothing was made."
        return 0
        ;;
    esac
    folder="$place/$name"
  fi
  tell ""
  if ! (cd "$(dirname "$folder")" && "$node" "$cli" new "$template" "$(basename "$folder")"); then
    pause "Nothing was made. Press Return to go back."
    return 0
  fi
  run_editor "$folder"
}

if [ ! -x "$node" ] || [ ! -f "$cli" ]; then
  tell "This Papeleria installation is incomplete: $cli is missing. Run the Papeleria installer again."
  pause
  exit 2
fi
version=$("$node" "$cli" --version 2>/dev/null)
[ -t 2 ] && printf '\033]0;Papeleria\007' >&2

while :; do
  tell ""
  tell "Papeleria $version"
  tell ""
  tell "  1  Open a piece in the editor"
  tell "  2  Make a new deck"
  tell "  3  Make a new comic"
  tell "  4  Make a new document"
  tell "  q  Quit"
  tell ""
  printf 'Type 1, 2, 3, 4 or q, then press Return: ' >&2
  IFS= read -r choice || exit 0
  case $choice in
    1) open_piece ;;
    2) new_piece deck ;;
    3) new_piece comic ;;
    4) new_piece document ;;
    q | Q) exit 0 ;;
  esac
done
