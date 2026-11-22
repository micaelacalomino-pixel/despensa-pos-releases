'use strict';
/* Despensa POS — lógica de la aplicación (ver docs/architecture.md) */

// ───────────── Utilidades
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const fmtARS = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' });
const fmt = (n) => fmtARS.format(n || 0);
const fmtKg = (n) => new Intl.NumberFormat('es-AR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(n);
const fmtCant = (n) => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 3 }).format(n);
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const r3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const pad = (n) => String(n).padStart(2, '0');
const hoyISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const hora = (t) => new Date(t).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

/** Convierte "1.500,50", "1500.5", "$ 1500" → número. */
function parseMonto(s) {
  s = String(s ?? '').trim().replace(/[$\s]/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  return Number(s);
}

/**
 * Interpreta el ingreso de peso (PRD §5): entero ≥ 10 = gramos; decimal = kg; "$" o modoImporte = importe.
 * Devuelve { cant (kg), subtotal } o null si es inválido.
 */
function parsePeso(texto, precioKg, modoImporte = false) {
  let s = String(texto ?? '').trim().replace(/\s/g, '');
  if (s.startsWith('$')) { modoImporte = true; s = s.slice(1); }
  if (!s || !(precioKg > 0)) return null;
  if (modoImporte) {
    const imp = parseMonto(s);
    if (!(imp > 0)) return null;
    return { cant: r3(imp / precioKg), subtotal: r2(imp) };
  }
  let kg;
  if (/^\d+$/.test(s)) { kg = parseInt(s, 10); if (kg >= 10) kg = kg / 1000; }
  else kg = Number(s.replace(',', '.'));
  if (!(kg > 0) || !isFinite(kg)) return null;
  kg = r3(kg);
  return { cant: kg, subtotal: r2(kg * precioKg) };
}

let audioCtx;
function beep(ok = true) {
  if (!config.sonido) return;
  try {
    audioCtx = audioCtx || new AudioContext();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = ok ? 'sine' : 'square';
    o.frequency.value = ok ? 1250 : 220;
    g.gain.value = 0.07;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + (ok ? 0.07 : 0.3));
  } catch { /* sin audio */ }
}

function toast(msg, tipo = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + tipo;
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3000);
}

function descargar(nombre, contenido, tipo) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const csvCelda = (v) => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const numCSV = (n) => String(n).replace('.', ',');

// Programa de escritorio (Electron): expone window.escritorio (ver electron/preload.js)
const ESCRITORIO = typeof window.escritorio === 'object' && window.escritorio !== null;

// ───────────── Estado
const productos = new Map(); // codigo → producto
// Ventas en paralelo (Historia 6.1): un carrito por vendedor; `carrito` apunta al de la pestaña activa
const INVITADO = 'Invitado';
let carritos = {};           // vendedor → items
let vendedorActivo = INVITADO;
let carrito = [];            // { id, codigo, nombre, precio, cant, tipo: 'u'|'kg'|'manual', subtotal? }
function setCarrito(items) { carrito = items; carritos[vendedorActivo] = items; }
const hayVentasAbiertas = () => Object.values(carritos).some((c) => c.length > 0);
let vista = 'venta';
let ultimoAgregado = null;
let seq = 0;

const CONFIG_DEF = {
  negocio: 'Mi Despensa', sonido: true, ultimoBackup: null,
  direccion: '', telefono: '', pie: '¡Gracias por su compra!', papel: '80', imprimir: 'nunca',
  pedirCambio: true, vendedores: [], buscarOnline: true, impresora: '', modoImpresion: 'texto', codepage: 'pc850', columnas: '', margen: '0',
  lectores: {}, lectoresComActivo: false, lectoresCom: {},
  balanza: true, balanzaPlu: '5', balanzaContenido: 'importe', balanzaCentavos: false,
  modoTablet: 'auto', // 'auto' (solo en pantallas táctiles fuera del programa de Windows/Mac) | 'si' | 'no'
};
let config = { ...CONFIG_DEF };
try { Object.assign(config, JSON.parse(localStorage.getItem('pos-config') || '{}')); } catch { /* config por defecto */ }
function guardarConfig() { try { localStorage.setItem('pos-config', JSON.stringify(config)); } catch { /* sin almacenamiento */ } }

const subtotalItem = (it) => it.subtotal ?? r2(it.precio * it.cant);
const totalCarrito = () => r2(carrito.reduce((a, it) => a + subtotalItem(it), 0));

// ───────────── Navegación
function mostrar(v) {
  vista = v;
  $$('.view').forEach((el) => el.classList.toggle('active', el.id === 'v-' + v));
  $$('.topbar nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'productos') renderProductos();
  if (v === 'caja') renderCaja();
  if (v === 'ajustes') renderAjustes();
  if (v === 'venta') focusScan();
}
const dialogoAbierto = () => !!document.querySelector('dialog[open]');
function focusScan() { if (vista === 'venta' && !dialogoAbierto()) $('#scan').focus(); }

// ───────────── Venta: entrada de escaneo
let sugeridos = [];
let selSug = -1;

function buscarProductos(txt, limite = 8) {
  const palabras = norm(txt).split(/\s+/).filter(Boolean);
  if (!palabras.length) return [];
  const res = [];
  for (const p of productos.values()) {
    const n = norm(p.nombre);
    if (palabras.every((w) => n.includes(w)) || p.codigo.startsWith(txt.trim())) res.push(p);
  }
  return res.sort((a, b) => a.nombre.localeCompare(b.nombre)).slice(0, limite);
}

function mostrarSugerencias(lista) {
  sugeridos = lista;
  selSug = lista.length ? 0 : -1;
  const ul = $('#sugerencias');
  ul.innerHTML = lista.map((p, i) =>
    `<li data-i="${i}" class="${i === selSug ? 'sel' : ''}"><span>${esc(p.nombre)}${p.tipo === 'kg' ? '<span class="tag kg">kg</span>' : ''} <span class="muted small">${esc(p.codigo)}</span></span><span class="num">${p.precio > 0 ? fmt(p.precio) + (p.tipo === 'kg' ? '/kg' : '') : 'Sin precio'}</span></li>`
  ).join('');
  ul.classList.toggle('hidden', !lista.length);
}
function ocultarSugerencias() { sugeridos = []; selSug = -1; $('#sugerencias').classList.add('hidden'); }
function moverSugerencia(d) {
  if (!sugeridos.length) return;
  selSug = (selSug + d + sugeridos.length) % sugeridos.length;
  $$('#sugerencias li').forEach((li, i) => li.classList.toggle('sel', i === selSug));
}

function parseCantidad(txt) {
  const m = txt.match(/^(\d+(?:[.,]\d+)?)\s*\*\s*(.+)$/);
  return m ? { cant: Number(m[1].replace(',', '.')), resto: m[2].trim() } : { cant: 1, resto: txt };
}

// ───────────── Etiquetas de balanza (Historia 1.7)
/** Etiqueta EAN-13 de balanza: "2X" + PLU (4–6 dígitos) + importe o peso + dígito verificador.
 *  Devuelve { plu, pluTxt, valor, contenido } o null si no es una etiqueta de balanza. */
function leerEtiquetaBalanza(codigo, cfg = config) {
  if (cfg.balanza === false || !/^2\d{12}$/.test(codigo)) return null;
  const n = [4, 5, 6].includes(Number(cfg.balanzaPlu)) ? Number(cfg.balanzaPlu) : 5;
  const plu = codigo.slice(2, 2 + n);
  const numero = Number(codigo.slice(2 + n, 12));
  const contenido = cfg.balanzaContenido === 'peso' ? 'peso' : 'importe';
  const valor = contenido === 'peso' ? r3(numero / 1000) : r2(cfg.balanzaCentavos ? numero / 100 : numero);
  return { plu: String(Number(plu)), pluTxt: plu, valor, contenido };
}
function agregarEtiquetaBalanza(et) {
  ocultarSugerencias();
  $('#scan').value = '';
  const p = productos.get(et.plu) || productos.get(et.pluTxt);
  if (!p) {
    beep(false);
    toast(`Etiqueta de balanza: el producto ${et.plu} no está cargado. Cargalo con el código ${et.plu}.`, 'error');
    abrirFormProducto({ codigo: et.plu, tipo: 'kg' }, () => { if (productos.has(et.plu) || productos.has(et.pluTxt)) agregarEtiquetaBalanza(et); });
    return;
  }
  if (!(et.valor > 0)) { beep(false); toast('La etiqueta de balanza no trae importe ni peso', 'error'); return; }
  const it = itemDeEtiqueta(et, p);
  if (!it) {
    beep(false);
    toast(`“${p.nombre}” no tiene precio por kg. Cargalo una vez y queda guardado.`, 'error');
    abrirFormProducto(p, () => agregarEtiquetaBalanza(et), 'Poné el precio por kg');
    return;
  }
  agregarItem(it);
}
/** Ítem del carrito para una etiqueta de balanza, o null si falta el precio por kg (etiqueta con peso). */
function itemDeEtiqueta(et, p) {
  const base = { codigo: p.codigo, nombre: p.nombre, tipo: 'kg' };
  if (et.contenido === 'peso') return p.precio > 0 ? { ...base, precio: p.precio, cant: et.valor } : null;
  if (!(p.precio > 0)) return { ...base, tipo: 'u', precio: et.valor, cant: 1 };
  // La balanza ya calculó el importe: se cobra ese importe exacto y se muestra el peso aproximado
  const it = { ...base, precio: p.precio, cant: r3(et.valor / p.precio) };
  if (r2(it.cant * p.precio) !== et.valor) it.subtotal = et.valor;
  return it;
}

// ───────────── Un lector por vendedor (Historia 6.2)
// Cada lector se programa (desde su manual) para mandar una letra antes del código: "A7790…" = lector de Ana.
const LETRAS_LECTOR = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const hayLectores = () => Object.values(config.lectores || {}).some(Boolean);
function vendedorDeLector(letra) {
  const m = config.lectores || {};
  return vendedores().find((n) => m[n] && m[n] === String(letra).toUpperCase()) || null;
}
/** Ítem listo para sumar sin preguntar nada, o null si hace falta un dato (alta, precio o peso). */
function itemDirecto(codigo) {
  const p = productos.get(codigo);
  if (p) return p.precio > 0 && p.tipo !== 'kg' ? { codigo: p.codigo, nombre: p.nombre, precio: p.precio, cant: 1, tipo: 'u' } : null;
  const et = leerEtiquetaBalanza(codigo);
  const q = et && (productos.get(et.plu) || productos.get(et.pluTxt));
  return q && et.valor > 0 ? itemDeEtiqueta(et, q) : null;
}
/** Código leído por el lector de `nombre`: va a su pestaña. */
function escaneoDeLector(nombre, codigo) {
  if (!dialogoAbierto()) {
    if (vista !== 'venta') mostrar('venta');
    cambiarVendedor(nombre);
    procesarEntrada(codigo);
    return;
  }
  // Hay una ventana abierta (cobro, peso, producto…): no se interrumpe; se suma a la pestaña de quien escaneó
  if (nombre === vendedorActivo) { beep(false); toast(`${nombre}: cerrá la ventana abierta y volvé a escanear`, 'error'); return; }
  const it = itemDirecto(codigo);
  if (!it) { beep(false); toast(`${nombre}: ese producto necesita datos. Escanealo de nuevo cuando se cierre la ventana.`, 'error'); return; }
  const lista = carritos[nombre] || (carritos[nombre] = []);
  const igual = it.tipo === 'u' && lista.find((i) => i.tipo === 'u' && i.codigo === it.codigo);
  if (igual) igual.cant = r3(igual.cant + 1);
  else { it.id = ++seq; lista.push(it); }
  beep();
  guardarCarritos();
  renderPestanas();
  toast(`${nombre}: + ${it.nombre}`);
}
// Detecta la ráfaga del lector (letra + números + Enter, muy rápido) aunque el cursor esté en otra ventana,
// y deja el campo donde estaba el cursor como estaba.
let rafaga = null;
window.addEventListener('keydown', (e) => {
  if (!hayLectores() || e.ctrlKey || e.altKey || e.metaKey) { rafaga = null; return; }
  if (e.key === 'Shift') return;
  const ahora = performance.now();
  if (/^[A-Za-z]$/.test(e.key) && vendedorDeLector(e.key)) {
    const el = document.activeElement;
    rafaga = { nombre: vendedorDeLector(e.key), t: ahora, numeros: '', el, valor: el && 'value' in el ? el.value : null, scan: $('#scan').value };
    return;
  }
  if (!rafaga) return;
  if (ahora - rafaga.t > 80) { rafaga = null; return; }
  rafaga.t = ahora;
  if (/^\d$/.test(e.key)) { rafaga.numeros += e.key; return; }
  if (e.key === 'Enter' && rafaga.numeros.length >= 4) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const r = rafaga;
    rafaga = null;
    if (r.el !== $('#scan')) $('#scan').value = r.scan;
    if (r.valor != null) { r.el.value = r.valor; r.el.dispatchEvent(new Event('input', { bubbles: true })); }
    escaneoDeLector(r.nombre, r.numeros);
    return;
  }
  rafaga = null;
}, true);

