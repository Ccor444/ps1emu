// Persistência no navegador (IndexedDB). Script clássico: define o global Store.
// Tudo é opcional: se o IndexedDB estiver bloqueado (modo privado, política do navegador), Store.ok fica false e o app segue sem autosave.
const Store = (() => {
  let dbp = null;
  const STORES = ['cards', 'states'];
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    try {
      const rq = indexedDB.open('ps1emu', 1);
      rq.onupgradeneeded = () => { for (const s of STORES) if (!rq.result.objectStoreNames.contains(s)) rq.result.createObjectStore(s); };
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error || new Error('IndexedDB falhou')); rq.onblocked = () => rej(new Error('IndexedDB bloqueado'));
    } catch (e) { rej(e); }
  }));
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode), r = fn(t.objectStore(store));
      t.oncomplete = () => res(r && 'result' in r ? r.result : undefined); t.onerror = t.onabort = () => rej(t.error || new Error('transação falhou'));
    });
  };
  const api = {
    ok: typeof indexedDB !== 'undefined',
    async check() { try { await open(); api.ok = true; } catch { api.ok = false; } return api.ok; },
    get: (s, k) => tx(s, 'readonly', o => o.get(k)),
    put: (s, k, v) => tx(s, 'readwrite', o => o.put(v, k)),
    del: (s, k) => tx(s, 'readwrite', o => o.delete(k)),
    keys: (s) => tx(s, 'readonly', o => o.getAllKeys()),
  };
  return api;
})();
