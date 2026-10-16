PS1 Emu (JS) - CPU + GPU + SPU + DMA + Timers + SIO0 + CD-ROM

COMO USAR
1) Navegador, sem servidor: duplo clique em index.html, escolha a BIOS (SCPH1001.BIN) e o disco (.bin) e
   clique em Iniciar. (usa dist/ps1emu.js, script classico: funciona em file://)
   Teclas: setas | Z=cruz X=bola A=quadrado S=triangulo | Q/W=L1/R1 E/R=L2/R2 | Enter=Start Backspace=Select
2) Depois de editar arquivos em src/ ou web/video-out.js / web/audio-out.js:   node build.js
3) Terminal: node run.js SCPH1001.BIN 100__Star.bin --steps 5000000
4) Testes:   npm test                         (74 testes, sem precisar de BIOS/jogo)
             BIOS=SCPH1001.BIN DISC=jogo.bin npm run test:boot    (boot real pela BIOS)

MEMORY CARDS
 Interface: escolha o arquivo em "Memory Card 1/2" (.mcr/.mcd/.bin 128KB, VGS ou DexDrive) ou deixe em branco para criar
 um cartao novo. Para guardar o progresso clique em "Baixar" (gera memcardN.mcr cru, compativel com ePSXe/DuckStation).
 Terminal: node run.js BIOS.BIN jogo.bin --mc0 samples/epsxe000.mcr   (grava de volta se o jogo alterar)
 samples/ tem os dois cartoes enviados (epsxe000: save de FF9; epsxe001: vazio) usados nos testes.

ESTRUTURA
 src/cpu.js       R3000A (delay slots, COP0, excecoes)      src/gpu.js   rasterizador por software
 src/bus.js       mapa de memoria / I/O                     src/spu.js   24 vozes ADPCM, ADSR, reverb, XA
 src/psx.js       relogio central, linhas, VBLANK, audio    src/dma.js   7 canais (OTC, GPU, SPU, CD)
 src/cdrom.js     controlador de CD + XA-ADPCM              src/timers.js  3 root counters
 src/sio.js       controle + memory card (SIO0)               src/scheduler.js eventos em ciclos
 src/disc.js      BIN/ISO9660/EXE                           src/gte.js   GTE completo (COP2)
 src/memcard.js   cartao 128KB, formatos, diretorio
 src/mdec.js      decodificador de video (IDCT, YUV->RGB 15/24 bits, DMA0/DMA1)

ESTADO ATUAL (testado com SCPH-1001 v2.2 + 100% Star SLES-03784)
 OK  Boot normal pela BIOS (sem sideload): kernel -> le o disco -> executa o EXE do jogo
 OK  CD-ROM, DMA, timers, controle (SIO0), XA-ADPCM, SPU, GPU por software
 OK  O jogo chega na TELA DE TITULO ("100% STAR - PRESS START") e roda estavel por milhares de quadros
 OK  Memory card: o jogo detecta os 2 cartoes, le/grava (frame de teste 63) e abre o menu New/Load Game
 OK  MDEC: a intro em video (INTRO.STR) decodifica e toca com audio XA (logo EIDOS INTERACTIVE visivel)
 OK  GTE: RTPS/RTPT, NCLIP, OP, MVMVA, DPCS/DPCT, INTPL, NCS/NCT, NCCS/NCCT, NCDS/NCDT, CDP, CC, DCPL, SQR, AVSZ3/4, GPF, GPL
     (MAC 44 bits, flags, divisao UNR). O jogo executa ~1,2 milhao de comandos e mostra um personagem 3D no menu.
 OK  Jogavel ate os menus: Title -> New Game -> Select Territory -> My Popgroup -> Select Popstar (modelo 3D)
 --  Falta: velocidade (recompilador), CD-DA, ajuste fino de tempos do CD-ROM, GTE sem ciclos reais, renderizador WebGL
 Veja ANALISE.md (diagnostico) e ANALISE-REFERENCIA.md (comparacao com o projeto MIT de referencia).