function procesarEntrada(raw) {
  const txt = String(raw).trim();
  if (!txt) return;
  const conLetra = hayLectores() && txt.match(/^([A-Za-z])(\d{4,14})$/);
  if (conLetra && vendedorDeLector(conLetra[1])) { escaneoDeLector(vendedorDeLector(conLetra[1]), conLetra[2]); return; }
  const { cant, resto } = parseCantidad(txt);
  const p = productos.get(resto);
  if (p) { agregarProducto(p, cant); return; }
  const etiqueta = leerEtiquetaBalanza(resto);
  if (etiqueta) { agregarEtiquetaBalanza(etiqueta); return; }
  const lista = buscarProductos(resto);
  const esCodigo = /^\d+$/.test(resto);
  if (lista.length === 1 && !esCodigo) { agregarProducto(lista[0], cant); return; }
  if (lista.length && !esCodigo) { $('#scan').value = txt; mostrarSugerencias(lista); return; }
  // No encontrado
  beep(false);
  toast(`“${resto}” no está cargado. Completá los datos para darlo de alta.`, 'error');
  abrirFormProducto(esCodigo ? { codigo: resto } : { nombre: resto }, (nuevo) => agregarProducto(nuevo, cant));
}

function agregarProducto(p, cant = 1) {
  cerrarTecladoScan();
  ocultarSugerencias();
  $('#scan').value = '';
  if (!(p.precio > 0)) {
    // Producto importado sin precio (Historia 3.5): se pide una sola vez y queda guardado
    beep(false);
    toast(`“${p.nombre}” no tiene precio. Cargalo una vez y queda guardado.`, 'error');
    abrirFormProducto(p, (actualizado) => agregarProducto(actualizado, cant), 'Poné el precio');
    return;
  }
  if (p.tipo === 'kg') { abrirPeso(p); return; }
  if (!(cant > 0)) cant = 1;
  let it = carrito.find((i) => i.tipo === 'u' && i.codigo === p.codigo);
  if (it) it.cant = r3(it.cant + cant);
  else { it = { id: ++seq, codigo: p.codigo, nombre: p.nombre, precio: p.precio, cant, tipo: 'u' }; carrito.push(it); }
  ultimoAgregado = it.id;
  beep();
  renderCarrito();
}

function agregarItem(it) {
  it.id = ++seq;
  carrito.push(it);
  ultimoAgregado = it.id;
  beep();
  renderCarrito();
}

// ───────────── Vendedores y pestañas (Historia 6.1)
const vendedores = () => [...(config.vendedores || []).filter((n) => n && n !== INVITADO), INVITADO];

function guardarCarritos() {
  try { localStorage.setItem('pos-carritos', JSON.stringify({ activo: vendedorActivo, carritos })); } catch { /* sin almacenamiento */ }
}
function cargarCarritos() {
  try {
    const d = JSON.parse(localStorage.getItem('pos-carritos') || '{}');
    if (d.carritos && typeof d.carritos === 'object') carritos = d.carritos;
    if (d.activo) vendedorActivo = d.activo;
  } catch { /* nada guardado */ }
  for (const items of Object.values(carritos)) for (const it of items) seq = Math.max(seq, it.id || 0);
  if (!vendedores().includes(vendedorActivo)) vendedorActivo = INVITADO;
  setCarrito(carritos[vendedorActivo] || []);
}
function cambiarVendedor(nombre) {
  if (!vendedores().includes(nombre) || nombre === vendedorActivo) { focusScan(); return; }
  ocultarSugerencias();
  $('#scan').value = '';
  vendedorActivo = nombre;
  setCarrito(carritos[nombre] || []);
  ultimoAgregado = null;
  renderCarrito();
  focusScan();
}
function renderPestanas() {
  const lista = vendedores();
  const cont = $('#pestanas');
  const varias = lista.length > 1;
  cont.classList.toggle('hidden', !varias);
  $('#atajo-pestanas').classList.toggle('hidden', !varias);
  if (!varias) return;
  cont.innerHTML = lista.map((n, i) => {
    const items = carritos[n] || [];
    const total = r2(items.reduce((a, it) => a + subtotalItem(it), 0));
    const resumen = items.length ? `<span class="resumen">${items.length} · ${fmt(total)}</span>` : '';
    const letra = (config.lectores || {})[n] || (config.lectoresComActivo && (config.lectoresCom || {})[n] ? '⌁' : '');
    return `<button type="button" role="tab" data-vendedor="${esc(n)}" class="${n === vendedorActivo ? 'activa' : ''}" aria-selected="${n === vendedorActivo}">${esc(n)}${letra ? `<span class="lector-letra" title="Lector ${letra}">${letra}</span>` : ''}${resumen}${i < 4 ? `<kbd>F${6 + i}</kbd>` : ''}</button>`;
  }).join('');
}

function renderCarrito() {
  renderPestanas();
  guardarCarritos();
  const body = $('#carrito-body');
  body.innerHTML = carrito.map((it) => {
    const unidad = it.tipo === 'kg' ? '<span class="unidad">kg</span>' : '';
    const tag = it.tipo === 'kg' ? '<span class="tag kg">por kg</span>' : it.tipo === 'manual' ? '<span class="tag manual">manual</span>' : '';
    const precio = fmt(it.precio) + (it.tipo === 'kg' ? '<span class="unidad">/kg</span>' : '');
    return `<tr data-id="${it.id}" class="${it.id === ultimoAgregado ? 'nuevo' : ''}">
      <td>${esc(it.nombre)}${tag}</td>
      <td class="num">${precio}</td>
      <td class="num">${tablet ? celdaCantTablet(it) : `<input class="cant" data-id="${it.id}" value="${it.tipo === 'kg' ? fmtKg(it.cant) : fmtCant(it.cant)}" inputmode="decimal" aria-label="Cantidad">${unidad}`}</td>
      <td class="num"><strong>${fmt(subtotalItem(it))}</strong></td>
      <td><button class="icon-btn" data-quitar="${it.id}" title="Quitar" aria-label="Quitar">✕</button></td>
    </tr>`;
  }).join('');
  $('#carrito-vacio').classList.toggle('hidden', carrito.length > 0);
  const total = totalCarrito();
  $('#total').textContent = fmt(total);
  const unidades = carrito.length;
  $('#items-count').textContent = `${unidades} ${unidades === 1 ? 'artículo' : 'artículos'}`;
  $('#btn-cobrar').disabled = carrito.length === 0;
  const fila = body.querySelector('tr.nuevo');
  if (fila) { fila.scrollIntoView({ block: 'nearest' }); setTimeout(() => fila.classList.remove('nuevo'), 1200); }
}

function cambiarCantidad(id, valor) {
  const it = carrito.find((i) => i.id === id);
  if (!it) return;
  const n = Number(String(valor).trim().replace(/\./g, it.tipo === 'kg' ? '.' : '').replace(',', '.'));
  if (n > 0) { it.cant = r3(n); delete it.subtotal; }
  else if (n === 0) setCarrito(carrito.filter((i) => i.id !== id));
  renderCarrito();
  focusScan();
}

async function cancelarVenta() {
  if (!carrito.length) return;
  if (!await preguntar('Se van a quitar todos los artículos del carrito.', { titulo: '¿Cancelar la venta?', ok: 'Sí, cancelar' })) return;
  setCarrito([]);
  renderCarrito();
  focusScan();
}

// ───────────── Diálogos genéricos
function abrirDialogo(id) { const d = $(id); if (!d.open) d.showModal(); return d; }
$$('dialog').forEach((d) => {
  d.addEventListener('close', () => setTimeout(focusScan, 0));
  d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
});

// ───────────── Diálogo de confirmación propio (los confirm/prompt del navegador pueden estar bloqueados)
let resolverPregunta = null;
/** Muestra una pregunta. Devuelve true (o el texto ingresado si `input`) al aceptar, o null al cancelar. */
function preguntar(msg, { titulo = 'Confirmar', ok = 'Aceptar', input = false, placeholder = '', teclado = false } = {}) {
  if (resolverPregunta) resolverPregunta(null);
  return new Promise((res) => {
    $('#confirm-titulo').textContent = titulo;
    $('#confirm-msg').textContent = msg;
    $('#confirm-ok').textContent = ok;
    const inp = $('#confirm-input');
    inp.classList.toggle('hidden', !input);
    inp.value = '';
    inp.placeholder = placeholder;
    // Modo tablet: los números se escriben con el teclado en pantalla (sin abrir el teclado del sistema)
    inp.inputMode = teclado ? (tablet ? 'none' : 'decimal') : 'text';
    $('#confirm-teclado').classList.toggle('hidden', !(input && teclado));
    resolverPregunta = res;
    abrirDialogo('#dlg-confirm');
    (input ? inp : $('#confirm-ok')).focus();
  });
}
$('#form-confirm').addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = $('#confirm-input');
  const valor = inp.classList.contains('hidden') ? true : inp.value;
  const r = resolverPregunta;
  resolverPregunta = null;
  $('#dlg-confirm').close();
  if (r) r(valor);
});
$('#dlg-confirm').addEventListener('close', () => {
  // El evento 'close' llega asíncrono: si ya se abrió otra pregunta, no cancelarla.
  if (resolverPregunta && !$('#dlg-confirm').open) { const r = resolverPregunta; resolverPregunta = null; r(null); }
});

// ───────────── Diálogo: peso (Historia 1.4)
let pesoProducto = null;
function abrirPeso(p) {
  pesoProducto = p;
  $('#peso-nombre').textContent = p.nombre;
  $('#peso-precio').textContent = `${fmt(p.precio)} por kg`;
  $('#form-peso').modo.value = 'peso';
  $('#peso-input').value = '';
  actualizarPreviewPeso();
  abrirDialogo('#dlg-peso');
  $('#peso-input').focus();
}
function leerPeso() {
  return parsePeso($('#peso-input').value, pesoProducto?.precio, $('#form-peso').modo.value === 'importe');
}
function actualizarPreviewPeso() {
  const r = pesoProducto && leerPeso();
  $('#peso-input').placeholder = $('#form-peso').modo.value === 'importe' ? 'Importe a cobrar, ej: 1500' : 'Ej: 350 (gramos) o 1,2 (kg)';
  $('#peso-preview').textContent = r ? `${fmtKg(r.cant)} kg × ${fmt(pesoProducto.precio)}/kg = ${fmt(r.subtotal)}` : '—';
}
$('#peso-input').addEventListener('input', actualizarPreviewPeso);
$$('#form-peso [name=modo]').forEach((r) => r.addEventListener('change', () => { actualizarPreviewPeso(); $('#peso-input').focus(); }));
$('#form-peso').addEventListener('submit', (e) => {
  e.preventDefault();
  const r = leerPeso();
  if (!r || !(r.cant > 0)) { beep(false); $('#peso-input').focus(); return; }
  const p = pesoProducto;
  const it = { codigo: p.codigo, nombre: p.nombre, precio: p.precio, cant: r.cant, tipo: 'kg' };
  if (r.subtotal !== r2(r.cant * p.precio)) it.subtotal = r.subtotal; // importe exacto pedido
  $('#dlg-peso').close();
  agregarItem(it);
});

