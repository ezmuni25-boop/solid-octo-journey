#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install it from https://nodejs.org (the LTS button), then open this file again."
  open https://nodejs.org
  read -p "Press Enter to close"
  exit 1
fi
(sleep 2; open http://localhost:3000) &
node server.js