----------------------------------------------------------------------
RECOMPILADOR DINÂMICO (src/jit.js)
----------------------------------------------------------------------
- Traduz blocos MIPS em funções JS (new Function). Ligado por padrão (psx.useJit = true).
- Preserva delay slots, load delay, exceções precisas, contagem de ciclos e invalidação
  quando CPU/DMA escrevem em RAM com código compilado.
- Com onTrace ligado (ou psx.useJit = false) usa o interpretador de instrução única.
- CLI: node run.js BIOS.BIN disco.bin --steps N [--nojit] [--io]
- Teste: test/jit.test.js compara 60 programas aleatórios (interpretador x JIT):
  registradores, HI/LO, PC, COP0, ciclos e RAM têm de ser idênticos.
- Medido: ~17 MIPS (interpretador) -> ~34 MIPS (JIT) no Node com BIOS + 100% Star.

----------------------------------------------------------------------
CD-DA / MULTI-TRILHA
----------------------------------------------------------------------
- Discos: .bin cru 2352, .iso 2048 ou .cue (+ .bin das trilhas). Um arquivo por trilha ou
  todas num só; MODE1/2048, MODE1/2352, MODE2/2352, AUDIO; INDEX 00/01 e PREGAP.
- No navegador: selecione o .cue E todos os .bin juntos no campo "Disco".
- GetTN/GetTD com a TOC real; Play (trilha ou Setloc), Pause, Stop, Seek, GetlocP com
  track/index/tempo relativo e absoluto; relatório de CD-DA (Setmode bit 2) com pico;
  AutoPause (bit 1) e fim de disco -> INT4; Mute/Demute.
- Troca de disco: botão "Abrir tampa"; escolher outro disco fecha a tampa (o 1º Getstat
  depois mostra o bit 4 uma única vez, como o hardware).
- Não suportado: .chd (precisa de zlib/lzma/FLAC), subcanais .sbi/LibCrypt, XA 8 bits.
- Teste: node test/cdda.test.js (disco sintético com 1 trilha de dados + 2 de áudio).

----------------------------------------------------------------------
RENDERIZADOR WEBGL2 (src/glgpu.js) - resolução interna 1x a 8x
----------------------------------------------------------------------
- No navegador: campo "Renderizador" (Software, WebGL 1x/2x/3x/4x/6x/8x). Dá para trocar com o
  jogo rodando. Se WebGL2 não existir, cai sozinho para o software. "suavizar" = filtro linear quando
  a imagem de saída é menor que a VRAM interna.
- Com o WebGL ligado o rasterizador por software NÃO roda: a VRAM em alta resolução (textura RGBA8 +
  stencil) é a fonte da verdade; a VRAM nativa de 1024x512 é só um cache (usado p/ buscar texels
  4/8/15 bits e CLUTs nos shaders) que é atualizado por uploads da CPU ou, sob demanda, por leitura
  da GPU (tiles de 16x16 "sujos").
- Suportado: polígonos/retângulos/linhas (flat, gouraud, texturizados 4/8/15 bits, modulação/raw,
  dither), semitransparência (4 modos; texels semi/opacos em 2 passes), máscara set/check (stencil),
  janela de textura, flip de sprites, área/offset de desenho, fill, cópia VRAM->VRAM na GPU,
  upload/leitura de VRAM, display 15 e 24 bits.
- Memória: 8x usa ~400 MB de VRAM de vídeo (textura + stencil + cópia); 2x/4x são os usos comuns.
- Verificação (Chromium headless): jogo inteiro até o menu, quadros idênticos ao software em 1x
  (diferença máx. 1 passo de cor); 2x/4x idênticos ao software ampliado exceto nas bordas.
  tools/gl-gpu-compare.mjs compara 18 classes de comandos GP0 sintéticos (software x WebGL):
  flat/gouraud/dither/semi-transparência/retângulos/flip/linhas/fill/cópias = 0 pixels diferentes;
  texturizados e janela de textura/máscara: poucas dezenas de pixels de borda por ~40 primitivos
  (arredondamento do UV; o software também é frágil nesses pontos).
