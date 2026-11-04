#!/bin/sh
# Starts the BNSS94 mail helper. Keep this terminal open while you work.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Install the LTS version from https://nodejs.org"; exit 1; }
exec node mail-helper.js "$@"
