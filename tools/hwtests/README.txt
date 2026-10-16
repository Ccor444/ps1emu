Suíte de hardware (ps1-tests, JaCzekanski) rodando no emulador
================================================================
Os testes são programas PS-X EXE escritos para o console real; cada pasta tem um psx.log com a saída gravada num PS1 de verdade.
Aqui eles são compilados com clang (alvo mipsel R3000) + libpsn00b, rodam sobre a BIOS real (sem disco) e a saída é comparada com o log.

Preparar (precisa de clang, ld.lld, llvm-ar/objcopy/nm, python3):
  git clone --depth 1 https://github.com/JaCzekanski/ps1-tests
  git clone --depth 1 https://github.com/Lameguy64/psn00bsdk
  export PS1TESTS=$PWD/ps1-tests PSN00B=$PWD/psn00bsdk HWLIBS=/tmp/hwlibs
Rodar:
  bash tools/hwtests/suite.sh                  # todos os testes da lista
  bash tools/hwtests/suite.sh dma/dpcr gpu/gp0-e1
  node tools/hwtests/run.mjs teste.exe psx.log [quadros]   # um teste, mostrando as diferenças
  node tools/hwtests/dbg.mjs teste.exe 300     # depura (últimas instruções, registradores) quando o teste trava
Arquivos: build_libs.sh (compila as libs do SDK), build_test.py (teste -> EXE), compat.h/shim.cpp/include (diferenças entre o
SDK antigo e o atual), run.mjs (executa e compara), suite.sh (lote).

Resultados (BIOS SCPH1001):
  gpu/gp0-e1      11/11  (corrigido: bits de GPUSTAT do E1, textura "3", texture-disable só com GP1(09))
  gpu/mask-bit     6/6
  gpu/gpustat     todas as asserções passam (as linhas "diferentes" são erros de digitação no log antigo)
  dma/otc-test    todas as asserções passam (o fonte atual tem 1 teste a mais que o log)
  dma/dpcr        10/13 (só difere o valor inicial do DPCR, que depende de quem inicializou: SDK/BIOS)
  dma/chopping    termina; tempos dentro de ~6% em média dos medidos no console (antes: travava no modo 0)
  gpu/bandwidth   vazões de fill/retângulo/polígono dentro de ~1% do console real (GPU agora fica "ocupada" por comando)
Limitações conhecidas (não são bugs do emulador, ou ainda não modelados):
  cpu/access-time  agora RAM/BIOS/scratchpad/expansões/I-O/CD/SPU por largura (8/16/32) ficam a ~0,3 ciclo do console; o cache de instruções
                   e o buffer de escrita ainda não são modelados (por isso o laço do chain-looping leva 10k contra 16k ciclos)
  dma/chain-looping  a CPU não é desacelerada pelo DMA (sem contenção de barramento); o SDK novo reconhece o DICR no handler
  spu/memory-transfer  strings/buffers sem alinhamento de 4 bytes no clang: o DMA alinha o endereço e desloca os dados
  mdec/*           o fonte atual do teste e o psx.log são de versões diferentes
  timers, cpu/code-in-io, cpu/io-access-bitwidth, gte/test-all: não compilam com clang (extensões do gcc, swc0/cop2 e
                   cabeçalhos de assembly do SDK antigo)

GPU (comparação de VRAM com vram.png do console real): test/gpu-exact.test.js (executáveis em test/fixtures/gpu).
  quad, texture-overflow, transparency, triangle, uv-interpolation, texture-flip, clut-cache, lines, vram-to-vram-overlap: 0 pixels diferentes.

cpu/cop: compila trocando swc0/2/3 por .word (fixture em test/fixtures/cpu, test/cop.test.js): 17/17 asserções iguais ao console real.
  Corrigido: COP1/COP3 e LWC/SWC 0,1,3 só dão Coprocessor Unusable com o bit CU desligado (ligado = NOP); LWC2/SWC2 também checam CU2; COP0 com rs inválido não gera exceção.

cdrom/timing (precisa de disco; psxcd agora entra em build_libs.sh): tempos do CD-ROM ajustados às médias do console real:
  setor 1x 448342 / 2x 223825 ciclos, 1º setor após Setloc+ReadN ~784k (1x) / ~865k (2x), Pause durante leitura ~1,01M, Init completo ~476k.
