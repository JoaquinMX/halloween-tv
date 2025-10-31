#!/usr/bin/env bash
set -euo pipefail

# Prevent channel packages from importing infra implementations.
violations=$(rg --files -g'*.dart' packages/channel_* | xargs -r grep -n "package:infra_" || true)

if [[ -n "$violations" ]]; then
  echo "Boundary check failed: channel packages must not import infra packages." >&2
  echo "$violations" >&2
  exit 1
fi

echo "Boundary check passed."
