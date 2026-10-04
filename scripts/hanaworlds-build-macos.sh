#!/bin/bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd -P)"
case "$repo" in "$HOME/.cache/hanaworlds-runs/S1-SHELL-CLIENT-UPGRADE-01/"*) ;; *) echo 'Build only an isolated source copy under ~/.cache/hanaworlds-runs/S1-SHELL-CLIENT-UPGRADE-01/' >&2; exit 1 ;; esac
cd "$repo"
export CARGO_TARGET_DIR="$repo/src-tauri/target"

[ "$#" -eq 1 ] || { echo 'Usage: hanaworlds-build-macos.sh <exact public dsh-pkg tag>' >&2; exit 1; }
dsh_tag="$1"
case "$dsh_tag" in dsh-*) ;; *) echo 'Expected a pinned dsh-pkg release tag' >&2; exit 1 ;; esac
export DSH_TAG="$dsh_tag"
recommended="$(node --input-type=module -e 'import { readRecommendedDshVersion } from "./scripts/bundle-metadata.mjs"; process.stdout.write(readRecommendedDshVersion())')"
case "$dsh_tag" in "dsh-$recommended-"[0-9]*) ;; *) echo "Tag must match recommended dsh $recommended" >&2; exit 1 ;; esac

platform=macos
case "$(uname -m)" in arm64) arch=arm64 ;; x86_64) arch=x64 ;; *) echo 'Unsupported Mac architecture' >&2; exit 1 ;; esac
command -v node >/dev/null || { echo 'Build machine needs Node.js' >&2; exit 1; }
command -v cargo >/dev/null || { echo 'Build machine needs Rust/Cargo' >&2; exit 1; }

work="$(mktemp -d "$repo/.hanaworlds-build.XXXXXX")"
trap 'rm -rf "$work"' EXIT

sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
fetch() { curl -fL "$1" -o "$2"; }
verify() { [ -n "$2" ] && [ "$(sha256 "$1")" = "$2" ] || { echo "SHA-256 mismatch or absent for $1" >&2; exit 1; }; }

while IFS='|' read -r key name url digest sha_url; do
  [ -n "$key" ] || continue
  archive="$work/$name"
  fetch "$url" "$archive"
  case "$key" in
    node)
      fetch "$sha_url" "$work/SHASUMS256.txt"
      digest="$(awk -v asset="$name" '$2 == asset {print $1}' "$work/SHASUMS256.txt")"
      ;;
    dsh)
      fetch "https://api.github.com/repos/dsh-tauri-desk/deepseek-harness-pkg/releases/tags/$dsh_tag" "$work/release.json"
      digest="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const a=j.assets.find(x=>x.name===process.argv[2]);process.stdout.write(a?.digest?.replace(/^sha256:/,"")??"")' "$work/release.json" "$name")"
      ;;
  esac
  verify "$archive" "$digest"
  dest="src-tauri/resources/$key"
  rm -rf "$dest"
  mkdir -p "$dest"
  case "$archive" in *.zip) unzip -q "$archive" -d "$dest" ;; *) tar -xzf "$archive" -C "$dest" ;; esac
  entries=("$dest"/*)
  if [ "${#entries[@]}" -eq 1 ] && [ -d "${entries[0]}" ]; then
    inner="${entries[0]}"
    /usr/bin/ditto "$inner" "$work/flatten-$key"
    rm -rf "$dest"
    mv "$work/flatten-$key" "$dest"
  fi
done < <(node scripts/bundle-metadata.mjs --assets --platform "$platform" --arch "$arch" | sed '/^$/d')

node scripts/bundle-metadata.mjs --manifest --platform "$platform" --arch "$arch"
for entry in node/bin/node dsh/node_modules/@deepseek-ai/dsh/lib/bin.js pnpm/bin/pnpm.cjs; do
  [ -f "src-tauri/resources/$entry" ] || { echo "Bundled entry missing: $entry" >&2; exit 1; }
done

node_bin="$repo/src-tauri/resources/node/bin/node"
pnpm_bin="$repo/src-tauri/resources/pnpm/bin/pnpm.cjs"
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$node_bin" "$pnpm_bin" > "$work/pnpm"
chmod +x "$work/pnpm"
export PATH="$work:$repo/src-tauri/resources/node/bin:$PATH"

source_sha="$(git rev-parse HEAD)"
build_id="$(printf '%s\n%s\n%s\n' "$source_sha" "$dsh_tag" "$(sha256 src-tauri/resources/manifest.jsonc)" | shasum -a 256 | awk '{print $1}')"
printf '%s\n' "$build_id" > src-tauri/resources/hanaworlds/build-id.txt
export HANAWORLDS_BUILD_ID="$build_id"
"$node_bin" "$pnpm_bin" install --frozen-lockfile
"$node_bin" "$pnpm_bin" tauri build --config src-tauri/tauri.hanaworlds.conf.json --features hanaworlds-product --bundles app

candidate="src-tauri/target/release/bundle/macos/HanaWorlds.app"
[ -d "$candidate" ] || { echo "Built HanaWorlds.app missing: $candidate" >&2; exit 1; }
/usr/bin/codesign --force --deep --sign - --identifier HanaWorlds "$candidate"
/usr/bin/codesign --verify --deep --strict "$candidate"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$candidate/Contents/Info.plist")" = HanaWorlds ] || { echo 'Built app identity mismatch' >&2; exit 1; }
[ "$(/usr/bin/codesign -dv --verbose=2 "$candidate" 2>&1 | sed -n 's/^Identifier=//p' | head -n 1)" = HanaWorlds ] || { echo 'Built signing identity mismatch' >&2; exit 1; }
echo "$repo/$candidate"
