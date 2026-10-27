#!/usr/bin/env python3
"""Compila um teste do ps1-tests (https://github.com/JaCzekanski/ps1-tests) para um PS-X EXE usando clang + libpsn00b.a
Uso: python3 build_test.py <dir_do_teste> <saida.exe>   (env: PS1TESTS, PSN00B, HWLIBS)"""
import os, subprocess, sys, glob, struct, tempfile
T = os.environ.get('PS1TESTS', '/home/claude/jaczekanski/ps1-tests')
S = os.environ.get('PSN00B', '/home/claude/lameguy64/psn00bsdk')
LIBS = os.environ.get('HWLIBS', '/tmp/hwlibs')
test, out = sys.argv[1], sys.argv[2]
testdir = os.path.join(T, test)
RES = subprocess.run(['clang', '-print-resource-dir'], capture_output=True, text=True).stdout.strip() + '/include'
HERE = os.path.dirname(os.path.abspath(__file__))
inc = ['-nostdinc', f'-isystem{RES}', f'-I{HERE}/include', f'-I{S}/libpsn00b/include', f'-I{T}/common', f'-I{testdir}']
cf = ['--target=mipsel-none-elf', '-mcpu=mips1', '-mabi=32', '-msoft-float', '-mno-abicalls', '-mno-check-zero-division', '-fno-pic', '-G0', '-fno-builtin',
      '-fsigned-char', '-fdata-sections', '-ffunction-sections', '-O2', '-fno-strict-overflow', '-w', '-D__PLAYSTATION__'] + os.environ.get('EXTRA_DEFS','').split() + ['-include', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'compat.h')] + inc
cxx = ['-x', 'c++', '-std=gnu++17', '-fno-exceptions', '-fno-rtti', '-fno-threadsafe-statics', '-fno-use-cxa-atexit']
tmp = tempfile.mkdtemp(prefix='hwt-')
objs = []
srcs = sorted(glob.glob(f'{testdir}/*.c') + glob.glob(f'{testdir}/*.cpp') + glob.glob(f'{testdir}/*.s') + glob.glob(f'{T}/common/*.c') + glob.glob(f'{T}/common/*.cpp') + glob.glob(f'{T}/common/*.s') + [os.path.join(HERE, 'shim.cpp')])
for i, f in enumerate(srcs):
    o = f'{tmp}/{i}.o'; ext = f.rsplit('.', 1)[1]
    x = ['-ffreestanding', '-x', 'c'] if ext == 'c' else cxx if ext == 'cpp' else ['-x', 'assembler-with-cpp']
    r = subprocess.run(['clang'] + cf + x + ['-c', f, '-o', o], capture_output=True, text=True)
    if r.returncode: print('ERRO compilando', f, '\n', r.stderr[:1500]); sys.exit(1)
    objs.append(o)
elf = f'{tmp}/t.elf'
r = subprocess.run(['ld.lld', '-T', f'{S}/libpsn00b/ldscripts/exe.ld', '--gc-sections', '-o', elf] + objs + [f'{LIBS}/libpsn00b.a', f'{LIBS}/libpsn00b.a'], capture_output=True, text=True)
if r.returncode: print('ERRO ligando\n', r.stderr[:2500]); sys.exit(1)
subprocess.check_call(['llvm-objcopy', '-O', 'binary', elf, f'{tmp}/t.bin'])
syms = subprocess.run(['llvm-nm', elf], capture_output=True, text=True).stdout
sym = lambda n: int([l.split()[0] for l in syms.splitlines() if l.split()[-1] == n][0], 16)
pc = int(subprocess.run(['llvm-readelf', '-h', elf], capture_output=True, text=True).stdout.split('Entry point address:')[1].split()[0], 16)
data = open(f'{tmp}/t.bin', 'rb').read(); data += b'\0' * (-len(data) % 2048)
hdr = bytearray(0x800); hdr[0:8] = b'PS-X EXE'
struct.pack_into('<IIIIII', hdr, 0x10, pc, sym('_gp'), 0x80010000, len(data), 0, 0)
struct.pack_into('<II', hdr, 0x30, 0x801FFFF0, 0)
hdr[0x4C:0x4C + 55] = b'Sony Computer Entertainment Inc. for North America area'
open(out, 'wb').write(hdr + data)
print(f'{test}: {len(data)} bytes, pc={pc:08x}')
