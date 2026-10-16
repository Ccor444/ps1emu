#!/bin/bash
# Compila as bibliotecas do PSn00bSDK (libc, psxapi, psxgpu, psxetc, psxspu, psxgte, psxsio) com clang -> mipsel R3000
# Uso: PSN00B=/caminho/psn00bsdk OUT=/caminho/saida ./build_libs.sh
set -u
PSN00B=${PSN00B:-/home/claude/lameguy64/psn00bsdk}; OUT=${OUT:-/tmp/hwlibs}; L=$PSN00B/libpsn00b
mkdir -p "$OUT/obj"
CF="--target=mipsel-none-elf -mcpu=mips1 -mabi=32 -msoft-float -mno-abicalls -mno-check-zero-division -fno-pic -G0 -ffreestanding -fno-builtin -fsigned-char -fdata-sections -ffunction-sections -O2 -fno-strict-overflow -I$L/include -DSDK_LIBRARY_NAME=\"psn\" -w"
fail=0
for d in libc psxapi psxgpu psxetc psxspu psxgte psxsio psxcd; do
  for f in $(find $L/$d -name '*.c' -o -name '*.cpp' -o -name '*.s' | sort); do
    o=$OUT/obj/$d-$(basename $f).o
    case $f in *.c) x="-x c";; *.cpp) x="-x c++ -fno-exceptions -fno-rtti";; *) x="-x assembler-with-cpp";; esac
    if ! clang $CF $x -c $f -o $o 2> $o.err; then echo "FALHA $f"; head -3 $o.err; fail=$((fail+1)); rm -f $o; fi
  done
done
# fonte de depuração embutida (incbin)
cat > $OUT/font.s <<EOT
.section .data
.global _gpu_debug_font
_gpu_debug_font:
.incbin "$L/psxgpu/dbugfont.tim"
.global _gpu_debug_font_end
_gpu_debug_font_end:
EOT
clang $CF -x assembler -c $OUT/font.s -o $OUT/obj/font.o
llvm-ar rcs $OUT/libpsn00b.a $OUT/obj/*.o && echo "libpsn00b.a: $(ls $OUT/obj/*.o | wc -l) objetos, $fail falhas"
