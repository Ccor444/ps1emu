#!/bin/bash
# Compila e roda os testes do ps1-tests; mostra um resumo (iguais/total) por teste.
# env: PS1TESTS PSN00B HWLIBS (saida) BIOS ; uso: bash suite.sh [teste...]
HERE=$(cd "$(dirname "$0")" && pwd); export PS1TESTS=${PS1TESTS:-/home/claude/jaczekanski/ps1-tests} HWLIBS=${HWLIBS:-/tmp/hwlibs}
mkdir -p $HWLIBS/exe; [ -f $HWLIBS/libpsn00b.a ] || OUT=$HWLIBS bash $HERE/build_libs.sh >/dev/null
TESTS=${@:-"cpu/access-time cpu/code-in-io cpu/io-access-bitwidth dma/chain-looping dma/chopping dma/dpcr dma/otc-test gpu/gpustat gpu/gp0-e1 gpu/mask-bit gpu/bandwidth timers spu/memory-transfer mdec/4bit mdec/8bit"}
for t in $TESTS; do
  n=$(echo $t | tr / -)
  if ! python3 $HERE/build_test.py $t $HWLIBS/exe/$n.exe > $HWLIBS/exe/$n.build 2>&1; then echo "BUILD  $t: $(grep -v 'MIPS-I' $HWLIBS/exe/$n.build | head -2 | tr '\n' ' ' | cut -c1-140)"; continue; fi
  NAME=$t SHOW=${SHOW:-6} timeout 600 node $HERE/run.mjs $HWLIBS/exe/$n.exe $PS1TESTS/$t/psx.log ${FRAMES:-1500} > $HWLIBS/exe/$n.out 2>&1
  echo "$t: $(grep -E 'iguais|não terminou|ERRO' $HWLIBS/exe/$n.out | tr '\n' ' ')"
done