- Limites: cópia VRAM->VRAM com wrap e leituras de VRAM passam por software (mais lentas);
  UV é afim como no hardware (sem correção de perspectiva); não há texturas em alta resolução.

----------------------------------------------------------------------
PRECISÃO: SPU e TIMERS (etapa 4)
----------------------------------------------------------------------
SPU (src/spu.js, src/gauss.js)
- Interpolação Gaussiana de 4 taps com a tabela de 512 entradas do hardware (antes: linear).
  A tabela foi extraída de uma fonte pública de referência e é validada no teste: a soma dos 4 taps
  fica em 32639..32641 nas 256 fases (qualquer número errado quebraria isso).
- Volumes de voz (L/R) e principal (L/R): modo fixo e SWEEP completo (linear/exponencial, crescente/
  decrescente, fase +/-); o volume atual é legível em 0x1F801E00..0x1F801E62.
- Ruído: LFSR de 16 bits (taps 15,12,11,10) com timer (4+step por amostra, recarga 0x20000>>shift).
- Reverb: FIR de 39 taps na entrada (44,1 -> 22,05 kHz) e na saída (zero-stuffing, ganho 2); buffer só é
  escrito com SPUCNT.7; CD audio entra no reverb com SPUCNT.2; acessos do reverb disparam o IRQ da SPU.
- IRQ da SPU: dispara uma vez (até limpar) em escrita da CPU/DMA no endereço ou quando uma voz lê um
  bloco ADPCM que contém o endereço.
TIMERS (src/timers.js, src/psx.js)
- Modos de sincronização reais do timer 0 (hblank) e timer 1 (vblank): pausa no blank, reset na entrada,
  conta só dentro do blank, espera o 1º blank e depois livre; timer 2 (parado/livre). O blank é
  derivado da faixa horizontal ativa do GPU (GP1(06)) e das linhas de vblank, atualizado a cada tick de 32 ciclos.
Não feito nesta etapa (precisa de dados de referência do hardware para validar):
- Rasterização da GPU bit-exata (interpolação inteira), timing real dos comandos da GPU.
- ADSR/ruído/reverb foram conferidos contra a documentação por propriedades (testes), não contra
  gravações de um PS1 real.
Teste: node test/accuracy.test.js (22 testes).


=== CONTROLES, SAVE STATES E DEPURADOR (etapa 5) ===
Controles (painel "Controles" no index.html)
 - Teclado e gamepad (Gamepad API, layout "standard") somam-se (OU). 1º gamepad = porta 1, 2º = porta 2.
 - Tipo por porta: Digital ou DualShock. DualShock começa digital; o jogo liga o modo analógico (ID 0x73, 4 eixos).
   Botão HOME do gamepad ou F9 alterna o modo analógico (se o jogo não o travou). No controle digital o analógico esquerdo vira direcional.
 - Vibração: o mapeamento 0x4D/poll 0x42 do jogo aciona vibrationActuator do gamepad (dual-rumble).
 - Remapear: clique no botão da tabela e aperte a tecla / botão do gamepad. Salvo no localStorage. Zona morta e vibração ajustáveis.
 - Atalhos (remapeáveis): P pausa, F5 salvar estado, F7 carregar estado, F9 analógico, F11 tela cheia, T turbo (4x, sem áudio).
Persistência (IndexedDB; sem ele o app segue funcionando e os botões "Baixar" continuam)
 - Memory cards são gravados sozinhos a cada alteração e restaurados ao iniciar (arquivo escolhido tem prioridade).
 - 5 slots de save state por jogo (gzip) + exportar/importar arquivo .ps1state. O estado inclui CPU/GTE, RAM, VRAM, SPU, DMA,
   timers, SIO, CD-ROM, MDEC e a fila de eventos. Não inclui disco, BIOS, botões e memory cards. Restaurar exige o mesmo disco/BIOS.
 - Para isso o agendador usa eventos descritores serializáveis: sched.call(tempo, 'cdrom'|'dma'|'sio', método, args).
