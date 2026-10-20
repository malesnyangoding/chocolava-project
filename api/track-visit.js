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

  try {
    const payload = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const forwardedFor = req.headers['x-forwarded-for'];
    const forwardedIp = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor?.split(',')[0];
    const ip = forwardedIp?.trim() || payload.ip || req.socket?.remoteAddress || null;
    const location = payload.location;
    const deviceName = payload.deviceName;
    const userAgent = req.headers['user-agent'] || payload.userAgent || null;
    const page = payload.page || 'main';
    const sql = getSql();

    if (!sql) {
      res.status(500).json({ ok: false, message: 'NEON_DATABASE_URL is not configured.' });
      return;
    }

    await ensureSchema(sql);

    const row = await sql.begin(async (tx) => {
      const visitorKey = JSON.stringify([ip, userAgent]);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${visitorKey}, 0));`;

      const [existing] = await tx`
        SELECT id
        FROM visits
        WHERE ip_address IS NOT DISTINCT FROM ${ip}
          AND user_agent IS NOT DISTINCT FROM ${userAgent}
        ORDER BY visit_time DESC
        LIMIT 1
        FOR UPDATE;
      `;

      if (existing) {
        const [updated] = await tx`
          UPDATE visits
          SET location = ${location || null},
              device_name = ${deviceName || null},
              page = ${page},
              visit_time = NOW()
          WHERE id = ${existing.id}
          RETURNING id, visit_time;
        `;
        return updated;
      }

      const [created] = await tx`
        INSERT INTO visits (ip_address, location, device_name, user_agent, page)
        VALUES (${ip}, ${location || null}, ${deviceName || null}, ${userAgent}, ${page})
        RETURNING id, visit_time;
      `;
      return created;
    });
    const [photoState] = await sql`
      SELECT
        COUNT(*)::int AS photo_count,
        MAX(vp.captured_at) AS last_photo_at
      FROM visit_photos vp
      JOIN visits v ON v.id = vp.visit_id
      WHERE v.ip_address IS NOT DISTINCT FROM ${ip}
        AND v.user_agent IS NOT DISTINCT FROM ${userAgent}
        AND vp.captured_at >= NOW() - INTERVAL '24 hours';
    `;

    res.status(200).json({
      ok: true,
      visitId: row.id,
      recordedAt: row.visit_time,
      photoCount: photoState.photo_count,
      photoCooldownUntil: photoState.photo_count >= 5 && photoState.last_photo_at
        ? new Date(new Date(photoState.last_photo_at).getTime() + 24 * 60 * 60 * 1000).toISOString()
        : null,
    });
  } catch (error) {
    console.error('track-visit error', error);
    res.status(500).json({ ok: false, message: 'Failed to record visit.' });
  }
}
