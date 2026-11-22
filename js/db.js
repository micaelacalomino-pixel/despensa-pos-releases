'use strict';
// Persistencia local en IndexedDB (ver docs/architecture.md §3–§4)
const DB = (() => {
  let db;
  const p = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const fin = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });

  async function abrir() {
    const req = indexedDB.open('despensa-pos', 2);
    req.onupgradeneeded = (e) => {
      const d = req.result;
      if (e.oldVersion < 1) {
        d.createObjectStore('productos', { keyPath: 'codigo' });
        d.createObjectStore('ventas', { keyPath: 'id', autoIncrement: true }).createIndex('fecha', 'fecha');
      }
      // v2: cambio inicial de la caja por día (Historia 2.3)
      if (e.oldVersion < 2) d.createObjectStore('aperturas', { keyPath: 'dia' });
    };
    db = await p(req);
  }

  const todos = (store) => p(db.transaction(store).objectStore(store).getAll());

  function guardarProductos(lista = [], borrar = []) {
    const t = db.transaction('productos', 'readwrite');
    const s = t.objectStore('productos');
    borrar.forEach((c) => s.delete(c));
    lista.forEach((x) => s.put(x));
    return fin(t);
  }

  async function guardarVenta(venta) {
    const t = db.transaction('ventas', 'readwrite');
    const req = t.objectStore('ventas').put(venta);
    await fin(t);
    return req.result;
  }

  const ventasEntre = (desde, hasta) =>
    p(db.transaction('ventas').objectStore('ventas').index('fecha').getAll(IDBKeyRange.bound(desde, hasta, false, true)));

  const getApertura = (dia) => p(db.transaction('aperturas').objectStore('aperturas').get(dia));

  function guardarApertura(apertura) {
    const t = db.transaction('aperturas', 'readwrite');
    t.objectStore('aperturas').put(apertura);
    return fin(t);
  }

  function reemplazarTodo(productos, ventas, aperturas = []) {
    const t = db.transaction(['productos', 'ventas', 'aperturas'], 'readwrite');
    const sp = t.objectStore('productos'), sv = t.objectStore('ventas'), sa = t.objectStore('aperturas');
    sp.clear(); sv.clear(); sa.clear();
    productos.forEach((x) => sp.put(x));
    ventas.forEach((x) => sv.put(x));
    aperturas.forEach((x) => sa.put(x));
    return fin(t);
  }

  function borrarTodosLosProductos() {
    const t = db.transaction('productos', 'readwrite');
    t.objectStore('productos').clear();
    return fin(t);
  }

  return { abrir, todos, guardarProductos, guardarVenta, ventasEntre, getApertura, guardarApertura, reemplazarTodo, borrarTodosLosProductos };
})();
