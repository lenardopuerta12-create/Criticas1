const { put, head } = require("@vercel/blob");
const XLSX = require("xlsx");
const Busboy = require("busboy");
const crypto = require("crypto");

// ============================================================
// CONFIGURACIÓN
// ============================================================
const ADMIN_PASSWORD = "actualizar123";
const SECRET = "criticas-analista-cambia-esta-cadena-larga-2026-xk92";
const COOKIE_NAME = "criticas_session";

const RUTAS = {
  agentes: "data/agentes.xlsx",
  horas: "data/horas.xlsx",
  metas: "data/metas.xlsx",
};

// ============================================================
// SESIÓN (token firmado, sin librerías externas)
// ============================================================
function firmar(valor) {
  return crypto.createHmac("sha256", SECRET).update(valor).digest("hex");
}

function crearToken() {
  const exp = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return payload + "." + firmar(payload);
}

function verificarToken(token) {
  if (!token) return false;
  const partes = token.split(".");
  if (partes.length !== 2) return false;
  const [payload, firma] = partes;
  if (firmar(payload) !== firma) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return data.exp > Date.now();
  } catch {
    return false;
  }
}

function leerCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function estaAutenticado(req) {
  const cookies = leerCookies(req);
  return verificarToken(cookies[COOKIE_NAME]);
}

// ============================================================
// LECTURA DE EXCEL
// ============================================================
function leerFilas(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const hoja = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(hoja, { defval: null, raw: true });
}

function normStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function normNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (v === null || v === undefined || v === "") return 0;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function validarColumnas(cols, requeridas) {
  const set = new Set(cols);
  const faltan = requeridas.filter((c) => !set.has(c));
  if (faltan.length) throw new Error("Faltan las columnas: " + faltan.join(", "));
}

function parseAgentes(buffer) {
  const filas = leerFilas(buffer);
  if (!filas.length) throw new Error("El archivo está vacío");
  validarColumnas(Object.keys(filas[0]), ["ANALISTA", "CANTIDAD"]);
  return filas.map((r) => ({ ANALISTA: normStr(r.ANALISTA), CANTIDAD: normNum(r.CANTIDAD) }));
}

function parseHoras(buffer) {
  const filas = leerFilas(buffer);
  if (!filas.length) throw new Error("El archivo está vacío");
  validarColumnas(Object.keys(filas[0]), ["ANALISTA", "RANGO_HORA", "ORDEN_HORA", "CANTIDAD"]);
  return filas.map((r) => ({
    ANALISTA: normStr(r.ANALISTA),
    RANGO_HORA: normStr(r.RANGO_HORA),
    ORDEN_HORA: normNum(r.ORDEN_HORA),
    CANTIDAD: normNum(r.CANTIDAD),
  }));
}

const COLUMNAS_METAS_EXTRA = [
  "TOTAL_CRITICAS",
  "META_MENSUAL",
  "MES",
  "DIAS_TRABAJADOS",
  "PROMEDIO_DIARIO",
  "DIFERENCIA_META",
];

function parseMetas(buffer) {
  const filas = leerFilas(buffer);
  if (!filas.length) throw new Error("El archivo está vacío");
  const cols = Object.keys(filas[0]);
  validarColumnas(cols, ["ANALISTA", "PORCENTAJE_CUMPLIMIENTO", "CUMPLIMIENTO"]);
  const set = new Set(cols);
  return filas.map((r) => {
    const out = {
      ANALISTA: normStr(r.ANALISTA),
      PORCENTAJE_CUMPLIMIENTO: normNum(r.PORCENTAJE_CUMPLIMIENTO),
      CUMPLIMIENTO: normStr(r.CUMPLIMIENTO),
    };
    for (const extra of COLUMNAS_METAS_EXTRA) {
      if (set.has(extra)) {
        out[extra] = extra === "TOTAL_CRITICAS" ? normNum(r[extra]) : normStr(r[extra]);
      }
    }
    return out;
  });
}

const PARSERS = { agentes: parseAgentes, horas: parseHoras, metas: parseMetas };

