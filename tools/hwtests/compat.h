// Compatibilidade entre o psxgpu.h antigo (usado pelo ps1-tests) e o libpsn00b atual
#pragma once
#include <psxgpu.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct { uint32_t tag; uint32_t code[1]; } DR_MASK;
#define setDrawMask(p, sb, mc) setlen(p, 1), (p)->code[0] = (0xe6000000 | (sb) | ((mc) << 1))
typedef struct { uint32_t tag; uint8_t p0, p1, p2, code; uint16_t x0, y0, x1, y1, w, h; } VRAM2VRAM;
#ifdef __cplusplus
}
#endif
