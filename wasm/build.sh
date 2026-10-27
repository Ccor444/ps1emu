#!/bin/bash
# Compila wasm/cpu.c -> src/wasmbin.js (base64). Precisa de clang com alvo wasm32 e wasm-ld.
set -e
cd "$(dirname "$0")"
clang --target=wasm32 ${OPT:--O3} -nostdlib -ffreestanding -fno-builtin -fno-exceptions -mbulk-memory -msign-ext -fvisibility=hidden ${XFLAGS} \
  -Wl,--no-entry -Wl,--import-memory -Wl,--initial-memory=10485760 -Wl,--max-memory=10485760 -Wl,-z,stack-size=32768 -Wl,${STRIP:---strip-all} \
  -o cpu.wasm cpu.c
node -e "const b=require('fs').readFileSync('cpu.wasm');require('fs').writeFileSync('../src/wasmbin.js','// gerado por wasm/build.sh (não edite)\nexport const WASM_B64 = \''+b.toString('base64')+'\';\n');console.log('wasm',b.length,'bytes')"
