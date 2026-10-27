# Estudo do projeto de referência (JavascriptPS1, licença MIT)

Objetivo: usar como **base de comparação** (não copiar código). Nada deste projeto foi colado aqui; o que vale
foi reimplementado com código próprio. Fonte: ~8.100 linhas, módulos globais (`window.psx`, `cdr`, `dma`, `spu`...).

## Arquitetura deles
| Módulo | Linhas | Como fazem | Vale adotar? |
|---|---|---|---|
| `recompiler.js` | 1014 | **Recompilador dinâmico**: traduz blocos MIPS em funções JS (`new Function`), cache por PC, constant folding, blocos ligados por salto; invalida cache quando DMA/CPU escreve na RAM (`clearCodeCache`). | **Sim - maior ganho de velocidade** (hoje interpretamos a ~35 MIPS) |
| `core.js` | 107 | Relógio `psx.clock` + lista de eventos (`setEvent/updateEvent/unsetEvent`), tratados por `handleEvents` entre blocos. | Já temos equivalente (`scheduler.js`) |
| `cdrom.js` | 789 | Máquina de estados por evento; dados lidos direto da imagem; XA decodificado no ato; TOC própria. | Parcial (tempos, ver abaixo) |
| `macroBlockDecoder.js` | 363 | **MDEC**: tabela de quantização, `rl2blk` (run-length → bloco), IDCT (`icdt`), YUV→RGB 15/24 bits; DMA0 (`0201`, entrada) e DMA1 (`0200`, saída). | **Sim - é o que falta p/ a intro** |
| `geometryTransformEngine.js` | 702 | **GTE** com `Float64`, saturação por `lim()` e flags no reg 0x3F, comandos como funções. | Sim, mas com inteiros p/ ser bit-exato |
| `graphicsProcessingUnit.js` + `webGlHQ.js` | 738+1319 | GPU envia primitivas a um renderizador **WebGL** com resolução interna 1x/2x/4x/8x. | Sim (futuro): sai do software rasterizer |
| `rootCounters.js` | 499 | Contadores em `Float64`, eventos de alvo/overflow. | Equivalente ao nosso `timers.js` |
| `directMemoryAccess.js` | 257 | Um evento de conclusão por canal; duração ∝ palavras (`words*0x110/0x100`). | Ideia dos tempos: sim |
| `enge.js` | 226 | Kernel/BIOS substituto (HLE), por isso não dependem de região/BIOS Sony. | Não necessário |

## O que aprendi comparando com o nosso CD-ROM
1. **Tempos reais** (ciclos): Nop `0xC4E1`; maioria dos comandos `0x200`; GetID `0x4A00`; Seek `0x1000`; Init `0x13CCE`;
   Pause `0x21181C` (1x) / `0x10BD93` (2x); Stop `0xD38ACA` / `0x18A6076`; setor a cada `33,8688M/75` (ou `/150`).
   Nossos tempos são mais curtos que os reais em Pause/Stop - candidato a ajuste fino.
2. **INT3 de ReadN/ReadS/Seek devolve stat `0x42`** (motor + seek); o INT1 devolve `0x22`.
3. **Setores XA geram INT1** no projeto deles; nós não entregávamos. Ainda não sabemos qual é o correto no hardware
   para o nosso jogo - revisar quando o MDEC/STR rodar.
4. Resposta pendente é **re-agendada a cada 64 ciclos** enquanto houver INT não reconhecida (igual ao que passamos a fazer).
5. Dados vêm do offset 24 (setor 2048) ou 12 (modo 0x924), como o nosso.

## O bug do 100% Star que a comparação ajudou a resolver
Sintoma: o jogo destruía o vetor de exceção (`0x80`) ao iniciar a intro.
Causa: flag de DMA "presa" no `DICR` (bits 24-30) da fase da BIOS. Ao habilitar o canal 3, o jogo recebia um
"DMA3 terminou" falso; a libcd marcava um quadro de vídeo como pronto, o decodificador VLC rodava em buffer vazio e
escrevia além dos 2 MB de RAM.
Duas correções (ver `src/dma.js`):
- Escritas parciais no `DICR` (byte/halfword) não podem remendar as flags no valor (elas são "escreva 1 para limpar").
- Cada conclusão de canal habilitado **reafirma a IRQ3** (o projeto de referência faz isso por conclusão), em vez de
  só na subida do bit 31; assim uma flag antiga não silencia todas as interrupções de DMA seguintes.
Resultado: o jogo chega à **tela de título** ("100% STAR - PRESS START").

## Próximos passos sugeridos (por impacto) - MDEC e memory card já feitos
1. **MDEC** (intro/FMVs) - ligar DMA0/DMA1 e o status `0x1F801824`.
2. **GTE** com comandos inteiros (RTPS, RTPT, NCLIP, MVMVA, NCDS...) - o logo da BIOS e jogos 3D dependem.
3. **Recompilador dinâmico** - ganhar 5-10x de velocidade (hoje < tempo real em cenas pesadas).
4. Memory card, ajustes finos de tempo do CD-ROM, renderizador WebGL.
