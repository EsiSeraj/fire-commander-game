#!/bin/bash
cd "$(dirname "$0")" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 was not found. Install Python 3, then double-click this file again."
  read -r -p "Press Return to close this window."
  exit 1
fi

python3 launch_game.py
