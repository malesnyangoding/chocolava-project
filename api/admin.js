import { ensureSchema, getSql } from './_lib/db.js';

const EXPECTED_PIN = String(process.env.ADMIN_PIN || '').trim();

function invalidPinResponse(res) {
  return res.status(403).json({ ok: false, message: 'Invalid or missing admin PIN.' });
}

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

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { pin, action = 'verify' } = body;

  if (!EXPECTED_PIN || !/^\d{6}$/.test(EXPECTED_PIN)) {
    return res.status(500).json({ ok: false, message: 'ADMIN_PIN must be a 6-digit numeric value.' });
  }

  if (String(pin) !== EXPECTED_PIN) {
    return invalidPinResponse(res);
  }

  const sql = getSql();
  if (!sql) {
    return res.status(500).json({ ok: false, message: 'NEON_DATABASE_URL is not configured.' });
  }

  try {
    await ensureSchema(sql);

    if (action === 'list') {
      const rows = await sql`
        SELECT
          v.id,
          v.ip_address AS ip_address,
          v.location,
          v.device_name,
          v.page,
          v.visit_time,
          COUNT(vp.id)::int AS photo_count
        FROM visits v
        LEFT JOIN visit_photos vp ON vp.visit_id = v.id
        GROUP BY v.id, v.ip_address, v.location, v.device_name, v.page, v.visit_time
        ORDER BY v.visit_time DESC
        LIMIT 200;
      `;

      return res.status(200).json({
        ok: true,
        visits: rows.map((row) => ({
          ...row,
          visit_time: row.visit_time ? new Date(row.visit_time).toISOString() : null,
        })),
      });
    }

    return res.status(200).json({ ok: true, message: 'Admin access authorized.' });
  } catch (error) {
    console.error('admin error', error);
    return res.status(500).json({ ok: false, message: 'Failed to load admin data.' });
  }
}
