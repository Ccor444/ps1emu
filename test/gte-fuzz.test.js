// GTE contra 1150 vetores do console real (ps1-tests/gte-fuzz): os 64 registradores devem sair idênticos
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const out = execFileSync('node', [new URL('../tools/hwtests/gtefuzz.mjs', import.meta.url).pathname, new URL('./fixtures/gte_valid_0xc0ffee_50.log.gz', import.meta.url).pathname], { encoding: 'utf8' });
const m = /TOTAL: (\d+)\/(\d+)/.exec(out); assert.ok(m, out);
assert.equal(m[1], m[2], out);
console.log(`  ok   GTE: ${m[1]}/${m[2]} vetores idênticos ao console real (22 comandos, flags incluídas)`);