// ───────────── Diálogo: artículo manual (Historia 1.5)
function abrirManual() {
  const f = $('#form-manual');
  f.reset();
  $('#manual-error').textContent = '';
  $$('#manual-descs [data-desc]').forEach((b) => b.classList.remove('elegido'));
  abrirDialogo('#dlg-manual');
  (tablet ? f.precio : f.desc).focus();
}
$('#form-manual').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const precio = r2(parseMonto(f.precio.value));
  const cant = f.cant.value.trim() === '' ? 1 : Number(f.cant.value.replace(',', '.'));
  if (!(precio > 0)) { $('#manual-error').textContent = 'Ingresá un precio mayor a cero.'; f.precio.focus(); return; }
  if (!(cant > 0)) { $('#manual-error').textContent = 'La cantidad debe ser mayor a cero.'; f.cant.focus(); return; }
  $('#dlg-manual').close();
  agregarItem({ codigo: null, nombre: f.desc.value.trim() || 'Varios', precio, cant: r3(cant), tipo: 'manual' });
});

// ───────────── Diálogo: cobro (Historia 1.6)
function abrirCobro() {
  if (!carrito.length) return;
  const total = totalCarrito();
  const f = $('#form-cobro');
  f.medio.value = 'Efectivo';
  $('#paga-con').value = '';
  $('#cobro-error').textContent = '';
  $('#cobro-total').textContent = fmt(total);
  const sug = [...new Set([100, 1000, 2000, 5000, 10000, 20000].map((b) => Math.ceil(total / b) * b))]
    .filter((v) => v > total).sort((a, b) => a - b).slice(0, 4);
  $('#billetes').innerHTML = `<button type="button" data-paga="${total}">Exacto</button>` +
    sug.map((v) => `<button type="button" data-paga="${v}">${fmt(v).replace(',00', '')}</button>`).join('');
  actualizarCobro();
  abrirDialogo('#dlg-cobro');
  $('#paga-con').focus();
}
function actualizarCobro() {
  const f = $('#form-cobro');
  const efectivo = f.medio.value === 'Efectivo';
  $('#efectivo-box').classList.toggle('hidden', !efectivo);
  const total = totalCarrito();
  const paga = parseMonto($('#paga-con').value);
  const vuelto = paga > 0 ? r2(paga - total) : 0;
  $('#vuelto').textContent = fmt(Math.max(vuelto, 0));
  $('#cobro-error').textContent = efectivo && paga > 0 && vuelto < 0 ? `Faltan ${fmt(-vuelto)}` : '';
}
$('#paga-con').addEventListener('input', actualizarCobro);
$$('#form-cobro [name=medio]').forEach((r) => r.addEventListener('change', actualizarCobro));
$('#billetes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-paga]');
  if (!b) return;
  $('#paga-con').value = String(b.dataset.paga).replace('.', ',');
  actualizarCobro();
  $('#paga-con').focus();
});
$('#form-cobro').addEventListener('submit', async (e) => {
  e.preventDefault();
  const total = totalCarrito();
  const medio = e.target.medio.value;
  let pagaCon = null, vuelto = 0;
  if (medio === 'Efectivo') {
    const raw = $('#paga-con').value.trim();
    pagaCon = raw ? r2(parseMonto(raw)) : total;
    if (!(pagaCon >= total)) { beep(false); $('#cobro-error').textContent = 'El pago es menor al total.'; $('#paga-con').focus(); return; }
    vuelto = r2(pagaCon - total);
  }
  const venta = {
    fecha: Date.now(),
    items: carrito.map(({ codigo, nombre, precio, cant, tipo, subtotal }) => ({ codigo, nombre, precio, cant, tipo, subtotal: subtotal ?? r2(precio * cant) })),
    total, medio, pagaCon, vuelto, anulada: false, vendedor: vendedorActivo,
  };
  try {
    venta.id = await DB.guardarVenta(venta);
  } catch (err) {
    $('#cobro-error').textContent = 'No se pudo guardar la venta: ' + err.message;
    return;
  }
  $('#dlg-cobro').close();
  setCarrito([]);
  renderCarrito();
  ultimaVenta = venta;
  const u = $('#ultima-venta');
  u.innerHTML = (medio === 'Efectivo'
    ? `Venta N° ${venta.id}: ${fmt(total)}<br>Pagó con ${fmt(pagaCon)} · Vuelto<strong>${fmt(vuelto)}</strong>`
    : `Venta N° ${venta.id}: ${fmt(total)}<br>${esc(medio)}<strong>Cobrado</strong>`) +
    (vendedores().length > 1 ? `<div class="vendedor-venta">Atendió: ${esc(venta.vendedor)}</div>` : '') +
    '<button type="button" class="secondary small" id="btn-ticket-ultima">Imprimir ticket</button>';
  u.classList.remove('hidden');
  beep();
  toast(`Venta registrada: ${fmt(total)}${medio === 'Efectivo' ? ` · Vuelto ${fmt(vuelto)}` : ''}`);
  if (config.imprimir === 'siempre') imprimirTicket(venta);
  else if (config.imprimir === 'preguntar' && await hayImpresora() &&
    await preguntar(`Venta N° ${venta.id} por ${fmt(total)}.`, { titulo: '¿Imprimir ticket?', ok: 'Imprimir' })) imprimirTicket(venta);
});

// ───────────── Ticket (Historia 4.1)
let ultimaVenta = null;
function htmlTicket(v, cfg = config) {
  const L = (a, b = '', cls = '') => `<div class="tl ${cls}"><span>${a}</span><span>${b}</span></div>`;
  const d = new Date(v.fecha);
  const fecha = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `<div class="tc tb tg">${esc(String(cfg.negocio).toUpperCase())}</div>` +
    (cfg.direccion ? `<div class="tc">${esc(cfg.direccion)}</div>` : '') +
    (cfg.telefono ? `<div class="tc">Tel: ${esc(cfg.telefono)}</div>` : '') +
    '<hr>' + L(fecha, v.id ? `Venta N° ${v.id}` : 'PRUEBA') +
    (v.vendedor && v.vendedor !== INVITADO ? L(`Atendió: ${esc(v.vendedor)}`) : '') + '<hr>' +
    v.items.map((i) => `<div>${esc(i.nombre)}</div>` + L(
      i.tipo === 'kg' ? `${fmtKg(i.cant)} kg x ${fmt(i.precio)}` : `${fmtCant(i.cant)} x ${fmt(i.precio)}`,
      fmt(i.subtotal ?? r2(i.precio * i.cant)), 'ti')).join('') +
    '<hr>' + L('TOTAL', fmt(v.total), 'tb tg') + L(esc(v.medio)) +
    (v.medio === 'Efectivo' && v.pagaCon != null ? L('Pagó con', fmt(v.pagaCon)) + L('Vuelto', fmt(v.vuelto)) : '') +
    (v.anulada ? '<div class="tc tb">*** VENTA ANULADA ***</div>' : '') +
    '<hr>' + (cfg.pie ? `<div class="tc">${esc(cfg.pie)}</div>` : '') +
    '<div class="tc">NO VÁLIDO COMO FACTURA</div>';
}
async function imprimirHTML(html, cfg = config) {
  const t = $('#ticket');
  t.className = 'ticket p' + cfg.papel;
  t.innerHTML = html;
  if (ESCRITORIO && (cfg.modoImpresion || 'texto') === 'texto') {
    // Modo texto ESC/POS: letras de la impresora, sin imágenes, con corte de papel
    const r = await window.escritorio.imprimirTexto({
      impresora: cfg.impresora || '', papel: cfg.papel, codepage: cfg.codepage || 'pc850', ops: documentoTexto(t),
      columnas: cfg.columnas || null, margen: cfg.margen || 0,
    }).catch((e) => ({ ok: false, motivo: e.message }));
    if (!r.ok) toast(`No se pudo imprimir${r.motivo ? ': ' + r.motivo : ''}. Probá el modo Gráfico en Ajustes.`, 'error');
  } else if (ESCRITORIO) {
    // Impresión directa, sin diálogo
    // Tamaño de página exacto: ancho del rollo y alto del ticket (evita cortes)
    const altoMm = Math.ceil(t.getBoundingClientRect().height * 25.4 / 96) + 12;
    const anchoMm = { 58: 58, 70: 70 }[cfg.papel] || 80;
    const r = await window.escritorio.imprimir({ impresora: cfg.impresora || '', anchoMm, altoMm }).catch((e) => ({ ok: false, motivo: e.message }));
    if (!r.ok) toast(`No se pudo imprimir${r.motivo ? ': ' + r.motivo : ''}. Revisá la impresora en Ajustes.`, 'error');
  } else {
    try { window.print(); } catch { toast('El navegador bloqueó la impresión. Usá la app instalada.', 'error'); }
  }
  setTimeout(focusScan, 0);
}
const imprimirTicket = (v, cfg = config) => imprimirHTML(htmlTicket(v, cfg), cfg);
/** ¿Hay una impresora para el ticket? (Historia 4.3) En el programa de escritorio: la elegida en Ajustes
 *  está instalada o, si es "Predeterminada", hay alguna impresora predeterminada. En el navegador no se puede saber. */
async function hayImpresora() {
  if (!window.escritorio?.impresoras) return true;
  try {
    const lista = await window.escritorio.impresoras();
    return config.impresora ? lista.some((p) => p.nombre === config.impresora) : lista.some((p) => p.predeterminada);
  } catch { return true; }
}

/** Convierte el ticket armado en HTML (#ticket) en operaciones de texto para ESC/POS (Historia 4.2). */
function documentoTexto(raiz) {
  const ops = [];
  const txt = (n) => (n ? n.textContent.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim() : '');
  const recorrer = (padre) => {
    for (const n of padre.children) {
      if (n.tagName === 'HR') { ops.push({ t: 'linea' }); continue; }
      const c = n.classList;
      if (c.contains('tl')) {
        const [a, b] = n.children;
        const grande = c.contains('tg');
        ops.push({
          t: 'cols', izq: (c.contains('ti') ? '  ' : '') + txt(a), der: txt(b),
          negrita: c.contains('tb'), grande, grandeDer: !grande && !!(b && b.classList.contains('tg')),
        });
      } else if (c.contains('firma')) {
        ops.push({ t: 'avance', n: 3 }, { t: 'texto', texto: '________________________', alinear: 'centro' }, { t: 'texto', texto: txt(n), alinear: 'centro' });
      } else if (n.querySelector('.tl, hr')) {
        if (c.contains('completar')) ops.push({ t: 'avance', n: 1 });
        recorrer(n);
      } else {
        ops.push({
          t: 'texto', texto: txt(n), alinear: c.contains('tc') || c.contains('tsub') ? 'centro' : 'izq',
          negrita: c.contains('tb') || c.contains('tsub'), grande: c.contains('tg'),
        });
      }
    }
  };
  recorrer(raiz);
  return ops;
}

