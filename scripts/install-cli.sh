#!/usr/bin/env bash
# Install the whisk CLI from this checkout: dependencies, a `whisk` on PATH,
# and with --skill the agent skill. Re-running it is safe.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
bin_dir="${WHISK_BIN_DIR:-$HOME/.local/bin}"

command -v bun >/dev/null || { echo "whisk runs on Bun: curl -fsSL https://bun.sh/install | bash" >&2; exit 1; }

(cd "$root" && bun install)
mkdir -p "$bin_dir"
ln -sf "$root/packages/cli/bin/whisk" "$bin_dir/whisk"
echo "Linked $bin_dir/whisk"
case ":$PATH:" in *":$bin_dir:"*) ;; *) echo "Add $bin_dir to your PATH." ;; esac

if [ "${1:-}" = "--skill" ]; then "$bin_dir/whisk" snippet skill; fi
echo "Next: whisk auth"