Depurador (painel "Depurador", src/debug.js): registradores, desmontagem em torno do PC, passo, breakpoints, trace dos últimos
 512 PCs, dump de memória (só RAM/BIOS/scratchpad, sem tocar em I/O). Breakpoints/trace usam o interpretador (JIT fica de fora).
 Se o emulador lançar uma exceção, o loop para, o painel mostra um relatório e há botão "Baixar relatório".
Testes novos: test/state.test.js, pad.test.js, input.test.js (npm test).


=== SUÍTE DE HARDWARE (etapa 6) ===
Veja tools/hwtests/README.txt: compila e roda o ps1-tests (programas feitos para o console real) sobre a BIOS e compara com os logs.
Correções feitas por causa dele:
 - GPUSTAT/E1: textura modo 3 preservada, bit 11 (texture disable) só com GP1(09), texpage de comandos atualiza bits 0-8/11.
 - GPU "ocupada": cada comando de desenho (fill, retângulo, polígono, linha, cópia VRAM) mantém os bits 26/28 em 0 por um tempo
   calibrado com a vazão do PS1 real (src/gpu.js chargeBusy; só a parte visível do polígono conta).
 - DMA: modo 0 inicia sozinho em GPU/CD/SPU/MDEC (só OTC/PIO exigem o trigger); duração por canal (CD 24, SPU 12, GPU 1 ciclo/palavra),
   +10 ciclos por bloco (sync 1) e chopping; antes o modo 0 do GPU nunca terminava.
Teste de regressão: test/hwtests.test.js (npm test).
 - Acessos à memória: custo por região e largura (src/cpu.js memCost) medido com cpu/access-time: RAM 5 ciclos/lw (antes 6), ROM 7/13/25,
   scratchpad 1, I/O ~3, CD 7/14/26, SPU 18/18/39, expansões. Interpretador e JIT usam a mesma tabela.

=== Silêncio na tela de título do 100% Star (investigado) ===
Depois do quadro ~2145 o jogo não envia mais comandos ao CD, não tem voz do SPU ativa e silencia o CD (Mute): é a tela de título
parada esperando uma tecla. Apertando Start/X o jogo reage (a tela muda, novos comandos de CD, áudio com pico ~11000), então o
silêncio é comportamento do jogo, não falha do emulador. A música da intro (XA, codificação 5) toca normalmente.