/** Cierre de caja del día `dia` ('AAAA-MM-DD') en formato ticket (Historia 2.4). */
function htmlCierre(dia, ventas, apertura, cfg = config) {
  const L = (a, b = '', cls = '') => `<div class="tl ${cls}"><span>${a}</span><span>${b}</span></div>`;
  const r = resumenDia(ventas, apertura);
  const [y, m, d] = dia.split('-');
  const ahora = new Date();
  const hhmm = (t) => { const x = new Date(t); return `${pad(x.getHours())}:${pad(x.getMinutes())}`; };
  const lista = [...ventas].sort((a, b) => a.fecha - b.fecha);
  return `<div class="tc tb tg">${esc(String(cfg.negocio).toUpperCase())}</div>` +
    (cfg.direccion ? `<div class="tc">${esc(cfg.direccion)}</div>` : '') +
    '<hr><div class="tsub">CIERRE DE CAJA</div>' +
    L('Día', `${d}/${m}/${y}`) +
    L('Impreso', `${pad(ahora.getDate())}/${pad(ahora.getMonth() + 1)} ${pad(ahora.getHours())}:${pad(ahora.getMinutes())}`) +
    '<hr>' +
    L('Cambio inicial', r.hayApertura ? fmt(r.inicial) : 'sin cargar') +
    L(`Ventas (${r.validas.length})`, fmt(r.total), 'tb') +
    MEDIOS.map((med) => L(`&nbsp;&nbsp;${esc(med)}`, fmt(r.porMedio[med]))).join('') +
    (r.anuladas.length ? L(`Anuladas (${r.anuladas.length})`, fmt(r.totalAnuladas)) : '') +
    '<hr>' + `<div class="tl tb"><span>EFECTIVO EN CAJA</span><span class="tg">${fmt(r.enCaja)}</span></div>` +
    '<div class="tc">(cambio + ventas en efectivo)</div>' +
    '<hr><div class="tsub">DETALLE DE VENTAS</div>' +
    (lista.length
      ? lista.map((v) => L(`N° ${v.id} ${hhmm(v.fecha)} ${esc(v.medio === 'Transferencia/QR' ? 'Transf/QR' : v.medio)}`, v.anulada ? 'ANULADA' : fmt(v.total))).join('')
      : '<div class="tc">Sin ventas</div>') +
    '<hr><div class="completar">' + L('Efectivo contado:', '$ ____________') + '</div>' +
    '<div class="completar">' + L('Diferencia:', '$ ____________') + '</div>' +
    '<div class="firma">Firma</div>';
}
async function imprimirCaja() {
  const dia = $('#caja-fecha').value || hoyISO();
  const ventas = await DB.ventasEntre(...rangoDia(dia));
  imprimirHTML(htmlCierre(dia, ventas, await DB.getApertura(dia)));
}
function ventaDePrueba() {
  const items = [
    { nombre: 'Gaseosa cola 1,5 L', precio: 2500, cant: 2, tipo: 'u' },
    { nombre: 'Jamón cocido', precio: 9000, cant: 0.35, tipo: 'kg' },
    { nombre: 'Bolsa de hielo', precio: 1200, cant: 1, tipo: 'manual' },
  ].map((i) => ({ ...i, subtotal: r2(i.precio * i.cant) }));
  const total = r2(items.reduce((a, i) => a + i.subtotal, 0));
  return { id: 0, fecha: Date.now(), items, total, medio: 'Efectivo', pagaCon: 10000, vuelto: r2(10000 - total) };
}
/** Configuración tal como está escrita en Ajustes (sin guardar). */
function configFormulario() {
  return {
    ...config,
    negocio: $('#cfg-negocio').value.trim() || CONFIG_DEF.negocio,
    sonido: $('#cfg-sonido').checked,
    pedirCambio: $('#cfg-pedir-cambio').checked,
    buscarOnline: $('#cfg-buscar-online').checked,
    modoTablet: ['auto', 'si', 'no'].includes($('#cfg-tablet').value) ? $('#cfg-tablet').value : 'auto',
    balanza: $('#cfg-balanza').checked,
    balanzaPlu: ['4', '5', '6'].includes($('#cfg-balanza-plu').value) ? $('#cfg-balanza-plu').value : '5',
    balanzaContenido: $('#cfg-balanza-contenido').value === 'peso' ? 'peso' : 'importe',
    balanzaCentavos: $('#cfg-balanza-centavos').checked,
    direccion: $('#cfg-direccion').value.trim(),
    telefono: $('#cfg-telefono').value.trim(),
    pie: $('#cfg-pie').value.trim(),
    papel: ['58', '70', '80'].includes($('#cfg-papel').value) ? $('#cfg-papel').value : '80',
    imprimir: ['nunca', 'preguntar', 'siempre'].includes($('#cfg-imprimir').value) ? $('#cfg-imprimir').value : 'nunca',
    impresora: ESCRITORIO ? $('#cfg-impresora').value : config.impresora,
    modoImpresion: ESCRITORIO ? $('#cfg-modo-impresion').value : config.modoImpresion,
    codepage: ESCRITORIO ? $('#cfg-codepage').value : config.codepage,
    columnas: ESCRITORIO ? $('#cfg-columnas').value : config.columnas,
    margen: ESCRITORIO ? $('#cfg-margen').value : config.margen,
  };
}
/** Ejemplo de etiqueta según la configuración elegida, para que se entienda qué número es cada parte. */
function renderEjemploBalanza() {
  const cfg = configFormulario();
  const n = Number(cfg.balanzaPlu);
  const resto = 10 - n;
  const valorTxt = (cfg.balanzaContenido === 'peso' ? '350' : (cfg.balanzaCentavos ? '185500' : '1855')).padStart(resto, '0').slice(-resto);
  const cuerpo = '20' + '15'.padStart(n, '0') + valorTxt;
  const dv = (10 - [...cuerpo].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0) % 10) % 10;
  const et = leerEtiquetaBalanza(cuerpo + dv, { ...cfg, balanza: true });
  $('#cfg-balanza-centavos-wrap').classList.toggle('hidden', cfg.balanzaContenido === 'peso');
  $('#balanza-ejemplo').innerHTML = !cfg.balanza ? 'Desactivado: las etiquetas de balanza se toman como un código cualquiera.'
    : `Ejemplo: <code>20 ${'15'.padStart(n, '0')} ${valorTxt} ${dv}</code> → producto <strong>${et.plu}</strong>, ` +
      (et.contenido === 'peso' ? `peso <strong>${fmtKg(et.valor)} kg</strong>` : `importe <strong>${fmt(et.valor)}</strong>`);
}
$$('#cfg-balanza, #cfg-balanza-plu, #cfg-balanza-contenido, #cfg-balanza-centavos').forEach((el) => el.addEventListener('change', renderEjemploBalanza));

function renderPreviewTicket() {
  const cfg = configFormulario();
  const p = $('#ticket-preview');
  p.className = 'ticket p' + cfg.papel;
  p.innerHTML = htmlTicket(ventaDePrueba(), cfg);
}

// ───────────── Nombre del producto desde internet (Historia 3.7)
// Bases abiertas de Open Food Facts (alimentos, hogar/limpieza, higiene, mascotas). Solo se envía el código de barras.
const BASES_ONLINE = ['world.openfoodfacts.org', 'world.openproductsfacts.org', 'world.openbeautyfacts.org', 'world.openpetfoodfacts.org'];
function nombreDesdeBase(p) {
  let nombre = String(p.product_name_es || p.product_name || '').replace(/\s+/g, ' ').trim().replace(/^[^0-9A-Za-zÀ-ÿ¡¿]+/, '');
  if ((nombre.match(/[A-Za-zÀ-ÿ]/g) || []).length < 3) return '';
  const marca = String(p.brands || '').split(',')[0].trim();
  const cantidad = String(p.quantity || '').trim();
  const base = norm(nombre);
  if (marca && !base.includes(norm(marca))) nombre += ' ' + marca;
  if (cantidad && !base.replace(/ /g, '').includes(norm(cantidad).replace(/ /g, ''))) nombre += ' ' + cantidad;
  nombre = nombre.slice(0, 80);
  return nombre.charAt(0).toUpperCase() + nombre.slice(1);
}
async function buscarNombreOnline(codigo) {
  const consultar = async (host) => {
    const ctrl = new AbortController();
    const reloj = setTimeout(() => ctrl.abort(), 5000);
    try {
      const r = await fetch(`https://${host}/api/v2/product/${encodeURIComponent(codigo)}.json?fields=product_name,product_name_es,brands,quantity`, { signal: ctrl.signal });
      if (!r.ok) return '';
      const d = await r.json();
      return d && d.status === 1 && d.product ? nombreDesdeBase(d.product) : '';
    } catch { return ''; } finally { clearTimeout(reloj); }
  };
  const nombres = await Promise.all(BASES_ONLINE.map(consultar));
  return nombres.find(Boolean) || '';
}
async function autocompletarNombre(codigo) {
  const f = $('#form-producto');
  const estado = $('#prod-online');
  if (config.buscarOnline === false || !/^\d{8,14}$/.test(codigo) || f.nombre.value.trim()) { estado.textContent = ''; return; }
  if (navigator.onLine === false) { estado.textContent = 'Sin internet: escribí el nombre.'; return; }
  estado.textContent = 'Buscando el nombre en internet…';
  const nombre = await buscarNombreOnline(codigo);
  // Solo si el formulario sigue abierto con el mismo código y nadie escribió un nombre
  if (!$('#dlg-producto').open || f.codigo.value.trim() !== codigo) return;
  if (nombre && !f.nombre.value.trim()) {
    f.nombre.value = nombre;
    estado.textContent = 'Nombre encontrado en internet: revisalo y poné el precio.';
    f.precio.focus();
  } else {
    estado.textContent = nombre ? '' : 'No se encontró en internet: escribí el nombre.';
  }
}

// ───────────── Productos (Historia 1.2, 3.1, 3.2)
let alGuardarProducto = null;
const seleccion = new Set(); // códigos tildados en Productos (Historia 3.4)
let codigoEditando = null;

function abrirFormProducto(datos = {}, callback = null, titulo = null) {
  const f = $('#form-producto');
  f.reset();
  codigoEditando = productos.has(datos.codigo) ? datos.codigo : null;
  alGuardarProducto = callback;
  $('#prod-titulo').textContent = titulo || (codigoEditando ? 'Editar producto' : 'Nuevo producto');
  f.codigo.value = datos.codigo ?? '';
  f.nombre.value = datos.nombre ?? '';
  f.precio.value = datos.precio > 0 ? String(datos.precio).replace('.', ',') : '';
  f.tipo.value = datos.tipo || 'u';
  actualizarLabelPrecio();
  $('#prod-error').textContent = '';
  $('#prod-online').textContent = '';
  abrirDialogo('#dlg-producto');
  if (!codigoEditando && f.codigo.value && !f.nombre.value) autocompletarNombre(f.codigo.value.trim());
  (f.codigo.value ? (f.nombre.value ? f.precio : f.nombre) : f.codigo).focus();
}
function actualizarLabelPrecio() { $('#prod-precio-label').textContent = $('#form-producto').tipo.value === 'kg' ? 'por kg' : 'por unidad'; }
$$('#form-producto [name=tipo]').forEach((r) => r.addEventListener('change', actualizarLabelPrecio));
// El lector envía Enter al final del código: pasar al siguiente campo en vez de enviar.
$('#form-producto').codigo.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#form-producto').nombre.focus();
    if (!codigoEditando) autocompletarNombre(e.target.value.trim());
  }
});
$('#btn-gen-codigo').addEventListener('click', () => {
  let n = 1;
  while (productos.has(String(n))) n++;
  $('#form-producto').codigo.value = String(n);
  $('#form-producto').nombre.focus();
});
$('#form-producto').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const codigo = f.codigo.value.trim();
  const nombre = f.nombre.value.trim();
  const precio = r2(parseMonto(f.precio.value));
  const err = $('#prod-error');
  if (!codigo || !nombre) { err.textContent = 'Completá código y nombre.'; return; }
  if (!(precio > 0)) { err.textContent = 'Ingresá un precio mayor a cero.'; f.precio.focus(); return; }
  if (codigo !== codigoEditando && productos.has(codigo)) { err.textContent = `El código ${codigo} ya existe (${productos.get(codigo).nombre}).`; f.codigo.focus(); return; }
  const prod = { codigo, nombre, precio, tipo: f.tipo.value === 'kg' ? 'kg' : 'u', actualizado: Date.now() };
  const borrar = codigoEditando && codigoEditando !== codigo ? [codigoEditando] : [];
  try { await DB.guardarProductos([prod], borrar); } catch (ex) { err.textContent = 'Error al guardar: ' + ex.message; return; }
  borrar.forEach((c) => productos.delete(c));
  productos.set(codigo, prod);
  const cb = alGuardarProducto;
  alGuardarProducto = null;
  $('#dlg-producto').close();
  toast(`Producto guardado: ${nombre}`);
  if (vista === 'productos') renderProductos();
  if (cb) cb(prod);
});

