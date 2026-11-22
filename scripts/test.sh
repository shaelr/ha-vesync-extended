#!/usr/bin/env bash
# Run this integration's tests inside a Home Assistant core checkout.
# Usage: scripts/test.sh [extra pytest args]
# Needs: git, uv (https://docs.astral.sh/uv/). Python 3.14 is fetched by uv.
set -euo pipefail

HA_VERSION="${HA_VERSION:-2026.11.2}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE="$ROOT/.ha-core"

if [ ! -d "$CORE/.git" ]; then
  echo "Checking out Home Assistant $HA_VERSION into .ha-core ..."
  git clone --depth 1 --branch "$HA_VERSION" https://github.com/home-assistant/core.git "$CORE"
fi

cd "$CORE"
if [ ! -x .venv/bin/python ]; then
  echo "Building the test environment (first run only) ..."
  uv venv -p 3.14 .venv
  uv pip install -p .venv/bin/python -e . -r requirements_test.txt \
    -e packages/pytest-homeassistant \
    aiohasupervisor==0.8.1 pyvesync==3.5.1
  .venv/bin/python -m script.translations develop --all >/dev/null
fi

rm -rf homeassistant/components/vesync tests/components/vesync
cp -r "$ROOT/custom_components/vesync" homeassistant/components/vesync
cp -r "$ROOT/tests/vesync" tests/components/vesync
.venv/bin/python -m script.translations develop --integration vesync >/dev/null

.venv/bin/ruff check homeassistant/components/vesync tests/components/vesync
.venv/bin/ruff format --check homeassistant/components/vesync tests/components/vesync
.venv/bin/python -m pytest tests/components/vesync -q -p no:cacheprovider "$@"

# Bring updated snapshots back into the repo.
cp tests/components/vesync/snapshots/*.ambr "$ROOT/tests/vesync/snapshots/"
