// Funções do libpsn00b antigo / suporte C++ mínimo que o ps1-tests espera
#include <stdlib.h>
#include <stdint.h>
extern "C" uint32_t ReadGPUstat(void) { return *(volatile uint32_t*)0x1F801814; }
void* operator new(unsigned int n) { return malloc(n); }
void* operator new[](unsigned int n) { return malloc(n); }
void operator delete(void* p) { free(p); }
void operator delete[](void* p) { free(p); }
void operator delete(void* p, unsigned int) { free(p); }
void operator delete[](void* p, unsigned int) { free(p); }
extern "C" void InitGeom(void) {}   // GTE não é usado pelos testes de GPU
