#!/usr/bin/env bash
# Build the public tree (github.com/ashot/whisk) from this checkout plus the
# platform packages Whisk builds against, vendored under platform/packages.
# Whisk's own files come from the working tree, so uncommitted work counts, as
# it does for every deploy; platform comes from its committed HEAD, the version
# the deploys build against. The destination is replaced wholesale except for
# its .git and node_modules. ./deploy.sh public runs this and pushes the result.
#
#   scripts/export-public.sh ../whisk
#   scripts/export-public.sh --packages     the platform packages it vendors
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
platform="${PLATFORM_ROOT:-$root/../platform}"

# The platform packages Whisk's package.json files name, and nothing else.
packages=$(cd "$root" && git ls-files -co --exclude-standard 'packages/*/package.json' | xargs grep -ho '"@platform/[a-z-]*"' | tr -d '"' | sed 's#@platform/##' | sort -u | tr '\n' ' ')
[ "${1:-}" = "--packages" ] && { echo $packages; exit 0; }

dest="${1:?usage: scripts/export-public.sh <dest-dir>}"
if [ -d "$dest" ] && [ ! -d "$dest/.git" ] && [ -n "$(ls -A "$dest")" ]; then
  echo "Refusing to export into $dest: it has files and is not a git checkout, and the export replaces its contents." >&2
  exit 1
fi

# Private working notes and maintainer release scripts that need credentials
# or platform's deploy engine, which the public tree does not carry.
exclude='^(docs/REVIEW_FINDINGS\.md|deploy\.sh|packages/desktop/scripts/release\.sh|\.codecast/)'

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

git -C "$root" ls-files -co --exclude-standard | grep -Ev "$exclude" | rsync -a --files-from=- "$root/" "$stage/"

mkdir -p "$stage/platform"
git -C "$platform" archive HEAD tsconfig.base.json $(for p in $packages; do echo "packages/$p"; done) | tar -x -C "$stage/platform"

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
