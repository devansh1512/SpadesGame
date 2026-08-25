// Vercel serverless function: GET/POST /api/room
// Stores each room's game state in Upstash Redis (installed via the Vercel
// Marketplace), keyed by room code. This is what replaces Claude.ai's
// artifact-only window.storage API so the game works as a normal hosted app.
//
// NOTE: Vercel KV (the old @vercel/kv package) was discontinued and no longer
// works. This uses @upstash/redis instead - see README for the one-time setup
// step (installing the "Upstash for Redis" integration from the Marketplace).
const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();
const ROOM_TTL_SECONDS = 60 * 60 * 6; // rooms expire after 6 hours of inactivity

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const code = String(req.query.code || '').toUpperCase();
    if (!code) return res.status(400).json({ error: 'missing code' });
    try {
      const state = await redis.get(`room:${code}`);
      if (!state) return res.status(404).json({ error: 'not found' });
      return res.status(200).json({ state });
    } catch (e) {
      return res.status(500).json({ error: 'storage error', detail: String(e && e.message || e) });
    }
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    const code = String((body && body.code) || '').toUpperCase();
    const state = body && body.state;
    if (!code || !state) return res.status(400).json({ error: 'missing code or state' });
    try {
      await redis.set(`room:${code}`, state, { ex: ROOM_TTL_SECONDS });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'storage error', detail: String(e && e.message || e) });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method not allowed' });
};
