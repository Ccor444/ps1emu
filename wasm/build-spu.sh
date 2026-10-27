#!/bin/bash
# Compila wasm/spu.c -> src/wasmspu.js (base64). Precisa de clang com alvo wasm32 e wasm-ld.
set -e
cd "$(dirname "$0")"
clang --target=wasm32 ${OPT:--Oz} -nostdlib -ffreestanding -fno-builtin -fno-exceptions -fwrapv -mbulk-memory -msign-ext -fvisibility=hidden \
  -Wl,--no-entry -Wl,--import-memory -Wl,--initial-memory=1114112 -Wl,--max-memory=1114112 -Wl,-z,stack-size=16384 -Wl,--strip-all \
  -o spu.wasm spu.c
node -e "const b=require('fs').readFileSync('spu.wasm');require('fs').writeFileSync('../src/wasmspu.js','// gerado por wasm/build-spu.sh (não edite)\nexport const SPU_B64 = \''+b.toString('base64')+'\';\n');console.log('spu wasm',b.length,'bytes')"