async function leerTipo(tipo) {
  try {
    const info = await head(RUTAS[tipo]);
    const res = await fetch(info.url);
    if (!res.ok) throw new Error("fetch status " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    return { data: PARSERS[tipo](buf), actualizado: info.uploadedAt, error: null };
  } catch (e) {
    return { data: null, actualizado: null, error: "DEBUG: " + (e && e.message ? e.message : String(e)) };
  }
}

// ============================================================
// SUBIDA DE ARCHIVOS (multipart)
// ============================================================
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 15 * 1024 * 1024 } });
    const result = { fields: {}, file: null };
    bb.on("field", (name, val) => {
      result.fields[name] = val;
    });
    bb.on("file", (_name, stream) => {
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => {
        result.file = Buffer.concat(chunks);
      });
    });
    bb.on("finish", () => resolve(result));
    bb.on("error", reject);
    req.pipe(bb);
  });
}

async function leerCuerpoJSON(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    return JSON.parse(body || "{}");
  } catch {
    return {};
  }
}

// ============================================================
// PÁGINA (HTML + CSS + JS del cliente, todo en un string)
// ============================================================
function paginaHTML() {
  return (
    "<!DOCTYPE html>" +
    '<html lang="es"><head>' +
    '<meta charset="UTF-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />' +
    "<title>CRITICAS_ANALISTA</title>" +
    "<style>" +
    CSS +
    "</style></head><body>" +
    '<div class="barra-superior">' +
    "<h1>CRITICAS_ANALISTA</h1>" +
    '<div class="acciones">' +
    '<button class="btn" onclick="cargarDatos()">Actualizar</button>' +
    "</div></div>" +
    '<div class="estado" id="estado"></div>' +
    '<div class="contenido">' +
    '<div class="tabs">' +
    '<button class="tab activo" data-tab="analistas" onclick="cambiarTab(this)">Críticas por analista</button>' +
    '<button class="tab" data-tab="metas" onclick="cambiarTab(this)">Cumplimiento de metas</button>' +
    '<button class="tab" data-tab="detalle" onclick="cambiarTab(this)">Detalle de metas</button>' +
    '<button class="tab" data-tab="admin" onclick="cambiarTab(this)">Admin</button>' +
    "</div>" +
    '<div id="vista-analistas" class="vista"></div>' +
    '<div id="vista-metas" class="vista oculto"></div>' +
    '<div id="vista-detalle" class="vista oculto"></div>' +
    '<div id="vista-admin" class="vista oculto"></div>' +
    "</div>" +
    "<script>" +
    JS_CLIENTE +
    "</script>" +
    "</body></html>"
  );
}

