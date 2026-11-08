#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
package=${1:-$root}
read_path() {
  if [[ -f "$root/.private/$1" ]]; then cat "$root/.private/$1"; fi
}
pi_package=${2:-$(read_path pi-package)}
pi_cli=${3:-$(read_path pi-cli)}
pi_node=${4:-$(read_path pi-node)}
if [[ -z "$pi_package" || -z "$pi_cli" || -z "$pi_node" ]]; then
  echo 'Usage: test-runtime.sh [plugin-dir] <real-pi-package-dir> <real-pi-cli.js> <node-executable> [host-extension ...]' >&2
  echo 'Ignored .private/pi-package, pi-cli and pi-node files may supply defaults.' >&2
  exit 2
fi
[[ -f "$package/native/index.node" && -f "$pi_cli" && -x "$pi_node" ]]
if (( $# >= 4 )); then shift 4; else set --; fi
"$pi_node" "$root/test/runtime.mjs" "$package" "$pi_package" "$pi_cli" "$@"
