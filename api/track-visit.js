import { ensureSchema, getSql } from './_lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }
    res.status(405).json({ ok: false, message: 'Method not allowed' });
    return;
  }

  const payload = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { ip, location, deviceName, userAgent, page = 'main' } = payload;
  const sql = getSql();

  if (!sql) {
    res.status(500).json({ ok: false, message: 'NEON_DATABASE_URL is not configured.' });
    return;
  }

  try {
    await ensureSchema(sql);

    const [row] = await sql`
      INSERT INTO visits (ip_address, location, device_name, user_agent, page)
      VALUES (${ip || null}, ${location || null}, ${deviceName || null}, ${userAgent || null}, ${page})
      RETURNING id, visit_time;
    `;

    res.status(200).json({
      ok: true,
      visitId: row.id,
      recordedAt: row.visit_time,
    });
  } catch (error) {
    console.error('track-visit error', error);
    res.status(500).json({ ok: false, message: 'Failed to record visit.' });
  }
}