function productosFiltrados() {
  const q = $('#prod-buscar').value.trim();
  let lista = q ? buscarProductos(q, Infinity) : [...productos.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));
  if (q && productos.has(q) && !lista.includes(productos.get(q))) lista.unshift(productos.get(q));
  if ($('#prod-sin-precio').checked) lista = lista.filter((p) => !(p.precio > 0));
  return lista;
}
function renderProductos() {
  const lista = productosFiltrados();
  const MAX = 500;
  const visibles = lista.slice(0, MAX);
  $('#prod-body').innerHTML = visibles.map((p) => `<tr class="${seleccion.has(p.codigo) ? 'seleccionado' : ''}">
    <td class="sel"><input type="checkbox" data-sel="${esc(p.codigo)}" ${seleccion.has(p.codigo) ? 'checked' : ''} aria-label="Seleccionar ${esc(p.nombre)}"></td>
    <td class="muted">${esc(p.codigo)}</td>
    <td>${esc(p.nombre)}</td>
    <td>${p.tipo === 'kg' ? '<span class="tag kg">por kg</span>' : 'Unidad'}</td>
    <td class="num">${p.precio > 0 ? fmt(p.precio) : '<span class="tag sinprecio">Sin precio</span>'}</td>
    <td class="num"><button class="small ghost" data-editar="${esc(p.codigo)}">Editar</button> <button class="icon-btn" data-borrar="${esc(p.codigo)}" title="Eliminar" aria-label="Eliminar">✕</button></td>
  </tr>`).join('');
  $('#prod-info').textContent = productos.size === 0
    ? 'Todavía no hay productos. Cargalos con “Nuevo producto”, importá un CSV o escaneá directamente desde Venta.'
    : `${lista.length} de ${productos.size} productos${lista.length > MAX ? ` (se muestran los primeros ${MAX}; usá el buscador)` : ''}`;
  const todos = $('#sel-todos');
  const tildados = visibles.filter((p) => seleccion.has(p.codigo)).length;
  todos.checked = visibles.length > 0 && tildados === visibles.length;
  todos.indeterminate = tildados > 0 && tildados < visibles.length;
  renderSeleccion();
}
function renderSeleccion() {
  const info = $('#sel-info');
  info.classList.toggle('hidden', seleccion.size === 0);
  info.innerHTML = `${seleccion.size} seleccionado${seleccion.size === 1 ? '' : 's'} <button class="small ghost" id="btn-sel-limpiar">Quitar selección</button>` +
    `<button class="small ghost peligro" id="btn-sel-eliminar">Eliminar seleccionados</button>`;
  $('#btn-aumento').textContent = seleccion.size ? `Actualizar precios % (${seleccion.size})` : 'Actualizar precios %';
}

/** Copia de seguridad automática antes de un borrado masivo (solo en el programa de escritorio). */
async function copiaPrevia(etiqueta) {
  if (!ESCRITORIO) return;
  try { await window.escritorio.guardarBackup(JSON.stringify(await datosBackup()), etiqueta); } catch { /* seguir igual */ }
}
async function eliminarSeleccionados() {
  const codigos = [...seleccion].filter((c) => productos.has(c));
  if (!codigos.length) return;
  const muestra = codigos.slice(0, 5).map((c) => '• ' + productos.get(c).nombre).join('\n') + (codigos.length > 5 ? `\n… y ${codigos.length - 5} más` : '');
  if (!await preguntar(`${codigos.length} producto(s):\n${muestra}`, { titulo: '¿Eliminar los seleccionados?', ok: 'Eliminar' })) return;
  await copiaPrevia('antes-de-eliminar');
  await DB.guardarProductos([], codigos);
  codigos.forEach((c) => productos.delete(c));
  seleccion.clear();
  renderProductos();
  toast(`${codigos.length} producto(s) eliminado(s)`);
}
async function vaciarProductos() {
  if (!productos.size) { toast('No hay productos para borrar', 'error'); return; }
  const r = await preguntar(`Se van a borrar los ${productos.size} productos. Las ventas y la caja no se tocan.\nPara confirmar, escribí BORRAR.`,
    { titulo: '¿Borrar todos los productos?', ok: 'Borrar todo', input: true, placeholder: 'BORRAR' });
  if (r == null) return;
  if (r.trim().toUpperCase() !== 'BORRAR') { toast('No se borró nada: hay que escribir BORRAR', 'error'); return; }
  await copiaPrevia('antes-de-vaciar');
  const cantidad = productos.size;
  await DB.borrarTodosLosProductos();
  productos.clear();
  seleccion.clear();
  if (vista === 'productos') renderProductos();
  toast(`Se borraron ${cantidad} productos`);
}

async function borrarProducto(codigo) {
  const p = productos.get(codigo);
  if (!p || !await preguntar(p.nombre, { titulo: '¿Eliminar producto?', ok: 'Eliminar' })) return;
  await DB.guardarProductos([], [codigo]);
  productos.delete(codigo);
  seleccion.delete(codigo);
  renderProductos();
  toast('Producto eliminado');
}

async function aumentarPrecios() {
  const porSeleccion = seleccion.size > 0;
  const lista = porSeleccion ? [...seleccion].map((c) => productos.get(c)).filter(Boolean) : productosFiltrados();
  if (!lista.length) { toast('No hay productos para actualizar', 'error'); return; }
  const cuales = porSeleccion ? 'los seleccionados' : $('#prod-buscar').value.trim() ? 'los de la lista' : 'todos';
  const r = await preguntar(`Se aplica a ${lista.length} producto(s) (${cuales}).\nEj: 10 para subir 10%, -5 para bajar 5%.`,
    { titulo: 'Actualizar precios %', ok: 'Continuar', input: true, placeholder: 'Porcentaje, ej: 10' });
  if (r == null) return;
  const pct = Number(String(r).replace('%', '').replace(',', '.').trim());
  if (!isFinite(pct) || pct === 0 || pct <= -100) { toast('Porcentaje inválido', 'error'); return; }
  const ahora = Date.now();
  const nuevos = lista.map((p) => ({ ...p, precio: r2(p.precio * (1 + pct / 100)), actualizado: ahora }));
  const MUESTRA = 6;
  const detalle = nuevos.slice(0, MUESTRA).map((p, i) => `• ${p.nombre}: ${fmt(lista[i].precio)} → ${fmt(p.precio)}`).join('\n') +
    (nuevos.length > MUESTRA ? `\n… y ${nuevos.length - MUESTRA} más` : '');
  if (!await preguntar(`${pct > 0 ? '+' : ''}${pct}% a ${lista.length} producto(s):\n${detalle}`, { titulo: '¿Actualizar precios?', ok: 'Aplicar' })) return;
  await DB.guardarProductos(nuevos);
  nuevos.forEach((p) => productos.set(p.codigo, p));
  seleccion.clear();
  renderProductos();
  toast(`Precios actualizados (${pct > 0 ? '+' : ''}${pct}%) en ${nuevos.length} producto(s)`);
}

function parseCSV(texto) {
  const lineas = texto.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lineas.length) return [];
  const sep = [';', '\t', ','].find((s) => lineas[0].includes(s)) || ';';
  const partir = (l) => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === sep) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map((x) => x.trim());
  };
  const filas = lineas.map(partir);
  if (/c[oó]digo|nombre|precio/i.test(filas[0].join(' '))) filas.shift();
  return filas;
}
async function importarCSV(file) {
  let filas;
  try { filas = parseCSV(await file.text()); } catch (e) { toast('No se pudo leer el archivo: ' + e.message, 'error'); return; }
  const ok = [], errores = [];
  let yaCargados = 0;
  const ahora = Date.now();
  filas.forEach((f, i) => {
    const [codigo, nombre, precioTxt, tipoTxt] = f;
    const precio = r2(parseMonto(precioTxt));
    const sinPrecio = !String(precioTxt ?? '').trim() || precio === 0;
    if (!codigo || !nombre || (!sinPrecio && !(precio > 0))) { errores.push(i + 1); return; }
    const tipo = /^k/i.test(tipoTxt || '') ? 'kg' : 'u';
    // Una fila sin precio no pisa un producto que ya existe (conserva su nombre y precio)
    if (sinPrecio && productos.has(codigo)) { yaCargados++; return; }
    ok.push({ codigo, nombre, precio: sinPrecio ? 0 : precio, tipo, actualizado: ahora });
  });
  if (!ok.length) { toast(yaCargados ? `Los ${yaCargados} productos del archivo ya estaban cargados` : 'No se encontraron productos válidos en el archivo', yaCargados ? 'ok' : 'error'); return; }
  const nuevos = ok.filter((p) => !productos.has(p.codigo)).length;
  if (!await preguntar(`${ok.length} producto(s): ${nuevos} nuevo(s) y ${ok.length - nuevos} actualización(es).${yaCargados ? `\n${yaCargados} ya cargado(s) se dejan como están.` : ''}${errores.length ? `\n${errores.length} fila(s) con errores se omitirán (filas: ${errores.slice(0, 10).join(', ')}${errores.length > 10 ? '…' : ''}).` : ''}`,
    { titulo: 'Importar productos', ok: 'Importar' })) return;
  await DB.guardarProductos(ok);
  ok.forEach((p) => productos.set(p.codigo, p));
  renderProductos();
  toast(`Importados ${ok.length} producto(s)`);
}
function exportarProductos() {
  const lineas = ['codigo;nombre;precio;tipo', ...[...productos.values()].sort((a, b) => a.nombre.localeCompare(b.nombre))
    .map((p) => [p.codigo, p.nombre, numCSV(p.precio), p.tipo].map(csvCelda).join(';'))];
  descargar(`productos-${hoyISO()}.csv`, '﻿' + lineas.join('\r\n'), 'text/csv');
}

// ───────────── Caja (Historia 2.1, 2.2)
let ventasDia = [];
const MEDIOS = ['Efectivo', 'Débito', 'Crédito', 'Transferencia/QR'];
/** Totales del día a partir de sus ventas y su cambio inicial. */
function resumenDia(ventas, apertura) {
  const validas = ventas.filter((v) => !v.anulada);
  const anuladas = ventas.filter((v) => v.anulada);
  const total = r2(validas.reduce((a, v) => a + v.total, 0));
  const porMedio = {};
  MEDIOS.forEach((m) => (porMedio[m] = 0));
  validas.forEach((v) => (porMedio[v.medio] = r2((porMedio[v.medio] || 0) + v.total)));
  const inicial = apertura?.monto || 0;
  return {
    validas, anuladas, total, porMedio, inicial, hayApertura: !!apertura,
    enCaja: r2(inicial + (porMedio.Efectivo || 0)),
    totalAnuladas: r2(anuladas.reduce((a, v) => a + v.total, 0)),
  };
}

function rangoDia(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}
async function renderCaja() {
  const input = $('#caja-fecha');
  if (!input.value) input.value = hoyISO();
  ventasDia = (await DB.ventasEntre(...rangoDia(input.value))).sort((a, b) => b.fecha - a.fecha);
  const apertura = await DB.getApertura(input.value);
  const { validas, total, porMedio, inicial, enCaja } = resumenDia(ventasDia, apertura);
  $('#caja-resumen').innerHTML =
    `<div class="card main"><div class="lbl">Total del día</div><div class="val">${fmt(total)}</div></div>
     <div class="card"><div class="lbl">Ventas</div><div class="val">${validas.length}</div></div>
     <div class="card" id="card-cambio"><div class="lbl">Cambio inicial</div><div class="val">${apertura ? fmt(inicial) : '—'}</div>
       <button class="small ghost card-btn" id="btn-cambio">${apertura ? 'Modificar' : 'Cargar'}</button></div>
     <div class="card efectivo" id="card-en-caja"><div class="lbl">Efectivo que debe haber en caja</div><div class="val">${fmt(enCaja)}</div>
       <div class="muted small">Cambio inicial + ventas en efectivo</div></div>` +
    Object.entries(porMedio).map(([m, t]) => `<div class="card"><div class="lbl">${esc(m)}</div><div class="val">${fmt(t)}</div></div>`).join('');
  $('#caja-body').innerHTML = ventasDia.map((v) => `<tr class="click ${v.anulada ? 'anulada' : ''}" data-venta="${v.id}">
      <td>${v.id}</td><td>${hora(v.fecha)}</td>
      <td>${v.items.length} ${v.anulada ? '<span class="tag manual">ANULADA</span>' : ''}</td>
      <td>${esc(v.medio)}</td><td class="num"><strong>${fmt(v.total)}</strong></td>
      <td class="num"><button class="small secondary" data-ver="${v.id}">Ver</button> <button class="small ghost" data-ticket="${v.id}">Ticket</button>${v.anulada ? '' : ` <button class="small ghost" data-anular="${v.id}">Anular</button>`}</td>
    </tr>`).join('');
  $('#caja-vacio').classList.toggle('hidden', ventasDia.length > 0);
}
function toggleDetalle(tr) {
  const sig = tr.nextElementSibling;
  if (sig && sig.classList.contains('detalle')) { sig.remove(); return; }
  const v = ventasDia.find((x) => x.id === Number(tr.dataset.venta));
  if (!v) return;
  const det = document.createElement('tr');
  det.className = 'detalle';
  det.innerHTML = `<td></td><td colspan="5">${v.items.map((i) =>
    `<div>${esc(i.nombre)} — ${i.tipo === 'kg' ? fmtKg(i.cant) + ' kg' : fmtCant(i.cant)} × ${fmt(i.precio)} = <strong>${fmt(i.subtotal)}</strong></div>`).join('')}
    ${v.medio === 'Efectivo' ? `<div class="muted">Pagó con ${fmt(v.pagaCon)} · Vuelto ${fmt(v.vuelto)}</div>` : ''}
    ${v.vendedor ? `<div class="muted">Atendió: ${esc(v.vendedor)}</div>` : ''}</td>`;
  tr.after(det);
}
let ventaViendo = null;
function verVenta(id) {
  const v = ventasDia.find((x) => x.id === id);
  if (!v) return;
  ventaViendo = v;
  $('#venta-titulo').textContent = `Venta N° ${v.id}${v.anulada ? ' (anulada)' : ''}`;
  $('#venta-detalle').innerHTML = htmlTicket(v);
  abrirDialogo('#dlg-venta');
}
$('#btn-venta-ticket').addEventListener('click', () => { if (ventaViendo) imprimirTicket(ventaViendo); });

