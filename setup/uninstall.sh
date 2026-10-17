#!/bin/sh
set -e
command -v oneclaude > /dev/null || exit 0
oneclaude remove --data "$CMOD_DATA"
