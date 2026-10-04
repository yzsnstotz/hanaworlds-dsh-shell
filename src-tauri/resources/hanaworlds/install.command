#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
default_candidate="$(cd "$script_dir/../../../.." && pwd -P)"
candidate="${1:-$default_candidate}"
install_root="${2:-/Applications}"
backup_root="${3:-$HOME/.cache/hanaworlds-runs/client-upgrade-backups}"

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

[ -d "$install_root" ] || fail "install root missing: $install_root"
install_root="$(cd "$install_root" && pwd -P)"
target="$install_root/HanaWorlds.app"
[ -d "$target" ] && [ ! -L "$target" ] || fail "existing HanaWorlds.app entry missing or linked"
[ "$(identity "$target")" = HanaWorlds ] || fail "installed app identity mismatch"
[ ! -L "$backup_root" ] || fail "backup root is a symlink"
mkdir -p "$backup_root"
backup_root="$(cd "$backup_root" && pwd -P)"

if [ "$candidate" = rollback ]; then
  [ -f "$backup_root/last" ] || fail "no previous app backup"
  candidate="$(cat "$backup_root/last")"
fi

candidate="$(cd "$candidate" && pwd -P)"
[ "$candidate" != "$target" ] || fail "candidate is the installed app"
verify_app "$candidate"

stage="$(/usr/bin/mktemp -d "$install_root/.HanaWorlds-stage.XXXXXX")"
backup="$(/usr/bin/mktemp -d "$backup_root/previous.XXXXXX")"
swapped=0
cleanup() {
  if [ "$swapped" = 1 ]; then
    /bin/rm -rf "$target"
    /bin/mv "$stage/previous.app" "$target"
  fi
  /bin/rm -rf "$stage"
}
trap cleanup EXIT

/usr/bin/ditto "$candidate" "$stage/HanaWorlds.app"
verify_app "$stage/HanaWorlds.app"
/usr/bin/ditto "$target" "$backup/HanaWorlds.app"
[ "$(identity "$backup/HanaWorlds.app")" = HanaWorlds ] || fail "backup identity mismatch"
/bin/mv "$target" "$stage/previous.app"
swapped=1
/bin/mv "$stage/HanaWorlds.app" "$target"
verify_app "$target"
swapped=0
printf '%s\n' "$backup/HanaWorlds.app" > "$backup_root/last.tmp"
/bin/mv "$backup_root/last.tmp" "$backup_root/last"
echo "HanaWorlds installer: updated $target; rollback backup $backup/HanaWorlds.app"
