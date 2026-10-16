#!/bin/sh
set -e
[ -x "$CMOD_DATA/bin/oneclaude-install" ] || exit 0
"$CMOD_DATA/bin/oneclaude-install" --remove --data "$CMOD_DATA"
