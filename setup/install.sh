#!/bin/sh
set -e
echo 'progress 0 5 Building oneclaude'
make -s -C "$CMOD_PLUGIN_ROOT/plugin" build installer BIN="$CMOD_DATA/bin"
"$CMOD_DATA/bin/oneclaude-install" --library "$CMOD_PLUGIN_ROOT/.target/dist/oneclaude-v$CMOD_VERSION.dylib" --data "$CMOD_DATA"
