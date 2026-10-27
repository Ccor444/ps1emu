#!/bin/bash
# Compila wasm/raster.c -> src/wasmraster.js (base64). Precisa de clang com alvo wasm32 e wasm-ld.
set -e
cd "$(dirname "$0")"
clang --target=wasm32 ${OPT:--O3} -nostdlib -ffreestanding -fno-builtin -fno-exceptions -mbulk-memory -msign-ext -msimd128 -fvisibility=hidden \
  -Wl,--no-entry -Wl,--import-memory -Wl,--initial-memory=5242880 -Wl,--max-memory=5242880 -Wl,-z,stack-size=32768 -Wl,--strip-all \
  -o raster.wasm raster.c
node -e "const b=require('fs').readFileSync('raster.wasm');require('fs').writeFileSync('../src/wasmraster.js','// gerado por wasm/build-raster.sh (não edite)\nexport const RASTER_B64 = \''+b.toString('base64')+'\';\n');console.log('raster wasm',b.length,'bytes')"
