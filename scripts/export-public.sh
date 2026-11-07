#!/usr/bin/env bash
# Build the public tree (github.com/ashot/whisk) from this checkout plus the
# platform packages Whisk builds against, vendored under platform/packages.
# The destination is replaced wholesale except for its .git, so re-running
# after changes here is a plain sync: review `git -C <dest> diff`, commit, push.
#
#   scripts/export-public.sh ../whisk-public
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
platform="${PLATFORM_ROOT:-$root/../platform}"
dest="${1:?usage: scripts/export-public.sh <dest-dir>}"

# The platform packages Whisk's package.json files name, and nothing else.
packages="auth cli-kit crypto design desktop engine engine-convex keys push snippets"

# Private working notes and maintainer release scripts that need credentials
# or platform's deploy engine, which the public tree does not carry.
exclude='^(docs/REVIEW_FINDINGS\.md|deploy\.sh|packages/desktop/scripts/release\.sh|\.codecast/)'

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

git -C "$root" ls-files -co --exclude-standard | grep -Ev "$exclude" | rsync -a --files-from=- "$root/" "$stage/"

mkdir -p "$stage/platform/packages"
cp "$platform/tsconfig.base.json" "$stage/platform/"
for p in $packages; do
  git -C "$platform" ls-files -co --exclude-standard "packages/$p" | rsync -a --files-from=- "$platform/" "$stage/platform/"
done

cat > "$stage/platform/README.md" <<'EOF'
# platform

The parts of the shared engine Whisk is built on, the same packages Codecast
runs on: the local-first sync engine (`engine`, `engine-convex`), auth,
crypto, push, the key binding engine, the Electron shell (`desktop`), design
tokens, and the CLI kit and agent snippet installer the `whisk` CLI uses.
They are vendored here so this repository builds on its own.
EOF

# In the private layout platform sits beside this repo; here it sits inside.
find "$stage/packages" -name package.json -not -path '*/node_modules/*' -print0 |
  xargs -0 sed -i '' 's#file:\.\./\.\./\.\./platform/packages/#file:../../platform/packages/#g'
sed -i '' -e 's#file:\.\./\.\./\.\./platform/packages/#file:../../platform/packages/#g' \
  -e 's#file:\.\./platform/packages/#file:platform/packages/#g' "$stage/bun.lock"

mkdir -p "$dest"
rsync -a --delete --exclude .git --exclude node_modules "$stage/" "$dest/"
echo "Exported to $dest"
