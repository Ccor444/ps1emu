# Análise dos arquivos

## BIOS — SCPH-1001 (NTSC-U/C), System ROM 2.2 de 04/12/1995
- 512 KB (0x80000), mapeada em 0x1FC00000 (KSEG1 0xBFC00000). Vetor de reset = 0xBFC00000.
- Boot: configura Expansion 2 (0x1F801010) e RAM_SIZE (0x1F801060), copia o kernel (v2.5) para a RAM em 0x500,
  inicializa kernel/eventos/TCB, SPU, GPU, DMA, CD-ROM, depois entra no shell (0x80030000).
- Strings úteis: "PS-X Realtime Kernel Ver.2.5", "KERNEL SETUP!", "BOOTSTRAP LOADER Type C Ver 2.1", "SYSTEM.CNF;1",
  "Licensed by Sony Computer Entertainment Inc." (checagem de região).
- Fonte do shell (ROM font) em ~0x66000. Kernel expõe funções via A0/B0/C0 (nº em $t1).
- Hardware tocado no boot: memctrl 1F801000-1F801020, RAM_SIZE 1F801060, I_STAT/I_MASK 1F801070/74, DMA 1F801080-10F8,
  GPU 1F801810/14, SPU 1F801C00-1F801DFF, POST 1F802041.

## Disco — 100__Star.bin
- BIN cru, 2352 B/setor, MODE2/XA, 29.678 setores (~6:35), 1 trilha de dados.
- ISO9660: volume `SLES_03784` (PAL / Europa — licença "Euro pe").
- Arquivos: SLES_037.84 (boot, 602 112 B), SYSTEM.CNF, MOV/INTRO.STR (5 MB, setores data+RT = vídeo MDEC),
  RES_SC.RES (25 MB, recursos), PSXMIN.CDA (28 MB, setores modo 0/vazios).
- EXE: PC=0x800819F0, texto em 0x80010000 (0x92800 B). SP=0 no header → usa STACK=801FFF00 do SYSTEM.CNF.
- XA-ADPCM: 154 setores (arquivo 1, canal 1, coding 5) — áudio via CD-ROM XA, mixado no SPU.
- ATENÇÃO: BIOS NTSC-U recusa disco europeu → use sideload ou uma BIOS PAL (SCPH-1002/5502/7502).

## Resultado da execucao (boot real)
- BIOS -> kernel 2.5 -> BOOTSTRAP LOADER -> le SYSTEM.CNF -> "boot file cdrom:\\SLES_037.84;1" -> "Execute !" (OK).
- Depois do Execute o jogo le diretorios do disco (LBA 16, 18, 22, 319...), configura XA (Setmode 0xE0, Setfilter 1/0)
  e chama ReadS em 00:02:67 (LBA 12817 = INTRO.STR).
- Falha: em StGetNext (0x8008BE24) o slot do ring (0x80138EDC) ja esta com status 2 (gravado em 0x80093A60 pela propria
  libcd antes do ReadS), a funcao devolve sucesso, e o VLC (0x8008BC04..) decodifica um buffer zerado ate passar de 0x80200000.
  Tabelas Huffman (0x800F0640 / 0x80100640) estao construidas corretamente.
- Hipoteses a investigar: (1) comportamento do CD-ROM (ordem/tempo de INT3/INT1 no ReadS, GetlocL/GetlocP, setfilter),
  (2) MDEC ausente (DMA0/1 + status 0x1F801824), (3) algum detalhe de timing do kernel (callbacks do St*).

## ATUALIZACAO: bug resolvido
O travamento descrito acima era uma flag de DMA presa no DICR (ver ANALISE-REFERENCIA.md). Corrigido em src/dma.js;
o jogo agora chega a tela de titulo. A hipotese (1)/(3) acima estava errada: nao era o CD-ROM nem timing do kernel.

## Memory cards (epsxe000.mcr / epsxe001.mcr)
- Formato: cru, 131072 bytes (16 blocos x 8 KB; 1024 setores x 128 B), assinatura "MC", checksums XOR válidos.
- epsxe000: 1 save `BASLUS-01251` (Final Fantasy IX, "FILE01", 0:41), 1 de 15 blocos usado. epsxe001: vazio.
- Implementado em `src/memcard.js` (cartão/diretório/formatos cru-VGS-DexDrive) e `src/sio.js` (protocolo Read 52h,
  Write 57h, GetID 53h, flag de "cartão novo" 08h, checksum, ACK por byte, setor inválido).
- Validado rodando o 100% Star: o jogo faz 72 leituras e 2 gravações (setor 63 = "MC", o frame de teste da libcard,
  uma em cada cartão) e abre o menu New Game / Load Game / Settings.

## MDEC (vídeo STR)
- `src/mdec.js`: comandos 1 (decodificar), 2 (quantização luma/croma), 3 (tabela de escala do IDCT); fila de halfwords RLE
  (DC + run/valor, EOB 0xFE00, preenchimento), de-quantização `(n*qt*qscale+4)>>3` (DC: `n*qt[0]`; qscale 0: `n*2`),
  zigzag, IDCT inteira de 2 passadas (`(soma+0xFFFF)>>16`), saturação -128..127, YUV->RGB 4:2:0 e saídas 24/15 bits e mono 8/4 bits.
- DMA0 (RAM->MDEC) decodifica na hora; DMA1 (MDEC->RAM) fica **pendente** se o jogo o pedir antes dos dados
  (`mdec.pendingOut` + `dma.mdecOutReady()`), como no hardware.
- Validação no 100% Star: ~734 mil blocos decodificados durante a intro (~840 quadros), imagem correta (fumaça + logo EIDOS) e
  105 setores XA decodificados (pico de áudio 7734). A ordem da tabela de escala (linha = frequência) está confirmada pelo resultado.

## GTE (coprocessador 3D)
- `src/gte.js`: 32 registradores de dados + 32 de controle, com as peculiaridades do hardware (VZ/IR/H com sinal, OTZ/SZ sem sinal,
  SXYP empurra a FIFO, LZCS/LZCR, IRGB/ORGB, FLAG com bit 31 = OU dos bits 30-23 e 18-13).
- Aritmética: MAC1-3 em 44 bits (overflow detectado a cada soma, em `Number`, sem BigInt), MAC0 em 32 bits, divisão Newton-Raphson (UNR)
  igual à do hardware (saturada em 0x1FFFF, flag 17), FIFOs de SXY/SZ/cor com saturação e flags.
- Comandos: RTPS, RTPT, NCLIP, OP, DPCS, DPCT, INTPL, MVMVA (inclui o bug da translation FC e a matriz "lixo"), NCDS/NCDT, NCCS/NCCT,
  NCS/NCT, CDP, CC, DCPL, SQR, AVSZ3, AVSZ4, GPF, GPL.
- Mapeamento: a CPU passa 0..31 para CFC2/CTC2 e o GTE soma 32 (cop2r32..63). Testado executando instruções COP2 reais na CPU.
- Não emulado: ciclos de cada comando (a CPU não "trava" lendo um registrador ocupado).
- Validação no 100% Star (New Game -> Select Popstar): 1,2 milhão de comandos (0x01 RTPS 123k, 0x12 MVMVA 397k, 0x06 NCLIP 263k,
  0x2D AVSZ3 101k, 0x3D GPF 95k, 0x1B NCCS 123k, 0x28 SQR 63k, 0x30 RTPT 17k, 0x13 NCDS 17k) e personagem 3D renderizado.
