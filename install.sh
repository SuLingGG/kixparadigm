#!/usr/bin/env bash
# Install the kixparadigm presets into the active DSH_HOME.
set -euo pipefail
cd "$(dirname "$0")"
node bin/kixparadigm.js install "$@"