const CSS =
  ":root{--azul:#0068c9;--naranja:#ff8c00;--verde:#2ecc71;--rojo:#e74c3c;--gris:#555;--borde:#e2e2e2;}" +
  "*{box-sizing:border-box;}" +
  "body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f7f8fa;color:#1a1a1a;" +
  "padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);}" +
  ".barra-superior{position:sticky;top:0;z-index:10;background:#fff;border-bottom:1px solid var(--borde);" +
  "padding:12px 16px;padding-top:calc(12px + env(safe-area-inset-top,0px));display:flex;align-items:center;justify-content:space-between;gap:8px;}" +
  ".barra-superior h1{font-size:17px;margin:0;}" +
  ".btn{border:1px solid var(--borde);background:#fff;border-radius:8px;padding:8px 12px;font-size:14px;cursor:pointer;}" +
  ".estado{font-size:12px;color:var(--gris);padding:4px 16px 8px;}" +
  ".contenido{padding:12px;max-width:900px;margin:0 auto;}" +
  ".tabs{display:flex;overflow-x:auto;gap:4px;margin-bottom:12px;}" +
  ".tab{flex:none;padding:10px 14px;border-radius:999px;border:1px solid var(--borde);background:#fff;font-size:13px;cursor:pointer;white-space:nowrap;}" +
  ".tab.activo{background:var(--azul);color:#fff;border-color:var(--azul);}" +
  ".oculto{display:none;}" +
  ".tarjeta{background:#fff;border:1px solid var(--borde);border-radius:12px;padding:14px;margin-bottom:12px;}" +
  ".metricas{display:flex;flex-wrap:wrap;gap:20px;margin-bottom:12px;}" +
  ".metrica-titulo{font-size:11px;color:var(--gris);text-transform:uppercase;letter-spacing:.03em;}" +
  ".metrica-valor{font-size:24px;font-weight:700;}" +
  ".ayuda{font-size:12px;color:var(--gris);margin:0 0 8px;}" +
  ".error{color:var(--rojo);font-size:13px;margin-top:6px;}" +
  ".aviso{background:#fff7e6;border:1px solid #ffe0a3;color:#7a5200;font-size:12px;border-radius:8px;padding:8px 10px;margin-bottom:10px;}" +
  ".fila-barra{display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer;}" +
  ".fila-barra .nombre{width:100px;font-size:11px;flex:none;text-align:right;color:#333;}" +
  ".fila-barra .pista{flex:1;background:#eef1f4;border-radius:6px;height:22px;position:relative;overflow:hidden;}" +
  ".fila-barra .relleno{height:100%;background:var(--azul);border-radius:6px;display:flex;align-items:center;min-width:2px;}" +
  ".fila-barra.sel .relleno{background:var(--naranja);}" +
  ".fila-barra .valor{font-size:11px;color:#fff;margin-left:6px;font-weight:600;white-space:nowrap;}" +
  ".barra-h{display:flex;align-items:flex-end;gap:6px;height:160px;padding:10px 0 0;}" +
  ".barra-h .col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;}" +
  ".barra-h .col .num{font-size:10px;margin-bottom:3px;color:#333;}" +
  ".barra-h .col .rect{width:60%;background:var(--naranja);border-radius:4px 4px 0 0;min-height:2px;}" +
  ".barra-h .col .hora{font-size:9px;color:var(--gris);margin-top:4px;white-space:nowrap;transform:rotate(-35deg);}" +
  ".meta-fila{display:flex;align-items:center;gap:8px;margin-bottom:10px;}" +
  ".meta-fila .nombre{width:100px;font-size:11px;flex:none;text-align:right;}" +
  ".meta-fila .pista{flex:1;background:#eef1f4;border-radius:6px;height:22px;position:relative;}" +
  ".meta-fila .relleno{height:100%;border-radius:6px;min-width:2px;}" +
  ".meta-fila .relleno.cumple{background:var(--verde);}" +
  ".meta-fila .relleno.nocumple{background:var(--rojo);}" +
  ".meta-fila .valor{font-size:11px;margin-left:6px;color:#444;white-space:nowrap;}" +
  ".linea-meta{position:absolute;top:-3px;bottom:-3px;width:2px;background:#999;left:66.6%;}" +
  "table{width:100%;border-collapse:collapse;font-size:13px;}" +
  "th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--borde);white-space:nowrap;}" +
  ".tabla-scroll{overflow-x:auto;}" +
  ".fila-cumple{background:#e6f7ec;}" +
  ".fila-nocumple{background:#fdeaea;}" +
  ".badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;background:#eef2f7;color:#444;}" +
  ".login-caja{max-width:300px;}" +
  ".login-caja input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--borde);font-size:16px;margin-bottom:10px;}" +
  ".login-caja button{width:100%;padding:10px 12px;border-radius:8px;border:none;background:var(--azul);color:#fff;font-size:15px;cursor:pointer;}" +
  ".subida-fila{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-bottom:1px solid var(--borde);}" +
  ".subida-fila:last-child{border-bottom:none;}" +
  ".subida-fila input[type=file]{font-size:13px;}";

