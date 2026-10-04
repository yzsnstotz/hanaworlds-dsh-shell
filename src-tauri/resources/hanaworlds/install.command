#!/bin/bash
set -euo pipefail
umask 077

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
default_candidate="$(cd "$script_dir/../../../.." && pwd -P)"
candidate="${1:-$default_candidate}"
install_root="${2:-/Applications}"
backup_root="${3:-$HOME/.cache/hanaworlds-runs/client-upgrade-backups}"
data_root="${4:-$HOME/.hanaworlds}"

fail() {
  echo "HanaWorlds installer: $*" >&2
  exit 1
}

identity() {
  /usr/bin/codesign -dv --verbose=2 "$1" 2>&1 | /usr/bin/sed -n 's/^Identifier=//p' | /usr/bin/head -n 1
}

verify_app() {
  local app="$1" bundle_id="" signing_id="" resource_root=""
  [ -d "$app" ] || fail "app missing: $app"
  [ ! -L "$app" ] || fail "app is a symlink: $app"
  bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist" 2>/dev/null)" || fail "candidate bundle identifier missing"
  signing_id="$(identity "$app")"
  [ "$bundle_id" = HanaWorlds ] && [ "$signing_id" = HanaWorlds ] || fail "identity mismatch: bundle=$bundle_id signing=$signing_id"
  /usr/bin/codesign --verify --deep --strict "$app" >/dev/null 2>&1 || fail "candidate signature invalid"
  resource_root="$app/Contents/Resources/resources"
  [ -f "$resource_root/hanaworlds/build-id.txt" ] || fail "build identity missing"
  /usr/bin/grep -Eq '^[0-9a-f]{64}$' "$resource_root/hanaworlds/build-id.txt" || fail "build identity invalid"
  for entry in node/bin/node dsh/node_modules/@deepseek-ai/dsh/lib/bin.js pnpm/bin/pnpm.cjs node_modules/dsh-tauri/package.json; do
    [ -f "$resource_root/$entry" ] || fail "bundled runtime missing: $entry"
  done
  while IFS= read -r -d '' link; do
    local resolved=""
    resolved="$(/bin/realpath "$link")" || fail "broken bundled link: $link"
    case "$resolved" in "$app/"*) ;; *) fail "external bundled link: $link -> $resolved" ;; esac
  done < <(/usr/bin/find "$app" -type l -print0)
}

verify_legacy_applet() {
  local app="$1" executable=""
  [ -d "$app" ] && [ ! -L "$app" ] || fail "legacy applet missing or linked"
  [ "$(identity "$app")" = HanaWorlds ] || fail "legacy applet identity mismatch"
  executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist" 2>/dev/null)" || fail "legacy applet executable missing"
  [ "$executable" = applet ] && [ -f "$app/Contents/Resources/Scripts/main.scpt" ] || fail "legacy applet contents invalid"
  /usr/bin/codesign --verify --deep --strict "$app" >/dev/null 2>&1 || fail "legacy applet signature invalid"
}

verify_replacement() {
  if [ "$rollback_mode" = 1 ] && ! /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" >/dev/null 2>&1; then
    verify_legacy_applet "$1"
  else
    verify_app "$1"
  fi
}

[ -d "$install_root" ] || fail "install root missing: $install_root"
install_root="$(cd "$install_root" && pwd -P)"
target="$install_root/HanaWorlds.app"
[ -d "$target" ] && [ ! -L "$target" ] || fail "existing HanaWorlds.app entry missing or linked"
[ "$(identity "$target")" = HanaWorlds ] || fail "installed app identity mismatch"
[ ! -L "$backup_root" ] || fail "backup root is a symlink"
mkdir -p "$backup_root"
backup_root="$(cd "$backup_root" && pwd -P)"
/bin/chmod 700 "$backup_root"
[ ! -L "$data_root" ] || fail "profile root is a symlink"

rollback_mode=0
if [ "$candidate" = rollback ]; then
  rollback_mode=1
  [ -f "$backup_root/last" ] || fail "no previous app backup"
  candidate="$(cat "$backup_root/last")"
  case "$candidate" in "$backup_root"/previous.*/HanaWorlds.app) ;; *) fail "backup path is outside backup root" ;; esac
  source_backup="$(dirname "$candidate")"
  [ -f "$source_backup/profile-present" ] || [ -f "$source_backup/profile-absent" ] || fail "previous profile snapshot missing"
fi

candidate="$(cd "$candidate" && pwd -P)"
[ "$candidate" != "$target" ] || fail "candidate is the installed app"
verify_replacement "$candidate"

stage="$(/usr/bin/mktemp -d "$install_root/.HanaWorlds-stage.XXXXXX")"
backup="$(/usr/bin/mktemp -d "$backup_root/previous.XXXXXX")"
swapped=0
data_swapped=0
cleanup() {
  if [ "$swapped" = 1 ]; then
    /bin/rm -rf "$target"
    /bin/mv "$stage/previous.app" "$target"
  fi
  if [ "$data_swapped" = 1 ]; then
    /bin/rm -rf "$data_root"
    /bin/mv "$backup/newer-data" "$data_root"
  fi
  /bin/rm -rf "$stage"
}
trap cleanup EXIT

/usr/bin/ditto "$candidate" "$stage/HanaWorlds.app"
verify_replacement "$stage/HanaWorlds.app"
/usr/bin/ditto "$target" "$backup/HanaWorlds.app"
[ "$(identity "$backup/HanaWorlds.app")" = HanaWorlds ] || fail "backup identity mismatch"
if [ -d "$data_root" ]; then
  /usr/bin/ditto "$data_root" "$backup/profile"
  /usr/bin/touch "$backup/profile-present"
elif [ ! -e "$data_root" ]; then
  /usr/bin/touch "$backup/profile-absent"
else
  fail "profile root is not a directory"
fi
if [ "$rollback_mode" = 1 ] && [ -f "$source_backup/profile-present" ]; then
  /usr/bin/ditto "$source_backup/profile" "$stage/restore-profile"
fi
/bin/mv "$target" "$stage/previous.app"
swapped=1
/bin/mv "$stage/HanaWorlds.app" "$target"
verify_replacement "$target"
if [ "$rollback_mode" = 1 ]; then
  if [ -d "$data_root" ]; then
    /bin/mv "$data_root" "$backup/newer-data"
    data_swapped=1
  fi
  if [ -f "$source_backup/profile-present" ]; then
    /bin/mv "$stage/restore-profile" "$data_root"
  fi
fi
printf '%s\n' "$backup/HanaWorlds.app" > "$backup_root/last.tmp"
/bin/mv "$backup_root/last.tmp" "$backup_root/last"
swapped=0
data_swapped=0
echo "HanaWorlds installer: updated $target; rollback backup $backup/HanaWorlds.app"
