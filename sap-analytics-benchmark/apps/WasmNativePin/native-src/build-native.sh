#!/usr/bin/env bash
# Build DuckDB (multi-TU) + bridge with .NET 10's pinned Emscripten 3.1.56.
# Multi-TU cmake avoids OOM from compiling the full amalgamation in one clang process.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$ROOT/../Native"
SRC="$ROOT/duckdb-src"
BUILD_DIR="$ROOT/build/cmake"
mkdir -p "$OUT_DIR" "$BUILD_DIR" "$ROOT/build"

EMSDK_VER="${EMSDK_VER:-10.0.10}"
DOTNET_ROOT="${DOTNET_ROOT:-$HOME/.dotnet}"
EMSDK_ROOT="$DOTNET_ROOT/packs/Microsoft.NET.Runtime.Emscripten.3.1.56.Sdk.osx-arm64/${EMSDK_VER}"
NODE_ROOT="$DOTNET_ROOT/packs/Microsoft.NET.Runtime.Emscripten.3.1.56.Node.osx-arm64/${EMSDK_VER}/tools/bin"
PY_ROOT="$DOTNET_ROOT/packs/Microsoft.NET.Runtime.Emscripten.3.1.56.Python.osx-arm64/${EMSDK_VER}/tools/python/bin"

if [[ ! -x "$EMSDK_ROOT/tools/emscripten/emcc" ]]; then
  echo "emcc not found under $EMSDK_ROOT" >&2
  exit 1
fi
if [[ ! -f "$SRC/CMakeLists.txt" ]]; then
  echo "Missing $SRC — clone duckdb v1.2.2 into native-src/duckdb-src first." >&2
  exit 1
fi

export DOTNET_EMSCRIPTEN_LLVM_ROOT="$EMSDK_ROOT/tools/bin"
export DOTNET_EMSCRIPTEN_BINARYEN_ROOT="$EMSDK_ROOT/tools"
export DOTNET_EMSCRIPTEN_NODE_JS="$NODE_ROOT/node"
export EM_CACHE="$ROOT/build/em-cache"
mkdir -p "$EM_CACHE"
# .emscripten does bool(getenv('FROZEN_CACHE','True')) — empty => False
export FROZEN_CACHE=
export PATH="$EMSDK_ROOT/tools/emscripten:$EMSDK_ROOT/tools/bin:$NODE_ROOT:$PY_ROOT:$PATH"
export CC=emcc
export CXX=em++
export AR=emar
export RANLIB=emranlib

echo "Using emcc: $(emcc --version | head -1)"

JOBS="${JOBS:-2}"
CXX_FLAGS="-O1 -g0 -fwasm-exceptions -DDUCKDB_NO_THREADS"
C_FLAGS="-O1 -g0 -fwasm-exceptions -DDUCKDB_NO_THREADS"

echo "Configuring DuckDB for wasm32 (Emscripten 3.1.56)…"
emcmake cmake -S "$SRC" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="$C_FLAGS" \
  -DCMAKE_CXX_FLAGS="$CXX_FLAGS" \
  -DBUILD_UNITTESTS=FALSE \
  -DBUILD_SHELL=FALSE \
  -DBUILD_BENCHMARKS=FALSE \
  -DDISABLE_THREADS=TRUE \
  -DDUCKDB_EXPLICIT_PLATFORM="wasm_eh" \
  -DENABLE_EXTENSION_AUTOLOADING=0 \
  -DENABLE_EXTENSION_AUTOINSTALL=0 \
  -DBUILD_EXTENSIONS="" \
  -DDISABLE_BUILTIN_EXTENSIONS=1 \
  -DOVERRIDE_GIT_DESCRIBE="v1.2.2"

echo "Building libduckdb_static (jobs=$JOBS)…"
cmake --build "$BUILD_DIR" --target duckdb_static -j"$JOBS"
cmake --build "$BUILD_DIR" --target core_functions_extension -j"$JOBS" || true

echo "Compiling duckdb_bridge.c…"
emcc $C_FLAGS -I"$ROOT" -I"$SRC/src/include" -c "$ROOT/duckdb_bridge.c" -o "$ROOT/build/duckdb_bridge.o"

# Companion archives required by libduckdb_static (not folded into it).
LIBS=(
  "$BUILD_DIR/src/libduckdb_static.a"
  "$BUILD_DIR/extension/core_functions/libcore_functions_extension.a"
  "$BUILD_DIR/third_party/re2/libduckdb_re2.a"
  "$BUILD_DIR/third_party/libpg_query/libduckdb_pg_query.a"
  "$BUILD_DIR/third_party/utf8proc/libduckdb_utf8proc.a"
  "$BUILD_DIR/third_party/yyjson/libduckdb_yyjson.a"
  "$BUILD_DIR/third_party/fmt/libduckdb_fmt.a"
  "$BUILD_DIR/third_party/fsst/libduckdb_fsst.a"
  "$BUILD_DIR/third_party/hyperloglog/libduckdb_hyperloglog.a"
  "$BUILD_DIR/third_party/fastpforlib/libduckdb_fastpforlib.a"
  "$BUILD_DIR/third_party/mbedtls/libduckdb_mbedtls.a"
  "$BUILD_DIR/third_party/miniz/libduckdb_miniz.a"
  "$BUILD_DIR/third_party/skiplist/libduckdb_skiplistlib.a"
  "$BUILD_DIR/third_party/zstd/libduckdb_zstd.a"
)

for lib in "${LIBS[@]}"; do
  if [[ ! -f "$lib" ]]; then
    echo "Missing required archive: $lib" >&2
    exit 1
  fi
done

# FileName must be duckdb_native (no lib prefix) so DllImport("duckdb_native") matches
# the Blazor PInvoke module name. Whole-archive into one .o so wasm-ld keeps all members.
echo "Creating duckdb_native.o (whole-archive of DuckDB + deps + bridge)…"
rm -f "$OUT_DIR/duckdb_native.o" "$OUT_DIR/duckdb_native.a" "$OUT_DIR/libduckdb_native.a"
llvm-ar rcs "$OUT_DIR/duckdb_native.a" "$ROOT/build/duckdb_bridge.o"

ARGS=()
for lib in "${LIBS[@]}"; do
  ARGS+=(-Wl,--whole-archive "$lib" -Wl,--no-whole-archive)
done
ARGS+=(-Wl,--whole-archive "$OUT_DIR/duckdb_native.a" -Wl,--no-whole-archive)

emcc -r -o "$OUT_DIR/duckdb_native.o" "${ARGS[@]}"

cp "$SRC/src/include/duckdb.h" "$OUT_DIR/duckdb.h" 2>/dev/null || cp "$ROOT/duckdb.h" "$OUT_DIR/duckdb.h"

ls -lh "$OUT_DIR/duckdb_native.o"
echo "Done."
