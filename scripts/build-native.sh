#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cargo_command=$(command -v cargo || true)
if [[ -z "$cargo_command" && -x "$HOME/.cargo/bin/cargo" ]]; then
  cargo_command="$HOME/.cargo/bin/cargo"
fi
if [[ -z "$cargo_command" ]]; then
  echo 'shazam-pi-goals requires Rust (Cargo >=1.88) and a C linker to build its native addon. Install Rust, then retry the package installation.' >&2
  exit 1
fi
case "$(uname -s)" in
  Darwin) library=libshazam_pi_goals_native.dylib ;;
  Linux) library=libshazam_pi_goals_native.so ;;
  *) echo 'Native builds currently support macOS and Linux only.' >&2; exit 1 ;;
esac
"$cargo_command" build --manifest-path "$root/native/Cargo.toml" --target-dir "$root/native/target" --locked --release
cp "$root/native/target/release/$library" "$root/native/index.node"
