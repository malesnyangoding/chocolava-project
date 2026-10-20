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

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { visitId, imageDataUrl } = body;

  if (!visitId || !imageDataUrl) {
    return res.status(400).json({ ok: false, message: 'visitId and imageDataUrl are required.' });
  }

  const sql = getSql();
  if (!sql) {
    return res.status(500).json({ ok: false, message: 'NEON_DATABASE_URL is not configured.' });
  }

  try {
    await ensureSchema(sql);

    const existing = await sql`
      SELECT COUNT(*)::int AS total FROM visit_photos WHERE visit_id = ${visitId};
    `;

    if ((existing?.[0]?.total || 0) >= 5) {
      return res.status(409).json({ ok: false, message: 'Maximum 5 photos per visit reached.' });
    }

    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      return res.status(500).json({ ok: false, message: 'Cloudinary credentials are not configured.' });
    }

    const uploadResult = await cloudinary.uploader.upload(imageDataUrl, {
      folder: 'retrolens/visits',
      resource_type: 'image',
      transformation: [{ quality: 'auto', fetch_format: 'auto' }],
    });

    await sql`
      INSERT INTO visit_photos (visit_id, photo_url, source)
      VALUES (${visitId}, ${uploadResult.secure_url || uploadResult.url}, 'camera');
    `;

    return res.status(200).json({ ok: true, url: uploadResult.secure_url || uploadResult.url });
  } catch (error) {
    console.error('photo upload error', error);
    return res.status(500).json({ ok: false, message: 'Failed to save photo.' });
  }
}