GPU bit-exata (rasterizador por software)
-----------------------------------------
O rasterizador por software foi calibrado contra capturas de VRAM do console real (ps1-tests/gpu/*/vram.png) e hoje bate
pixel a pixel em: quad, texture-overflow, transparency (4 modos), triangle (Gouraud, com e sem dithering), uv-interpolation,
texture-flip, clut-cache, lines e vram-to-vram-overlap. A verificação roda em  node test/gpu-exact.test.js  (precisa da BIOS;
os programas de teste compilados e as referências ficam em test/fixtures/gpu/).
O que ficou exato:
  - Triângulos: cobertura por arestas exatas (linhas [topo, base), colunas [ceil(xE), ceil(xD)) ); cor/u/v em ponto fixo, gradiente
    truncado a 12 bits, partindo do 1o vértice do comando, aritmética de 32 bits que "dá a volta"; limite 1023x511 do hardware.
  - Linhas: passo 32.32 arredondado para longe do zero, pixel = floor(pos+0,5-2^-22) em x; cor com 12 bits; dithering também em linhas flat.
  - Sprites com flip X começam em u0+1; VRAM->VRAM copia em rajadas de 16 pixels (sobreposição como no console).
  - Cache de CLUT da GPU (4 bits = 16 entradas, 8 bits = 256; invalidado por GP0(01) ou por mudança de posição da CLUT).
Fora do escopo/limites: o renderizador WebGL (1x) agora acompanha o rasterizador exato: retângulos, flips, linhas, fill, cópias, gouraud e máscara com 0 pixels de diferença; polígonos texturizados ficam com poucas dezenas de pixels (empates de borda) em ~85 mil. Em 2x+ a imagem é naturalmente mais detalhada;
para fidelidade total use o modo por software. Testes clipping/rectangles do ps1-tests usam rand() do libc original (não comparáveis).
Estados salvos de versões anteriores não têm o cache de CLUT (é recarregado no próximo desenho).

Executáveis soltos (.psx / PS-X EXE)
------------------------------------
node tools/demos/run-all.mjs pasta [quadros] [pasta_de_saida]   roda cada .psx sobre a BIOS real e resume: travamento (exceção não tratada),
áudio, tela desenhada e se JIT e interpretador dão a mesma VRAM. Testado com 18 programas (intros/trainers Paradox, Static, Deub, demos):
16 rodam com gráficos e áudio; chrome (precisa de um modelo TMD externo em 0x80130000) e flaptron (executa um BREAK) caem na BIOS;
bubble-bobble é o EXE de um jogo e precisa do disco (fica em CD_init). Dois programas dependem de dados que não estão no .psx.

GTE e MDEC contra o console real (repositório JaCzekanski/ps1-tests)
--------------------------------------------------------------------
- GTE: 1150 vetores de teste gravados num console real (test/fixtures/gte_valid_0xc0ffee_50.log.gz) rodam em
  tools/hwtests/gtefuzz.mjs; os 64 registradores (flags incluídas) saem idênticos nos 1150 casos. Correções: MAC0 sem
  truncar a 32 bits antes de SX/SY, IR0 e OTZ; flags do bug de FC no MVMVA.
- MDEC: imagem real de 320x240 (test/fixtures/mdec) decodificada em 15 e 24 bits. Ajustes medidos no hardware:
  IDCT com mais precisão na 1ª passada, conversão YCbCr->RGB com arredondamento (+128) e saída de 15 bits arredondada
  ((v+4)>>3). Resultado: ~79% dos pixels (15 bits) e ~70% dos bytes (24 bits) idênticos; o resíduo é ±1 e ainda
  não foi explicado (test/mdec-frame.test.js trava o nível atual).

Interface (tela cheia + menu na engrenagem + controle virtual)
---------------------------------------------------------------
- O jogo ocupa a janela inteira (4:3, centralizado; em celular na vertical a imagem fica no topo). Só há uma engrenagem no canto
  superior direito: toque nela (ou Esc) para abrir o menu lateral com BIOS, disco, memory cards, renderizador, save states,
  controles e depurador. O menu fecha sozinho ao iniciar o jogo.
- Menu > "Tela e controle virtual": "Teclado virtual (toque)" liga/desliga o controle na tela (já vem ligado em aparelhos de toque),
  "Mostrar analógicos" adiciona os dois sticks e troca a porta 1 para DualShock, e a opacidade é ajustável. Tudo é guardado no navegador.
- O controle virtual tem direcional (8 direções, desliza o dedo), △○✕□, L1/L2/R1/R2, Select/Start e ANALOG; aceita vários toques ao mesmo
  tempo e vibra levemente (quando o aparelho suporta). Código: web/ui.js (+ InputManager.setVirtual/setVirtualStick em src/input.js).

ÁUDIO DE VÍDEOS (FMV) E RITMO
 - O som dos vídeos (XA-ADPCM do CD) já era decodificado corretamente (verificado no 100% Star: 153 setores XA no vídeo de abertura).
   O que o deixava mudo/picotado era o desempenho: o vídeo (MDEC + leitura 2x do CD) é o trecho mais pesado e, em aparelhos
   mais lentos, o emulador não acompanha o tempo real, e a fila de áudio esvaziava (silêncio entre blocos).
 - web/audio-out.js agora ajusta a taxa de reprodução dinamicamente (reamostragem linear): se o emulador está lento o áudio toca
   mais devagar porém CONTÍNUO, junto com o vídeo; se está rápido, acelera de leve. Teste: node test/audio-out.test.js.
 - web/main.js agora limita a 50 Hz (PAL) / 59,94 Hz (NTSC) independente da taxa do monitor (antes rodava a cada quadro do
   navegador: jogo PAL a 60 Hz ficava 20% rápido e em monitores de 120/144 Hz ainda mais).
 - Ainda não suportado: XA de 8 bits (nenhum disco testado usa).

RENDERIZADOR ADAPTATIVO (novo, padrão)
 - Opção "Adaptativo (automático)" no seletor de renderizador. Ao iniciar, detecta o aparelho (celular x computador, núcleos, memória,
   WebGL2, tamanho máximo de textura, nome da GPU) e escolhe: software se não houver WebGL2 ou se o WebGL for emulado na CPU
   (SwiftShader/llvmpipe); senão WebGL 1x–4x (celular fraco 1x, celular bom 2x, computador 2x–4x).
 - Em execução mede a cada ~1 s quantos quadros foram emulados contra o ritmo pedido (50/59,94 Hz). Se ficar abaixo de 90% por 2 s,
   reduz um degrau de resolução; se sobrar folga (<40% do tempo do quadro) por 8 s, tenta subir, com espera crescente
   (45 s, 90 s, 180 s...) nos degraus que já falharam, para não ficar oscilando. O log mostra cada decisão.
 - Limite: se o gargalo é a CPU (ex.: vídeos FMV em celular fraco), baixar a resolução não resolve; o áudio contínuo (audio-out)
   cobre esse caso. Escolher manualmente qualquer outro item do seletor desliga o modo adaptativo.

DESEMPENHO DO NÚCLEO (fase 1)
 - JIT: desvios condicionais agora viram "saída lateral" dentro do mesmo bloco (superblocos): o fluxo sequencial continua sem voltar ao
   despachante. ~30% menos despachos por quadro; instruções executadas idênticas (a diferença de ciclos no benchmark é de 7 em 843 milhões,
   só a latência de IRQ entre blocos). Os testes de hardware dão os mesmos resultados de antes.
 - MDEC: a IDCT ignora coeficientes nulos (resultado bit a bit idêntico; teste mdec-frame continua 79,0% / 70,4%) e não aloca mais closure por bloco.
 - Medição: no trecho do vídeo do 100% Star o custo caiu de ~19 ms para ~15–16 ms por quadro (máquina ruidosa; faixa de 3 execuções).
 - Perfil atual (vídeo): despachante+tick ~33%, MDEC ~14%, rasterizador por software ~16% (só no modo software), JIT ~12%, SPU ~5%.
 - Próximos passos possíveis: tick adaptativo (hoje a cada 32 ciclos), emulação em Web Worker + OffscreenCanvas, renderizador WebGPU.

DESEMPENHO DO NÚCLEO (fase 2: tick adaptativo)
 - Antes o relógio dos periféricos (timers, SPU, vídeo, eventos) rodava a cada 32 ciclos. Agora o próximo tick é no máximo 128 ciclos à frente,
   mas antecipado para o instante exato do próximo evento agendado (CD, DMA, SIO) ou do fim da linha de vídeo. Eventos novos antecipam o tick na hora.
 - Leituras/escritas nos registradores dos timers sincronizam os contadores na hora (ficaram até mais exatos que antes).
 - Resultado: trecho do vídeo do 100% Star de ~15,5 ms para ~8 ms por quadro (cerca de 2x). npm test e a suíte de hardware dão os mesmos resultados;
   o áudio do vídeo (XA) saiu praticamente idêntico. Teste novo: node test/tick.test.js. Save states antigos continuam carregando.

MODO WORKER (thread separada) — fase 3
 - Caixa "Thread separada" (ligada por padrão) ao lado de JIT. Vale ao clicar em Iniciar. O emulador (CPU/JIT/GPU/SPU/CD) roda num Web Worker e
   desenha direto num OffscreenCanvas (WebGL2 ou software); a página só cuida de menu, entrada, áudio e IndexedDB, então a interface não trava
   mais quando o jogo pesa e o emu
