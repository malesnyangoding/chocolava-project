import { ensureSchema, getSql } from './_lib/db.js';
import { cloudinary } from './_lib/cloudinary.js';

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
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { visitId, imageDataUrl } = body;

    if (!visitId || !imageDataUrl) {
      return res.status(400).json({ ok: false, message: 'visitId and imageDataUrl are required.' });
    }
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(imageDataUrl)) {
      return res.status(400).json({ ok: false, message: 'imageDataUrl must be a base64 JPEG data URL.' });
    }

    const sql = getSql();
    if (!sql) {
      return res.status(500).json({ ok: false, message: 'NEON_DATABASE_URL is not configured.' });
    }

    await ensureSchema(sql);

    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      return res.status(500).json({ ok: false, message: 'Cloudinary credentials are not configured.' });
    }

    const upload = await sql.begin(async (tx) => {
      const [visit] = await tx`
        SELECT id, ip_address, user_agent
        FROM visits
        WHERE id = ${visitId};
      `;

      if (!visit) {
        return { error: 'Visit not found.', status: 404 };
      }

      const visitorKey = JSON.stringify([visit.ip_address, visit.user_agent]);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${visitorKey}, 0));`;

      const [lockedVisit] = await tx`
        SELECT id
        FROM visits
        WHERE id = ${visitId}
        FOR UPDATE;
      `;
      if (!lockedVisit) {
        return { error: 'Visit not found.', status: 404 };
      }

      const [quota] = await tx`
        SELECT
          COUNT(*)::int AS total,
          MAX(vp.captured_at) AS last_photo_at
        FROM visit_photos vp
        JOIN visits v ON v.id = vp.visit_id
        WHERE v.ip_address IS NOT DISTINCT FROM ${visit.ip_address}
          AND v.user_agent IS NOT DISTINCT FROM ${visit.user_agent}
          AND vp.captured_at >= NOW() - INTERVAL '24 hours';
      `;

      if (quota.total >= 5) {
        const availableAt = new Date(new Date(quota.last_photo_at).getTime() + 24 * 60 * 60 * 1000);
        return {
          error: 'Batas 5 foto dalam 24 jam untuk IP dan perangkat ini sudah tercapai.',
          status: 429,
          availableAt: availableAt.toISOString(),
        };
      }

      const uploadResult = await cloudinary.uploader.upload(imageDataUrl, {
        folder: 'retrolens/visits',
        resource_type: 'image',
        transformation: [{ quality: 'auto', fetch_format: 'auto' }],
      });
      const photoUrl = uploadResult.secure_url || uploadResult.url;

      await tx`
        INSERT INTO visit_photos (visit_id, photo_url, cloudinary_public_id, source)
        VALUES (${visitId}, ${photoUrl}, ${uploadResult.public_id}, 'camera');
      `;
      return { url: photoUrl };
    });

    if (upload.error) {
      return res.status(upload.status).json({
        ok: false,
        message: upload.error,
        ...(upload.availableAt ? { availableAt: upload.availableAt } : {}),
      });
    }

    return res.status(200).json({ ok: true, url: upload.url });
  } catch (error) {
    console.error('photo upload error', error);
    if (error instanceof SyntaxError) {
      return res.status(400).json({ ok: false, message: 'Invalid request body.' });
    }
    return res.status(500).json({
      ok: false,
      message: error instanceof Error ? `Failed to save photo: ${error.message}` : 'Failed to save photo.',
    });
  }
}
