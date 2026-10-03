// Función de Vercel: login con clave + guardar/leer movimientos y deudas por usuario.
// Base de datos: Upstash Redis. Variables (las crea Vercel al conectar la base):
//   KV_REST_API_URL / KV_REST_API_TOKEN   (o UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)

const crypto = require('crypto');

const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TIPOS = ['ganancia', 'gasto', 'ahorro'];

async function redis(cmd) {
  const r = await fetch(DB_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || 'redis ' + r.status);
  return j.result;
}

function cleanUser(u) {
  u = String(u || '').trim().toLowerCase();
  return u && u.length <= 24 ? u : '';
}
function cleanPass(p) {
  p = String(p == null ? '' : p);
  return p.length >= 4 && p.length <= 64 ? p : '';
}

// ---- clave: hash con sal (scrypt) ----
function makeHash(p) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(p), salt, 32).toString('hex');
}
function verifyHash(p, stored) {
  if (!stored || stored.indexOf(':') < 0) return false;
  const [salt, h] = stored.split(':');
  let cand;
  try { cand = crypto.scryptSync(String(p), salt, 32).toString('hex'); } catch (e) { return false; }
  try {
    const a = Buffer.from(h, 'hex'), b = Buffer.from(cand, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

// ---- validación de datos ----
function cleanItem(m) {
  if (!m || typeof m !== 'object') return null;
  const monto = Number(m.monto);
  if (!TIPOS.includes(m.tipo) || !Number.isFinite(monto) || monto <= 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(m.fecha))) return null;
  return {
    id: String(m.id || '').slice(0, 40),
    tipo: m.tipo,
    monto,
    categoria: String(m.categoria || '').slice(0, 40),
    fecha: String(m.fecha),
    nota: String(m.nota || '').slice(0, 60),
  };
}
function cleanDebt(d) {
  if (!d || typeof d !== 'object') return null;
  const monto = Number(d.monto);
  if (!Number.isFinite(monto) || monto <= 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.fecha))) return null;
  const abonos = Array.isArray(d.abonos) ? d.abonos.map((a) => {
    const m = Number(a && a.monto);
    if (!Number.isFinite(m) || m <= 0) return null;
    const f = /^\d{4}-\d{2}-\d{2}$/.test(String(a && a.fecha)) ? a.fecha : String(d.fecha);
    return { id: String((a && a.id) || '').slice(0, 40), monto: m, fecha: f };
  }).filter(Boolean).slice(0, 500) : [];
  return {
    id: String(d.id || '').slice(0, 40),
    persona: String(d.persona || '').slice(0, 40),
    monto,
    fecha: String(d.fecha),
    nota: String(d.nota || '').slice(0, 80),
    abonos,
  };
}

async function readAll(user) {
  const [mv, de] = await Promise.all([redis(['GET', 'nova:' + user]), redis(['GET', 'nova:deu:' + user])]);
  return { data: mv ? JSON.parse(mv) : [], deudas: de ? JSON.parse(de) : [] };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!DB_URL || !DB_TOKEN) return res.status(500).json({ error: 'db_not_configured' });

  try {
    // GET = chequeo de salud, nunca devuelve datos (así el link solo no sirve para leer nada)
    if (req.method === 'GET') return res.status(200).json({ ok: true, service: 'nova' });
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method_not_allowed' }); }

    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    if (!body || typeof body !== 'object') body = {};

    const action = body.action;
    const user = cleanUser(body.user);
    const pass = cleanPass(body.pass);
    if (!user || !pass) return res.status(400).json({ error: 'bad_request' });

    const passKey = 'nova:pass:' + user;

    if (action === 'login') {
      const stored = await redis(['GET', passKey]);
      if (!stored) {
        // nombre nuevo (o datos viejos sin clave): la clave que llega queda registrada
        await redis(['SET', passKey, makeHash(pass)]);
        const all = await readAll(user);
        return res.status(200).json(Object.assign({ ok: true, new: true }, all));
      }
      if (!verifyHash(pass, stored)) return res.status(401).json({ error: 'bad_pass' });
      const all = await readAll(user);
      return res.status(200).json(Object.assign({ ok: true }, all));
    }

    // get / save: la clave debe existir y coincidir
    const stored = await redis(['GET', passKey]);
    if (!verifyHash(pass, stored)) return res.status(401).json({ error: 'bad_pass' });

    if (action === 'get') {
      const all = await readAll(user);
      return res.status(200).json(Object.assign({ ok: true }, all));
    }

    if (action === 'save') {
      if (!Array.isArray(body.data) || body.data.length > 20000) return res.status(400).json({ error: 'bad_data' });
      if (!Array.isArray(body.deudas) || body.deudas.length > 5000) return res.status(400).json({ error: 'bad_data' });
      const items = body.data.map(cleanItem).filter((m) => m && m.id);
      const debts = body.deudas.map(cleanDebt).filter((d) => d && d.id);
      await Promise.all([
        redis(['SET', 'nova:' + user, JSON.stringify(items)]),
        redis(['SET', 'nova:deu:' + user, JSON.stringify(debts)]),
      ]);
      return res.status(200).json({ ok: true, movs: items.length, deudas: debts.length });
    }

    return res.status(400).json({ error: 'bad_action' });
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
};
