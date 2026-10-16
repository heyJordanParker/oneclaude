#!/bin/sh
set -e
echo 'progress 0 3 Building the routing plugin'
make -s -C "$CMOD_PLUGIN_ROOT/plugin" build installer BIN="$CMOD_DATA/bin"
echo 'progress 2 3 Adding it to your proxy'
"$CMOD_DATA/bin/oneclaude-install" --library "$CMOD_PLUGIN_ROOT/.target/dist/oneclaude-v$CMOD_VERSION.dylib" --data "$CMOD_DATA"
echo 'progress 3 3 oneclaude routes your Claude accounts'
