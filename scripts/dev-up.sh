#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_HOME="${AGENTWAYPOINT_DEV_HOME:-$ROOT_DIR/.agentwaypoint-dev}"

cd "$ROOT_DIR"
exec env AGENTWAYPOINT_HOME="$DEV_HOME" ./agent-waypoint start --home "$DEV_HOME"
