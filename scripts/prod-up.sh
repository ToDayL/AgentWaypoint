#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROD_HOME="${AGENTWAYPOINT_HOME:-$HOME/.agentwaypoint}"

cd "$ROOT_DIR"
exec ./agent-waypoint start --home "$PROD_HOME"