async function anularVenta(id) {
  const v = ventasDia.find((x) => x.id === id);
  if (!v || v.anulada) return;
  if (!await preguntar(`Venta N° ${id} por ${fmt(v.total)}. No se puede deshacer.`, { titulo: '¿Anular venta?', ok: 'Anular' })) return;
  v.anulada = true;
  v.anuladaEn = Date.now();
  await DB.guardarVenta(v);
  toast(`Venta N° ${id} anulada`);
  renderCaja();
}
/** Pregunta y guarda el cambio inicial de un día ('AAAA-MM-DD'). Devuelve true si se guardó. */
async function pedirCambioInicial(dia, actual = null) {
  const esHoy = dia === hoyISO();
  const [y, m, d] = dia.split('-');
  const r = await preguntar(
    esHoy ? '¿Con cuánta plata empieza hoy la caja para dar vuelto?' : `Cambio inicial del ${d}/${m}/${y}.`,
    { titulo: 'Cambio inicial de la caja', ok: 'Guardar', input: true, teclado: true, placeholder: actual != null ? String(actual).replace('.', ',') : 'Ej: 10000' });
  if (r == null) return false;
  const monto = r2(parseMonto(r));
  if (!(monto >= 0)) { toast('Monto inválido', 'error'); return false; }
  await DB.guardarApertura({ dia, monto, registrado: Date.now() });
  toast(`Cambio inicial: ${fmt(monto)}`);
  if (vista === 'caja') renderCaja();
  return true;
}

function exportarVentas() {
  if (!ventasDia.length) { toast('No hay ventas para exportar', 'error'); return; }
  const lineas = ['venta;fecha;hora;estado;medio;producto;cantidad;precio;subtotal;total venta'];
  [...ventasDia].reverse().forEach((v) => v.items.forEach((i) => lineas.push([
    v.id, new Date(v.fecha).toLocaleDateString('es-AR'), hora(v.fecha), v.anulada ? 'ANULADA' : 'OK', v.medio,
    i.nombre, numCSV(i.cant), numCSV(i.precio), numCSV(i.subtotal), numCSV(v.total),
  ].map(csvCelda).join(';'))));
  descargar(`ventas-${$('#caja-fecha').value}.csv`, '﻿' + lineas.join('\r\n'), 'text/csv');
}

// ───────────── Ajustes y backup (Historia 3.3)
function renderAjustes() {
  $('#cfg-negocio').value = config.negocio;
  $('#cfg-sonido').checked = !!config.sonido;
  $('#cfg-pedir-cambio').checked = config.pedirCambio !== false;
  $('#cfg-buscar-online').checked = config.buscarOnline !== false;
  $('#cfg-tablet').value = config.modoTablet || 'auto';
  $('#cfg-balanza').checked = config.balanza !== false;
  $('#cfg-balanza-plu').value = config.balanzaPlu || '5';
  $('#cfg-balanza-contenido').value = config.balanzaContenido || 'importe';
  $('#cfg-balanza-centavos').checked = !!config.balanzaCentavos;
  renderEjemploBalanza();
  renderVendedores();
  $('#cfg-direccion').value = config.direccion;
  $('#cfg-telefono').value = config.telefono;
  $('#cfg-pie').value = config.pie;
  $('#cfg-papel').value = config.papel;
  $('#cfg-imprimir').value = config.imprimir;
  renderPreviewTicket();
  if (ESCRITORIO) {
    cargarImpresoras();
    $('#cfg-modo-impresion').value = config.modoImpresion || 'texto';
    $('#cfg-codepage').value = config.codepage || 'pc850';
    $('#cfg-columnas').value = config.columnas || '';
    $('#cfg-margen').value = config.margen || '0';
  }
  $('#ultimo-backup').textContent = config.ultimoBackup
    ? `Última copia: ${new Date(config.ultimoBackup).toLocaleString('es-AR')}.` : 'Todavía no hiciste ninguna copia.';
}
async function cargarImpresoras() {
  const sel = $('#cfg-impresora');
  try {
    const lista = await window.escritorio.impresoras();
    sel.innerHTML = '<option value="">Predeterminada de Windows</option>' +
      lista.map((p) => `<option value="${esc(p.nombre)}">${esc(p.nombre)}${p.predeterminada ? ' (predeterminada)' : ''}</option>`).join('');
    if (config.impresora && !lista.some((p) => p.nombre === config.impresora)) {
      sel.insertAdjacentHTML('beforeend', `<option value="${esc(config.impresora)}">${esc(config.impresora)} (no conectada)</option>`);
    }
    sel.value = config.impresora || '';
  } catch { /* sin lista: queda la predeterminada */ }
}

function aplicarConfig() {
  $('#nombre-negocio').textContent = config.negocio;
  document.title = `${config.negocio} · Caja`;
  aplicarModoTablet();
}
function revisarAvisoBackup() {
  const vencido = !config.ultimoBackup || Date.now() - config.ultimoBackup > 7 * 864e5;
  $('#aviso-backup').classList.toggle('hidden', !(vencido && productos.size > 0));
}
async function datosBackup() {
  return {
    app: 'despensa-pos', version: 1, creado: new Date().toISOString(),
    config: {
      negocio: config.negocio, sonido: config.sonido, direccion: config.direccion, telefono: config.telefono,
      pie: config.pie, papel: config.papel, imprimir: config.imprimir, pedirCambio: config.pedirCambio,
      vendedores: config.vendedores || [], lectores: config.lectores || {},
      balanza: config.balanza, balanzaPlu: config.balanzaPlu, balanzaContenido: config.balanzaContenido, balanzaCentavos: config.balanzaCentavos,
    },
    aperturas: await DB.todos('aperturas'),
    productos: await DB.todos('productos'), ventas: await DB.todos('ventas'),
  };
}
async function hacerBackup() {
  const datos = await datosBackup();
  descargar(`despensa-backup-${hoyISO()}.json`, JSON.stringify(datos), 'application/json');
  config.ultimoBackup = Date.now();
  guardarConfig();
  revisarAvisoBackup();
  if (vista === 'ajustes') renderAjustes();
  toast('Copia descargada. Guardala en un pendrive o en tu correo.');
}
async function restaurarBackup(file) {
  let datos;
  try { datos = JSON.parse(await file.text()); } catch { toast('El archivo no es una copia válida', 'error'); return; }
  if (datos?.app !== 'despensa-pos' || !Array.isArray(datos.productos) || !Array.isArray(datos.ventas)) { toast('El archivo no es una copia de Despensa POS', 'error'); return; }
  if (!await preguntar(`La copia tiene ${datos.productos.length} productos y ${datos.ventas.length} ventas (${new Date(datos.creado).toLocaleString('es-AR')}).\nSe REEMPLAZARÁN todos los datos actuales.`, { titulo: '¿Restaurar copia?', ok: 'Restaurar' })) return;
  await DB.reemplazarTodo(datos.productos, datos.ventas, Array.isArray(datos.aperturas) ? datos.aperturas : []);
  productos.clear();
  datos.productos.forEach((p) => productos.set(p.codigo, p));
  if (datos.config) { Object.assign(config, datos.config); guardarConfig(); aplicarConfig(); }
  renderAjustes();
  revisarAvisoBackup();
  toast('Copia restaurada');
}

// ───────────── Modo tablet (Historia 7.1)
// Opcional: en el programa de Windows/Mac y en compus con mouse queda apagado salvo que se active en Ajustes.
let tablet = false;
const pantallaTactil = () => !ESCRITORIO && window.matchMedia('(pointer: coarse)').matches;
function aplicarModoTablet() {
  const modo = config.modoTablet || 'auto';
  const antes = tablet;
  tablet = modo === 'si' || (modo === 'auto' && pantallaTactil());
  document.documentElement.classList.toggle('tablet', tablet);
  const scan = $('#scan');
  scan.inputMode = tablet ? 'none' : 'text';
  scan.placeholder = tablet ? 'Escaneá el código, o tocá acá para buscar por nombre'
    : 'Escaneá el código o escribí el nombre del producto  ·  3* para cantidad';
  $$('[data-teclado]').forEach((el) => { if (el.id !== 'confirm-input') el.inputMode = tablet ? 'none' : 'decimal'; });
  if (tablet) mantenerPantallaEncendida();
  else if (bloqueoPantalla) { bloqueoPantalla.release().catch(() => {}); bloqueoPantalla = null; }
  hayCamaraLectora().then((ok) => $('#btn-camara').classList.toggle('hidden', !ok));
  if (antes !== tablet && document.body.dataset.listo) renderCarrito();
}

// Teclado numérico en pantalla para peso, precio, pago y cantidades
const TECLAS = ['1', '2', '3', '⌫', '4', '5', '6', 'C', '7', '8', '9', '00', ',', '0', '000'];
const NOMBRE_TECLA = { '⌫': 'Borrar', C: 'Borrar todo' };
function crearTeclado(despuesDe, objetivo, id) {
  const t = document.createElement('div');
  t.className = 'teclado solo-tablet';
  if (id) t.id = id;
  t.dataset.objetivo = objetivo;
  t.innerHTML = TECLAS.map((k) => `<button type="button" data-tecla="${k}"${k === '0' ? ' class="ancho"' : ''}${NOMBRE_TECLA[k] ? ` aria-label="${NOMBRE_TECLA[k]}"` : ''}>${k}</button>`).join('');
  $(despuesDe).after(t);
  return t;
}
crearTeclado('#peso-rapidos', '#peso-input');
crearTeclado('#form-manual .row', '#form-manual [name=precio]');
crearTeclado('#billetes', '#paga-con');
crearTeclado('#confirm-input', '#confirm-input', 'confirm-teclado');
// La tecla escribe en el último campo numérico tocado de esa ventana (ej: precio o cantidad en Artículo manual)
document.addEventListener('focusin', (e) => {
  if (!e.target.matches('[data-teclado]')) return;
  const t = e.target.closest('form')?.querySelector('.teclado');
  if (t) t.objetivo = e.target;
});
document.addEventListener('pointerdown', (e) => { if (e.target.closest('.teclado')) e.preventDefault(); }); // no saca el foco del campo
$$('.teclado').forEach((t) => t.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tecla]');
  if (!b) return;
  const inp = t.objetivo && t.objetivo.isConnected ? t.objetivo : $(t.dataset.objetivo);
  const k = b.dataset.tecla;
  if (k === '⌫') inp.value = inp.value.slice(0, -1);
  else if (k === 'C') inp.value = '';
  else if (k === ',') { if (!inp.value.includes(',')) inp.value += inp.value ? ',' : '0,'; }
  else inp.value += k;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
}));

// Campo de código: el teclado del sistema solo aparece si se toca el campo para buscar por nombre.
// El lector Bluetooth (modo teclado) escribe igual aunque no aparezca.
$('#scan').addEventListener('pointerdown', () => {
  if (!tablet || $('#scan').inputMode === 'text') return;
  if (document.activeElement === $('#scan')) $('#scan').blur();
  $('#scan').inputMode = 'text';
});
$('#scan').addEventListener('blur', () => { if (tablet) $('#scan').inputMode = 'none'; });
function cerrarTecladoScan() {
  if (tablet && $('#scan').inputMode === 'text' && document.activeElement === $('#scan')) $('#scan').blur();
}