// JS que corre en el navegador (sin backticks para evitar problemas al empotrarlo)
const JS_CLIENTE =
  "var datos = null;" +
  "var seleccionado = null;" +
  "var autenticado = false;" +

  "function cambiarTab(btn) {" +
  "  document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('activo');});" +
  "  btn.classList.add('activo');" +
  "  document.querySelectorAll('.vista').forEach(function(v){v.classList.add('oculto');});" +
  "  document.getElementById('vista-' + btn.dataset.tab).classList.remove('oculto');" +
  "  if (btn.dataset.tab === 'admin') renderAdmin();" +
  "}" +

  "function fmt(n) { return Number(n).toLocaleString('es-CO'); }" +

  "function cargarDatos() {" +
  "  document.getElementById('estado').textContent = 'Cargando...';" +
  "  fetch('/data', { cache: 'no-store' }).then(function(r){ return r.json(); }).then(function(json){" +
  "    datos = json;" +
  "    document.getElementById('estado').textContent = 'Actualizado a las ' + new Date().toLocaleTimeString('es-CO');" +
  "    renderTodo();" +
  "  });" +
  "}" +

  "function renderTodo() {" +
  "  renderAnalistas();" +
  "  renderMetas();" +
  "  renderDetalle();" +
  "  if (!document.getElementById('vista-admin').classList.contains('oculto')) renderAdmin();" +
  "}" +

  "function sumarPorAnalista(filas) {" +
  "  var mapa = {};" +
  "  filas.forEach(function(f){ mapa[f.ANALISTA] = (mapa[f.ANALISTA] || 0) + f.CANTIDAD; });" +
  "  var out = Object.keys(mapa).map(function(k){ return { ANALISTA: k, CANTIDAD: mapa[k] }; });" +
  "  out.sort(function(a,b){ return b.CANTIDAD - a.CANTIDAD; });" +
  "  return out;" +
  "}" +

  "function renderAnalistas() {" +
  "  var cont = document.getElementById('vista-analistas');" +
  "  if (!datos || !datos.agentes || !datos.agentes.data) {" +
  "    cont.innerHTML = '<div class=\"tarjeta\">Aún no hay datos de \"Críticas por agente\". Sube el Excel desde Admin.</div>';" +
  "    return;" +
  "  }" +
  "  var resumen = sumarPorAnalista(datos.agentes.data);" +
  "  var total = resumen.reduce(function(s,r){ return s + r.CANTIDAD; }, 0);" +
  "  var mayor = resumen.length ? Math.max.apply(null, resumen.map(function(r){ return r.CANTIDAD; })) : 0;" +
  "  var html = '<div class=\"tarjeta\">';" +
  "  html += '<div class=\"metricas\">';" +
  "  html += '<div><div class=\"metrica-titulo\">Total de críticas</div><div class=\"metrica-valor\">' + fmt(total) + '</div></div>';" +
  "  html += '<div><div class=\"metrica-titulo\">Analistas</div><div class=\"metrica-valor\">' + resumen.length + '</div></div>';" +
  "  html += '<div><div class=\"metrica-titulo\">Mayor cantidad</div><div class=\"metrica-valor\">' + fmt(mayor) + '</div></div>';" +
  "  html += '</div>';" +
  "  if (datos.horas && datos.horas.data) html += '<p class=\"ayuda\">Toca un analista para ver su detalle por hora.</p>';" +
  "  resumen.forEach(function(r){" +
  "    var pct = mayor ? (r.CANTIDAD / mayor * 100) : 0;" +
  "    var sel = r.ANALISTA === seleccionado ? ' sel' : '';" +
  "    html += '<div class=\"fila-barra' + sel + '\" onclick=\"seleccionarAnalista(\\'' + r.ANALISTA.replace(/'/g, \"\\\\'\") + '\\')\">';" +
  "    html += '<div class=\"nombre\">' + r.ANALISTA + '</div>';" +
  "    html += '<div class=\"pista\"><div class=\"relleno\" style=\"width:' + pct + '%\"><span class=\"valor\">' + fmt(r.CANTIDAD) + '</span></div></div>';" +
  "    html += '</div>';" +
  "  });" +
  "  html += '</div>';" +
  "  if (datos.horas && datos.horas.data) {" +
  "    html += '<div class=\"tarjeta\" id=\"caja-horas\">' + renderHorasHTML() + '</div>';" +
  "  }" +
  "  cont.innerHTML = html;" +
  "}" +

  "function seleccionarAnalista(nombre) {" +
  "  seleccionado = (seleccionado === nombre) ? null : nombre;" +
  "  renderAnalistas();" +
  "}" +

  "function renderHorasHTML() {" +
  "  if (!seleccionado) return '<p class=\"ayuda\">Selecciona un analista arriba para ver su detalle por hora.</p>';" +
  "  var det = datos.horas.data.filter(function(h){ return h.ANALISTA === seleccionado; });" +
  "  det.sort(function(a,b){ return a.ORDEN_HORA - b.ORDEN_HORA; });" +
  "  if (!det.length) return '<p class=\"ayuda\">No hay datos por hora para ' + seleccionado + '.</p>';" +
  "  var max = Math.max.apply(null, det.map(function(d){ return d.CANTIDAD; }));" +
  "  var html = '<div style=\"font-size:14px;font-weight:600;margin-bottom:6px;\">Críticas por hora — ' + seleccionado + '</div>';" +
  "  html += '<div class=\"barra-h\">';" +
  "  det.forEach(function(d){" +
  "    var pct = max ? (d.CANTIDAD / max * 100) : 0;" +
  "    html += '<div class=\"col\"><div class=\"num\">' + fmt(d.CANTIDAD) + '</div><div class=\"rect\" style=\"height:' + pct + '%\"></div><div class=\"hora\">' + d.RANGO_HORA + '</div></div>';" +
  "  });" +
  "  html += '</div>';" +
  "  return html;" +
  "}" +

  "function renderMetas() {" +
  "  var cont = document.getElementById('vista-metas');" +
  "  if (!datos || !datos.metas || !datos.metas.data) {" +
  "    cont.innerHTML = '<div class=\"tarjeta\">Aún no hay datos de metas. Sube el Excel \"Promedio\" desde Admin.</div>';" +
  "    return;" +
  "  }" +
  "  var m = datos.metas.data.slice();" +
  "  m.sort(function(a,b){ return a.PORCENTAJE_CUMPLIMIENTO - b.PORCENTAJE_CUMPLIMIENTO; });" +
  "  var cumplen = m.filter(function(x){ return x.CUMPLIMIENTO === 'CUMPLE'; }).length;" +
  "  var noCumplen = m.filter(function(x){ return x.CUMPLIMIENTO === 'NO CUMPLE'; }).length;" +
  "  var prom = m.reduce(function(s,x){ return s + x.PORCENTAJE_CUMPLIMIENTO; }, 0) / m.length;" +
  "  var TOPE = 150;" +
  "  var html = '<div class=\"tarjeta\">';" +
  "  html += '<div class=\"metricas\">';" +
  "  html += '<div><div class=\"metrica-titulo\">Cumplen la meta</div><div class=\"metrica-valor\">' + cumplen + '</div></div>';" +
  "  html += '<div><div class=\"metrica-titulo\">No cumplen</div><div class=\"metrica-valor\">' + noCumplen + '</div></div>';" +
  "  html += '<div><div class=\"metrica-titulo\">Promedio</div><div class=\"metrica-valor\">' + prom.toFixed(1) + '%</div></div>';" +
  "  html += '</div>';" +
  "  m.forEach(function(r){" +
  "    var plot = Math.min(r.PORCENTAJE_CUMPLIMIENTO, TOPE);" +
  "    var w = (plot / TOPE) * 100;" +
  "    var claseOk = r.CUMPLIMIENTO === 'CUMPLE' ? 'cumple' : 'nocumple';" +
  "    html += '<div class=\"meta-fila\"><div class=\"nombre\">' + r.ANALISTA + '</div>';" +
  "    html += '<div class=\"pista\"><div class=\"linea-meta\" style=\"left:' + (100/TOPE*100) + '%\"></div>';" +
  "    html += '<div class=\"relleno ' + claseOk + '\" style=\"width:' + w + '%\"></div></div>';" +
  "    html += '<div class=\"valor\">' + r.PORCENTAJE_CUMPLIMIENTO.toFixed(1) + '%</div></div>';" +
  "  });" +
  "  html += '</div>';" +
  "  cont.innerHTML = html;" +
  "}" +

  "function renderDetalle() {" +
  "  var cont = document.getElementById('vista-detalle');" +
  "  if (!datos || !datos.metas || !datos.metas.data) {" +
  "    cont.innerHTML = '<div class=\"tarjeta\">No hay datos de metas para mostrar.</div>';" +
  "    return;" +
  "  }" +
  "  var cols = ['ANALISTA','TOTAL_CRITICAS','DIAS_TRABAJADOS','META_MENSUAL','PROMEDIO_DIARIO','DIFERENCIA_META','PORCENTAJE_CUMPLIMIENTO','CUMPLIMIENTO'];" +
  "  var m = datos.metas.data.slice();" +
  "  cols = cols.filter(function(c){ return m.some(function(x){ return c in x; }); });" +
  "  m.sort(function(a,b){ return b.PORCENTAJE_CUMPLIMIENTO - a.PORCENTAJE_CUMPLIMIENTO; });" +
  "  var html = '<div class=\"tarjeta tabla-scroll\"><table><thead><tr>';" +
  "  cols.forEach(function(c){ html += '<th>' + c + '</th>'; });" +
  "  html += '</tr></thead><tbody>';" +
  "  m.forEach(function(r){" +
  "    var claseOk = r.CUMPLIMIENTO === 'CUMPLE' ? 'fila-cumple' : 'fila-nocumple';" +
  "    html += '<tr class=\"' + claseOk + '\">';" +
  "    cols.forEach(function(c){" +
  "      var v = r[c];" +
  "      if (typeof v === 'number') v = c === 'PORCENTAJE_CUMPLIMIENTO' ? v.toFixed(1) + '%' : fmt(v);" +
  "      html += '<td>' + (v === undefined || v === null ? '' : v) + '</td>';" +
  "    });" +
  "    html += '</tr>';" +
  "  });" +
  "  html += '</tbody></table></div>';" +
  "  cont.innerHTML = html;" +
  "}" +

  "var ARCHIVOS = [" +
  "  { tipo: 'agentes', nombre: 'Críticas por agente', detalle: 'Columnas: ANALISTA, CANTIDAD', ob: true }," +
  "  { tipo: 'horas', nombre: 'Críticas por horas', detalle: 'Columnas: ANALISTA, RANGO_HORA, ORDEN_HORA, CANTIDAD', ob: false }," +
  "  { tipo: 'metas', nombre: 'Promedio (metas)', detalle: 'Columnas: ANALISTA, PORCENTAJE_CUMPLIMIENTO, CUMPLIMIENTO', ob: true }" +
  "];" +

  "function renderAdmin() {" +
  "  var cont = document.getElementById('vista-admin');" +
  "  if (!autenticado) {" +
  "    cont.innerHTML = '<div class=\"tarjeta login-caja\">" +
  "      <p class=\"ayuda\" style=\"margin-top:0\">Ingresa la contraseña de admin para subir los Excel.</p>" +
  "      <input type=\"password\" id=\"pass-admin\" placeholder=\"Contraseña\" />" +
  "      <button onclick=\"loginAdmin()\">Entrar</button>" +
  "      <p class=\"error\" id=\"error-login\"></p>" +
  "    </div>';" +
  "    return;" +
  "  }" +
  "  var html = '<div class=\"tarjeta\"><p class=\"ayuda\" style=\"margin-top:0\">Sube aquí los 3 archivos Excel. Cada subida reemplaza a la anterior del mismo tipo.</p>';" +
  "  ARCHIVOS.forEach(function(a){" +
  "    var info = datos && datos[a.tipo] ? datos[a.tipo] : null;" +
  "    var badge = info && info.actualizado ? 'Actualizado: ' + new Date(info.actualizado).toLocaleString('es-CO') : 'Sin subir';" +
  "    html += '<div class=\"subida-fila\">';" +
  "    html += '<div style=\"display:flex;justify-content:space-between;align-items:center;\">';" +
  "    html += '<strong style=\"font-size:14px;\">' + a.nombre + (a.ob ? ' <span style=\"color:#e74c3c\">*</span>' : '') + '</strong>';" +
  "    html += '<span class=\"badge\" id=\"badge-' + a.tipo + '\">' + badge + '</span></div>';" +
  "    html += '<div class=\"ayuda\" style=\"margin:2px 0 6px\">' + a.detalle + '</div>';" +
  "    html += '<input type=\"file\" accept=\".xlsx,.xls\" onchange=\"subirArchivo(\\'' + a.tipo + '\\', this)\" />';" +
  "    html += '<p class=\"error\" id=\"error-' + a.tipo + '\"></p>';" +
  "    html += '</div>';" +
  "  });" +
  "  html += '</div>';" +
  "  cont.innerHTML = html;" +
  "}" +

  "function loginAdmin() {" +
  "  var pass = document.getElementById('pass-admin').value;" +
  "  fetch('/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ password: pass }) })" +
  "    .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })" +
  "    .then(function(res){" +
  "      if (!res.ok) { document.getElementById('error-login').textContent = res.j.error || 'Error'; return; }" +
  "      autenticado = true;" +
  "      renderAdmin();" +
  "    });" +
  "}" +

  "function subirArchivo(tipo, input) {" +
  "  var file = input.files[0];" +
  "  if (!file) return;" +
  "  var form = new FormData();" +
  "  form.append('tipo', tipo);" +
  "  form.append('file', file);" +
  "  document.getElementById('badge-' + tipo).textContent = 'Subiendo...';" +
  "  document.getElementById('error-' + tipo).textContent = '';" +
  "  fetch('/upload', { method: 'POST', body: form })" +
  "    .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })" +
  "    .then(function(res){" +
  "      if (!res.ok) {" +
  "        document.getElementById('error-' + tipo).textContent = res.j.error || 'No se pudo subir';" +
  "        if (res.j.error === 'No autenticado') { autenticado = false; renderAdmin(); }" +
  "        else renderAdmin();" +
  "        return;" +
  "      }" +
  "      cargarDatos();" +
  "    });" +
  "}" +

  "cargarDatos();";

