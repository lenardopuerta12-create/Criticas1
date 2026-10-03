// Función de Vercel: guarda y lee los movimientos de cada usuario (por nombre) en Upstash Redis.
// Variables de entorno (las crea Vercel solo al conectar la base de datos):
//   KV_REST_API_URL y KV_REST_API_TOKEN   (o UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)

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

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!DB_URL || !DB_TOKEN) return res.status(500).json({ error: 'db_not_configured' });

  try {
    if (req.method === 'GET') {
      const user = cleanUser(req.query && req.query.user);
      if (!user) return res.status(400).json({ error: 'bad_user' });
      const v = await redis(['GET', 'nova:' + user]);
      return res.status(200).json({ data: v ? JSON.parse(v) : [] });
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      const user = cleanUser(body && body.user);
      if (!user || !Array.isArray(body.data) || body.data.length > 20000) {
        return res.status(400).json({ error: 'bad_request' });
      }
      const items = body.data.map(cleanItem).filter((m) => m && m.id);
      await redis(['SET', 'nova:' + user, JSON.stringify(items)]);
      return res.status(200).json({ ok: true, count: items.length });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
};