// Carrito: botones − / + y peso con teclado en pantalla
function celdaCantTablet(it) {
  if (it.tipo === 'kg') return `<button type="button" class="cant-btn" data-peso="${it.id}" aria-label="Cambiar peso">${fmtKg(it.cant)} kg</button>`;
  return `<span class="paso"><button type="button" data-menos="${it.id}" aria-label="Uno menos"${it.cant <= 1 ? ' disabled' : ''}>−</button>` +
    `<span class="cant-num">${fmtCant(it.cant)}</span><button type="button" data-mas="${it.id}" aria-label="Uno más">+</button></span>`;
}
async function pasoCantidad(b) {
  const it = carrito.find((i) => i.id === Number(b.dataset.menos || b.dataset.mas || b.dataset.peso));
  if (!it) return;
  if (b.dataset.mas) it.cant = r3(it.cant + 1);
  else if (b.dataset.menos) { if (it.cant > 1) it.cant = r3(it.cant - 1); }
  else {
    const r = await preguntar(`${it.nombre} · ${fmt(it.precio)} por kg`, { titulo: 'Cambiar peso', ok: 'Guardar', input: true, teclado: true, placeholder: 'Gramos, ej: 350' });
    if (r == null) return;
    const p = parsePeso(r, it.precio);
    if (!p || !(p.cant > 0)) { beep(false); toast('Peso inválido', 'error'); return; }
    it.cant = p.cant;
    delete it.subtotal;
  }
  ultimoAgregado = it.id;
  renderCarrito();
}

// × Cantidad: reemplaza al atajo 3* del teclado
$('#btn-cantidad').addEventListener('click', async () => {
  const r = await preguntar('Elegí la cantidad y después escaneá o buscá el producto.', { titulo: '¿Cuántas unidades?', ok: 'Listo', input: true, teclado: true, placeholder: 'Ej: 3' });
  const n = Number(String(r ?? '').replace(',', '.'));
  if (!(n > 0)) return;
  ocultarSugerencias();
  $('#scan').value = `${fmtCant(n)}*`;
  toast(`El próximo producto se suma × ${fmtCant(n)}`);
});
$('#peso-rapidos').addEventListener('click', (e) => {
  const b = e.target.closest('[data-gramos]');
  if (!b) return;
  $('#form-peso').modo.value = 'peso';
  $('#peso-input').value = b.dataset.gramos;
  actualizarPreviewPeso();
});
$('#manual-descs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-desc]');
  if (!b) return;
  $('#form-manual').desc.value = b.dataset.desc;
  $$('#manual-descs [data-desc]').forEach((x) => x.classList.toggle('elegido', x === b));
});

// Escanear con la cámara (Historia 7.2): usa el lector de códigos que trae Chrome en Android.
// Donde no existe (por ejemplo Chrome en Windows) el botón no aparece.
const FORMATOS_CAMARA = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar'];
let formatosCamara = null;
async function hayCamaraLectora() {
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) return false;
  try {
    const soportados = await window.BarcodeDetector.getSupportedFormats();
    formatosCamara = FORMATOS_CAMARA.filter((f) => soportados.includes(f));
    return formatosCamara.length > 0;
  } catch { return false; }
}
let camara = null; // { stream, detector, timer, ultimo, t }
const estadoCamara = (txt, ok = false) => { const el = $('#camara-estado'); el.textContent = txt; el.classList.toggle('ok', ok); };
async function abrirCamara() {
  if (!(await hayCamaraLectora())) { toast('Esta tablet no puede leer códigos con la cámara. Usá el lector.', 'error'); return; }
  const dlg = abrirDialogo('#dlg-camara');
  estadoCamara('Apuntá la cámara al código de barras.');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
  } catch {
    estadoCamara('No se pudo abrir la cámara. Revisá que Chrome tenga permiso para usarla en esta página.');
    return;
  }
  if (!dlg.open) { stream.getTracks().forEach((t) => t.stop()); return; }
  const video = $('#camara-video');
  video.srcObject = stream;
  try { await video.play(); } catch { /* se reintenta al detectar */ }
  camara = { stream, detector: new window.BarcodeDetector({ formats: formatosCamara }), timer: null, ultimo: '', t: 0 };
  buscarEnCamara();
}
async function buscarEnCamara() {
  const c = camara;
  if (!c) return;
  try {
    const r = await c.detector.detect($('#camara-video'));
    const codigo = r.map((x) => String(x.rawValue || '').trim()).find(Boolean);
    if (codigo && camara === c) leidoPorCamara(codigo);
  } catch { /* cuadro sin imagen todavía */ }
  if (camara === c) c.timer = setTimeout(buscarEnCamara, 150);
}
function leidoPorCamara(codigo) {
  const ahora = Date.now();
  if (codigo === camara.ultimo && ahora - camara.t < 2000) return; // el mismo código sigue frente a la cámara
  camara.ultimo = codigo;
  camara.t = ahora;
  const prev = $('#scan').value.trim();
  const prefijo = /^\d+(?:[.,]\d+)?\s*\*$/.test(prev) ? prev : ''; // × Cantidad elegida antes
  if (itemDirecto(codigo)) {
    // Producto común: se suma y la cámara sigue abierta para el próximo
    procesarEntrada(prefijo + codigo);
    const it = carrito.find((i) => i.id === ultimoAgregado);
    estadoCamara(`✓ ${it ? it.nombre : codigo} · Total ${fmt(totalCarrito())}`, true);
    return;
  }
  // Necesita un dato (peso, precio o alta): se cierra la cámara y sigue como con el lector
  $('#dlg-camara').close();
  procesarEntrada(prefijo + codigo);
}
function pararCamara() {
  if (!camara) return;
  clearTimeout(camara.timer);
  camara.stream.getTracks().forEach((t) => t.stop());
  $('#camara-video').srcObject = null;
  camara = null;
}
$('#dlg-camara').addEventListener('close', pararCamara);
$('#btn-camara').addEventListener('click', abrirCamara);

// Pantalla siempre encendida mientras la caja está abierta
let bloqueoPantalla = null;
async function mantenerPantallaEncendida() {
  if (!tablet || bloqueoPantalla || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
  try {
    bloqueoPantalla = await navigator.wakeLock.request('screen');
    bloqueoPantalla.addEventListener('release', () => { bloqueoPantalla = null; });
  } catch { /* no disponible: la pantalla se apaga sola como siempre */ }
}
document.addEventListener('visibilitychange', mantenerPantallaEncendida);

// ───────────── Eventos
$$('.topbar nav button').forEach((b) => b.addEventListener('click', () => mostrar(b.dataset.view)));

$('#scan-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (sugeridos.length && selSug >= 0) {
    const { cant } = parseCantidad($('#scan').value.trim());
    agregarProducto(sugeridos[selSug], cant);
  } else procesarEntrada($('#scan').value);
});
let timerSug;
$('#scan').addEventListener('input', () => {
  clearTimeout(timerSug);
  const v = $('#scan').value.trim();
  const { resto } = parseCantidad(v);
  // Solo sugerir texto (no códigos numéricos, que llegan rápido desde el lector)
  if (resto.length < 2 || /^\d+$/.test(resto)) { ocultarSugerencias(); return; }
  timerSug = setTimeout(() => mostrarSugerencias(buscarProductos(resto)), 120);
});
$('#scan').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moverSugerencia(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moverSugerencia(-1); }
});
$('#sugerencias').addEventListener('mousedown', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  e.preventDefault();
  agregarProducto(sugeridos[Number(li.dataset.i)], parseCantidad($('#scan').value.trim()).cant);
});

$('#carrito-body').addEventListener('click', (e) => {
  const q = e.target.closest('[data-quitar]');
  if (q) { setCarrito(carrito.filter((i) => i.id !== Number(q.dataset.quitar))); renderCarrito(); focusScan(); return; }
  const b = e.target.closest('[data-menos], [data-mas], [data-peso]');
  if (b) pasoCantidad(b);
});
$('#carrito-body').addEventListener('change', (e) => {
  if (e.target.matches('.cant')) cambiarCantidad(Number(e.target.dataset.id), e.target.value);
});
$('#carrito-body').addEventListener('keydown', (e) => {
  if (e.target.matches('.cant') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
});

$('#pestanas').addEventListener('click', (e) => {
  const b = e.target.closest('[data-vendedor]');
  if (b) cambiarVendedor(b.dataset.vendedor);
});
function renderVendedores() {
  renderEstadoLectoresCom();
  const m = config.lectores || {};
  const com = config.lectoresComActivo && ESCRITORIO_LECTORES() ? (config.lectoresCom || {}) : null;
  const lectorCom = (n) => !com ? '' : asignandoCom === n
    ? `<button type="button" class="small secondary esperando" data-asignar-com="${esc(n)}">Escaneá con su lector…</button>`
    : com[n] ? `<button type="button" class="small ghost" data-quitar-com="${esc(n)}" title="Quitar el lector de ${esc(n)}">${esc(nombrePuerto(com[n]))} ✕</button>`
      : `<button type="button" class="small ghost" data-asignar-com="${esc(n)}">Asignar lector</button>`;
  const lector = (n) => `<select class="lector" data-lector="${esc(n)}" aria-label="Lector de ${esc(n)}" title="Letra que manda el lector de ${esc(n)}">` +
    `<option value="">Sin lector</option>${LETRAS_LECTOR.map((l) => `<option value="${l}"${m[n] === l ? ' selected' : ''}>Lector ${l}</option>`).join('')}</select>`;
  $('#lista-vendedores').innerHTML = vendedores().map((n) => n === INVITADO
    ? `<span class="chip fijo">${INVITADO}${lector(n)}${lectorCom(n)}</span>`
    : `<span class="chip">${esc(n)}${lector(n)}${lectorCom(n)}<button type="button" data-quitar-vendedor="${esc(n)}" aria-label="Quitar ${esc(n)}">✕</button></span>`).join('');
}
$('#lista-vendedores').addEventListener('change', (e) => {
  const sel = e.target.closest('[data-lector]');
  if (!sel) return;
  const nombre = sel.dataset.lector;
  const letra = sel.value;
  const m = { ...(config.lectores || {}) };
  for (const n of Object.keys(m)) if (m[n] === letra || !vendedores().includes(n)) delete m[n];
  if (letra) m[nombre] = letra;
  config.lectores = m;
  guardarConfig();
  renderVendedores();
  renderPestanas();
  toast(letra ? `El lector ${letra} es de ${nombre}` : `${nombre} sin lector propio`);
});
// ───────────── Lectores en modo USB COM (Historia 6.3)
// El lector en modo COM no escribe como teclado: el programa de escritorio lee su puerto y avisa de qué puerto vino.
const ESCRITORIO_LECTORES = () => !!(window.escritorio && window.escritorio.lectoresCom);
let asignandoCom = null;
let puertosCom = [];
let escuchandoCom = false;
const nombrePuerto = (id) => (puertosCom.find((p) => p.id === id) || {}).nombre || String(id).replace(/^\/dev\/(cu|tty)\./, '');
function renderEstadoLectoresCom() {
  const wrap = $('#lectores-com-wrap');
  wrap.classList.toggle('hidden', !ESCRITORIO_LECTORES());
  $('#cfg-lectores-com').checked = !!config.lectoresComActivo;
  const e = $('#lectores-com-estado');
  e.textContent = !config.lectoresComActivo ? ''
    : puertosCom.length ? `Lectores COM conectados: ${puertosCom.map((p) => p.nombre).join(', ')}`
      : 'No hay lectores en modo COM conectados.';
}
async function activarLectoresCom(si) {
  if (!ESCRITORIO_LECTORES()) return;
  if (!escuchandoCom) {
    escuchandoCom = true;
    window.escritorio.alLectorCom(codigoDeLectorCom);
    if (window.escritorio.alCambiarLectoresCom) window.escritorio.alCambiarLectoresCom((lista) => { puertosCom = lista || []; renderVendedores(); });
  }
  try { puertosCom = (await window.escritorio.lectoresCom(!!si)) || []; } catch { puertosCom = []; }
  if (!si) asignandoCom = null;
  renderVendedores();
}
function asignarLectorCom(nombre, id) {
  const m = { ...(config.lectoresCom || {}) };
  for (const n of Object.keys(m)) if (m[n] === id || !vendedores().includes(n)) delete m[n];
  m[nombre] = id;
  config.lectoresCom = m;
  guardarConfig();
  asignandoCom = null;
  beep();
  renderVendedores();
  renderPestanas();
  toast(`${nombrePuerto(id)} es el lector de ${nombre}`);
}
/** Un código llegó por un lector COM: va a la pestaña de su vendedor (o al campo donde se está escribiendo). */
function codigoDeLectorCom({ id, codigo } = {}) {
  codigo = String(codigo || '').trim();
  if (!codigo || !config.lectoresComActivo) return;
  if (asignandoCom) { asignarLectorCom(asignandoCom, id); return; }
  const m = config.lectoresCom || {};
  const nombre = vendedores().find((n) => m[n] === id) || null;
  const el = document.activeElement;
  const campo = el && el !== $('#scan') && el.matches && el.matches('input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea');
  // Escribiendo en un campo (código del producto, buscador, peso…) con el lector propio o uno sin asignar: se escribe ahí
  if (campo && (!nombre || nombre === vendedorActivo)) {
    el.value = codigo;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return;
  }
  escaneoDeLector(nombre || vendedorActivo, codigo);
}
$('#cfg-lectores-com').addEventListener('change', (e) => {
  config.lectoresComActivo = e.target.checked;
  guardarConfig();
  activarLectoresCom(config.lectoresComActivo);
  renderPestanas();
});
$('#lista-vendedores').addEventListener('click', (e) => {
  const a = e.target.closest('[data-asignar-com]');
  if (a) {
    const n = a.dataset.asignarCom;
    asignandoCom = asignandoCom === n ? null : n;
    renderVendedores();
    if (asignandoCom) toast(`Escaneá cualquier producto con el lector de ${n}`);
    return;
  }
  const q = e.target.closest('[data-quitar-com]');
  if (q) {
    const m = { ...(config.lectoresCom || {}) };
    delete m[q.dataset.quitarCom];
    config.lectoresCom = m;
    guardarConfig();
    renderVendedores();
    renderPestanas();
  }
});

function agregarVendedor() {
  const inp = $('#nuevo-vendedor');
  const nombre = inp.value.trim().replace(/\s+/g, ' ');
  if (!nombre) { inp.focus(); return; }
  if (vendedores().some((n) => n.toLowerCase() === nombre.toLowerCase())) { toast(`“${nombre}” ya está en la lista`, 'error'); return; }
  if (vendedores().length >= 9) { toast('Máximo 8 vendedores más Invitado', 'error'); return; }
  config.vendedores = [...(config.vendedores || []), nombre];
  guardarConfig();
  inp.value = '';
  renderVendedores();
  renderPestanas();
  toast(`Vendedor agregado: ${nombre}`);
}
$('#btn-agregar-vendedor').addEventListener('click', agregarVendedor);
$('#nuevo-vendedor').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); agregarVendedor(); } });
$('#lista-vendedores').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-quitar-vendedor]');
  if (!b) return;
  const nombre = b.dataset.quitarVendedor;
  const abiertos = (carritos[nombre] || []).length;
  if (!await preguntar(abiertos ? `${nombre} tiene una venta en curso con ${abiertos} artículo(s) que se va a descartar.` : `Se quita la pestaña de ${nombre}. Sus ventas registradas no se borran.`,
    { titulo: `¿Quitar a ${nombre}?`, ok: 'Quitar' })) return;
  config.vendedores = (config.vendedores || []).filter((n) => n !== nombre);
  if (config.lectores) delete config.lectores[nombre];
  if (config.lectoresCom) delete config.lectoresCom[nombre];
  guardarConfig();
  delete carritos[nombre];
  if (vendedorActivo === nombre) { vendedorActivo = INVITADO; setCarrito(carritos[INVITADO] || []); }
  renderVendedores();
  renderCarrito();
});