// ============================================================
// ENRUTADOR
// ============================================================
module.exports = async (req, res) => {
  const url = new URL(req.url, "http://" + req.headers.host);
  const path = url.pathname;

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(paginaHTML());
    return;
  }

  if (req.method === "GET" && path === "/data") {
    const [agentes, horas, metas] = await Promise.all([
      leerTipo("agentes"),
      leerTipo("horas"),
      leerTipo("metas"),
    ]);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ agentes, horas, metas }));
    return;
  }

  if (req.method === "POST" && path === "/login") {
    const body = await leerCuerpoJSON(req);
    if (body.password !== ADMIN_PASSWORD) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Contraseña incorrecta" }));
      return;
    }
    const token = crearToken();
    res.setHeader(
      "Set-Cookie",
      COOKIE_NAME + "=" + token + "; Path=/; Max-Age=" + 30 * 24 * 60 * 60 + "; HttpOnly; Secure; SameSite=Lax"
    );
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "POST" && path === "/upload") {
    if (!estaAutenticado(req)) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "No autenticado" }));
      return;
    }
    let parsed;
    try {
      parsed = await parseMultipart(req);
    } catch (e) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "No se pudo leer el archivo" }));
      return;
    }
    const tipo = parsed.fields.tipo;
    if (!tipo || !PARSERS[tipo] || !parsed.file) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Datos incompletos" }));
      return;
    }
    try {
      PARSERS[tipo](parsed.file);
    } catch (e) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
    try {
      await put(RUTAS[tipo], parsed.file, {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.statusCode = 404;
  res.end("No encontrado");
};