$('#btn-manual').addEventListener('click', abrirManual);
$('#btn-cobrar').addEventListener('click', abrirCobro);
$('#btn-cancelar').addEventListener('click', cancelarVenta);

$('#prod-buscar').addEventListener('input', renderProductos);
$('#prod-sin-precio').addEventListener('change', renderProductos);
$('#btn-nuevo-prod').addEventListener('click', () => abrirFormProducto());
$('#btn-aumento').addEventListener('click', aumentarPrecios);
$('#btn-export-prod').addEventListener('click', exportarProductos);
$('#file-csv').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await importarCSV(f); });
$('#prod-body').addEventListener('change', (e) => {
  const cb = e.target.closest('[data-sel]');
  if (!cb) return;
  if (cb.checked) seleccion.add(cb.dataset.sel); else seleccion.delete(cb.dataset.sel);
  cb.closest('tr').classList.toggle('seleccionado', cb.checked);
  renderProductos();
});
$('#sel-todos').addEventListener('change', (e) => {
  productosFiltrados().slice(0, 500).forEach((p) => (e.target.checked ? seleccion.add(p.codigo) : seleccion.delete(p.codigo)));
  renderProductos();
});
$('#sel-info').addEventListener('click', (e) => {
  if (e.target.closest('#btn-sel-limpiar')) { seleccion.clear(); renderProductos(); }
  if (e.target.closest('#btn-sel-eliminar')) eliminarSeleccionados();
});
$('#btn-vaciar-productos').addEventListener('click', vaciarProductos);
$('#prod-body').addEventListener('click', (e) => {
  const ed = e.target.closest('[data-editar]');
  if (ed) { abrirFormProducto(productos.get(ed.dataset.editar)); return; }
  const bo = e.target.closest('[data-borrar]');
  if (bo) borrarProducto(bo.dataset.borrar);
});

$('#caja-fecha').addEventListener('change', renderCaja);
$('#caja-resumen').addEventListener('click', async (e) => {
  if (!e.target.closest('#btn-cambio')) return;
  const dia = $('#caja-fecha').value;
  const ap = await DB.getApertura(dia);
  pedirCambioInicial(dia, ap?.monto ?? null);
});
$('#btn-export-ventas').addEventListener('click', exportarVentas);
$('#btn-imprimir-caja').addEventListener('click', imprimirCaja);
$('#caja-body').addEventListener('click', (e) => {
  const tk = e.target.closest('[data-ticket]');
  if (tk) {
    e.stopPropagation();
    const v = ventasDia.find((x) => x.id === Number(tk.dataset.ticket));
    if (v) imprimirTicket(v);
    return;
  }
  const ver = e.target.closest('[data-ver]');
  if (ver) { e.stopPropagation(); verVenta(Number(ver.dataset.ver)); return; }
  const an = e.target.closest('[data-anular]');
  if (an) { e.stopPropagation(); anularVenta(Number(an.dataset.anular)); return; }
  const tr = e.target.closest('tr[data-venta]');
  if (tr) toggleDetalle(tr);
});

function guardarAjustes() {
  config = configFormulario();
  guardarConfig();
  aplicarConfig();
  toast('Ajustes guardados');
}
$('#btn-guardar-cfg').addEventListener('click', guardarAjustes);
$('#btn-guardar-cfg2').addEventListener('click', guardarAjustes);
$$('#v-ajustes input, #v-ajustes select').forEach((el) => el.addEventListener('input', renderPreviewTicket));
$('#btn-ticket-prueba').addEventListener('click', () => imprimirTicket(ventaDePrueba(), configFormulario()));
$('#ultima-venta').addEventListener('click', (e) => {
  if (e.target.closest('#btn-ticket-ultima') && ultimaVenta) imprimirTicket(ultimaVenta);
});
$('#btn-backup').addEventListener('click', hacerBackup);
$('#btn-aviso-backup').addEventListener('click', hacerBackup);
$('#file-backup').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await restaurarBackup(f); });

// Atajos globales y redirección de teclas al campo de escaneo
const esCampo = (el) => el && (el.matches('input, textarea, select') || el.isContentEditable);
document.addEventListener('keydown', (e) => {
  if (e.key === 'F1') { e.preventDefault(); if (!dialogoAbierto()) mostrar('venta'); return; }
  if (dialogoAbierto() || vista !== 'venta') return;
  if (e.key === 'F2') { e.preventDefault(); focusScan(); }
  else if (e.key === 'F3') { e.preventDefault(); abrirManual(); }
  else if (e.key === 'F4') { e.preventDefault(); abrirCobro(); }
  else if (/^F[6-9]$/.test(e.key)) { e.preventDefault(); const n = vendedores()[Number(e.key.slice(1)) - 6]; if (n) cambiarVendedor(n); }
  else if (e.key === 'Escape') {
    if (sugeridos.length) { ocultarSugerencias(); return; }
    e.preventDefault();
    cancelarVenta();
  } else if (!esCampo(e.target) && !e.ctrlKey && !e.altKey && !e.metaKey) {
    const scan = $('#scan');
    if (e.key.length === 1) { e.preventDefault(); scan.value += e.key; scan.focus(); scan.dispatchEvent(new Event('input')); }
    else if (e.key === 'Enter' && scan.value) { e.preventDefault(); $('#scan-form').requestSubmit(); }
  }
});

// Instalación PWA
let eventoInstalar = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  eventoInstalar = e;
  $('#btn-instalar').classList.remove('hidden');
});
$('#btn-instalar').addEventListener('click', async () => {
  if (!eventoInstalar) return;
  eventoInstalar.prompt();
  await eventoInstalar.userChoice;
  eventoInstalar = null;
  $('#btn-instalar').classList.add('hidden');
});

// ───────────── Programa de escritorio (Historias 5.1 y 5.2)
async function iniciarEscritorio() {
  if (config.lectoresComActivo) activarLectoresCom(true);
  $('#cfg-impresora-wrap').classList.remove('hidden');
  $('#cfg-modo-wrap').classList.remove('hidden');
  $('#cfg-ajuste-wrap').classList.remove('hidden');
  $('#cfg-ajuste-ayuda').classList.remove('hidden');
  $('#seccion-instalacion').classList.add('hidden');
  try { $('#version-app').textContent = `Despensa POS versión ${await window.escritorio.version()}`; } catch { /* sin versión */ }
  let urlDescarga = null;
  window.escritorio.alActualizar(async (evento, datos) => {
    if (evento === 'manual') {
      // Mac: hay versión nueva para descargar e instalar encima
      urlDescarga = datos.url;
      $('#aviso-actualizacion-texto').textContent = `Hay una versión nueva (${datos.version}). Descargala e instalala encima: tus datos se conservan.`;
      $('#btn-actualizar-ahora').textContent = 'Descargar versión nueva';
      $('#aviso-actualizacion').classList.remove('hidden');
      return;
    }
    if (evento !== 'lista') return;
    // Copia de seguridad automática antes de instalar la versión nueva
    try { await window.escritorio.guardarBackup(JSON.stringify(await datosBackup()), `antes-de-v${datos.version}`); } catch { /* seguir igual */ }
    $('#aviso-actualizacion-texto').textContent = `Hay una versión nueva (${datos.version}). Se instala sola al cerrar el programa.`;
    $('#aviso-actualizacion').classList.remove('hidden');
  });
  $('#btn-actualizar-ahora').addEventListener('click', async () => {
    if (urlDescarga) {
      try { await window.escritorio.guardarBackup(JSON.stringify(await datosBackup()), 'antes-de-descargar'); } catch { /* seguir */ }
      window.escritorio.abrirDescarga(urlDescarga);
      return;
    }
    if (hayVentasAbiertas() && !await preguntar('Hay ventas en curso. Quedan guardadas, pero conviene terminarlas antes.', { titulo: '¿Reiniciar?', ok: 'Reiniciar igual' })) return;
    window.escritorio.reiniciarYActualizar();
  });
}

// ───────────── Inicio (Historia 1.1)
async function iniciar() {
  $('#fecha-hoy').textContent = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  aplicarConfig();
  try {
    await DB.abrir();
    (await DB.todos('productos')).forEach((p) => productos.set(p.codigo, p));
  } catch (err) {
    document.body.insertAdjacentHTML('afterbegin', `<div class="aviso">No se pudo abrir la base de datos local: ${esc(err.message)}</div>`);
    return;
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (ESCRITORIO) iniciarEscritorio();
  cargarCarritos();
  renderCarrito();
  revisarAvisoBackup();
  focusScan();
  document.body.dataset.listo = '1';
  if (config.pedirCambio !== false && !(await DB.getApertura(hoyISO()))) pedirCambioInicial(hoyISO());
}
iniciar();
