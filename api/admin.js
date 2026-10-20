import { createHmac, timingSafeEqual } from 'node:crypto';
import { ensureSchema, getSql } from './_lib/db.js';
import { deleteCloudinaryImage } from './_lib/cloudinary.js';

const EXPECTED_PIN = String(process.env.ADMIN_PIN || '').trim();
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || '';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function invalidPinResponse(res) {
  return res.status(403).json({ ok: false, message: 'Invalid or missing admin PIN.' });
}

function signSession(timestamp) {
  return createHmac('sha256', SESSION_SECRET).update(`admin:${timestamp}`).digest('hex');
}

function getValidSessionToken(req) {
  if (!SESSION_SECRET) return false;
  const authorization = req.headers.authorization || '';
  const [scheme, value] = authorization.split(' ');
  if (scheme !== 'Bearer' || !value) return false;

  const [timestamp, signature] = value.split('.');
  if (!/^\d+$/.test(timestamp || '') || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
  const issuedAt = Number(timestamp);
  if (!Number.isSafeInteger(issuedAt) || Date.now() - issuedAt > SESSION_MAX_AGE_MS || issuedAt > Date.now()) return false;

  const expected = Buffer.from(signSession(timestamp), 'hex');
  const received = Buffer.from(signature, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received) ? value : false;
}

async function sendVisits(sql, res, sessionToken) {
  await ensureSchema(sql);
  const rows = await sql`
    WITH latest_visits AS (
      SELECT DISTINCT ON (ip_address, user_agent)
        id,
        ip_address,
        location,
        device_name,
        user_agent,
        page,
        visit_time
      FROM visits
      ORDER BY ip_address, user_agent, visit_time DESC
    ),
    visitor_photos AS (
      SELECT
        v.ip_address,
        v.user_agent,
        COUNT(vp.id)::int AS photo_count,
        COALESCE(
          json_agg(
            json_build_object(
              'id', vp.id,
              'url', vp.photo_url,
              'captured_at', vp.captured_at
            )
            ORDER BY vp.captured_at
          ) FILTER (WHERE vp.id IS NOT NULL),
          '[]'::json
        ) AS photos
      FROM visits v
      LEFT JOIN visit_photos vp ON vp.visit_id = v.id
      GROUP BY v.ip_address, v.user_agent
    )
    SELECT
      v.id,
      v.ip_address,
      v.location,
      v.device_name,
      v.page,
      v.visit_time,
      COALESCE(p.photo_count, 0)::int AS photo_count,
      COALESCE(p.photos, '[]'::json) AS photos
    FROM latest_visits v
    LEFT JOIN visitor_photos p
      ON p.ip_address IS NOT DISTINCT FROM v.ip_address
      AND p.user_agent IS NOT DISTINCT FROM v.user_agent
    ORDER BY v.visit_time DESC
    LIMIT 200;
  `;

  return res.status(200).json({
    ok: true,
    ...(sessionToken ? { sessionToken } : {}),
    visits: rows.map((row) => ({
      ...row,
      visit_time: row.visit_time ? new Date(row.visit_time).toISOString() : null,
      photos: Array.isArray(row.photos) ? row.photos : [],
    })),
  });
}

function getCloudinaryPublicId(photo) {
  if (photo.cloudinary_public_id) return photo.cloudinary_public_id;
  if (typeof photo.photo_url !== 'string') return null;

  try {
    const url = new URL(photo.photo_url);
    if (url.hostname !== 'res.cloudinary.com') return null;
    const segments = url.pathname.split('/').filter(Boolean);
    const uploadIndex = segments.indexOf('upload');
    if (uploadIndex < 0) return null;

    const assetSegments = segments.slice(uploadIndex + 1);
    const versionIndex = assetSegments.findIndex((segment) => /^v\d+$/.test(segment));
    const publicIdSegments = assetSegments.slice(versionIndex >= 0 ? versionIndex + 1 : 0);
    if (!publicIdSegments.length) return null;

    const lastIndex = publicIdSegments.length - 1;
    publicIdSegments[lastIndex] = publicIdSegments[lastIndex].replace(/\.[^.]+$/, '');
    return publicIdSegments.join('/') || null;
  } catch {
    return null;
  }
}

async function deletePhoto(sql, photoId) {
  return sql.begin(async (tx) => {
    const [initialPhoto] = await tx`
      SELECT v.ip_address, v.user_agent
      FROM visit_photos vp
      JOIN visits v ON v.id = vp.visit_id
      WHERE vp.id = ${photoId};
    `;
    if (!initialPhoto) return { error: 'Photo not found.', status: 404 };

    const visitorKey = JSON.stringify([initialPhoto.ip_address, initialPhoto.user_agent]);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${visitorKey}, 0));`;

    const [photo] = await tx`
      SELECT vp.id, vp.photo_url, vp.cloudinary_public_id
      FROM visit_photos vp
      JOIN visits v ON v.id = vp.visit_id
      WHERE vp.id = ${photoId}
        AND v.ip_address IS NOT DISTINCT FROM ${initialPhoto.ip_address}
        AND v.user_agent IS NOT DISTINCT FROM ${initialPhoto.user_agent}
      FOR UPDATE OF vp;
    `;
    if (!photo) return { error: 'Photo not found.', status: 404 };

    const publicId = getCloudinaryPublicId(photo);
    if (!publicId) {
      return { error: 'Could not determine the Cloudinary asset ID; photo record was not deleted.', status: 500 };
    }

    try {
      await deleteCloudinaryImage(publicId);
    } catch (error) {
      console.error('Cloudinary photo deletion failed', error);
      return {
        error: error instanceof Error ? error.message : 'Cloudinary photo deletion failed.',
        status: 502,
      };
    }

    await tx`DELETE FROM visit_photos WHERE id = ${photo.id};`;
    return { ok: true };
  });
}

async function deleteVisit(sql, visitId) {
  return sql.begin(async (tx) => {
    const [initialVisit] = await tx`
      SELECT ip_address, user_agent
      FROM visits
      WHERE id = ${visitId};
    `;
    if (!initialVisit) return { error: 'Visit not found.', status: 404 };

    const visitorKey = JSON.stringify([initialVisit.ip_address, initialVisit.user_agent]);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${visitorKey}, 0));`;

    const photos = await tx`
      SELECT vp.id, vp.photo_url, vp.cloudinary_public_id
      FROM visit_photos vp
      JOIN visits v ON v.id = vp.visit_id
      WHERE v.ip_address IS NOT DISTINCT FROM ${initialVisit.ip_address}
        AND v.user_agent IS NOT DISTINCT FROM ${initialVisit.user_agent}
      FOR UPDATE OF vp;
    `;

    const failures = [];
    for (const photo of photos) {
      const publicId = getCloudinaryPublicId(photo);
      if (!publicId) {
        failures.push(`Could not determine Cloudinary asset ID for photo ${photo.id}.`);
        continue;
      }
      try {
        await deleteCloudinaryImage(publicId);
      } catch (error) {
        console.error(`Cloudinary deletion failed for photo ${photo.id}`, error);
        failures.push(error instanceof Error ? error.message : `Could not delete photo ${photo.id}.`);
      }
    }

    if (failures.length) {
      return {
        error: 'Visit and database records were kept because some Cloudinary photos could not be deleted.',
        details: failures,
        status: 502,
      };
    }

    const deletedVisits = await tx`
      DELETE FROM visits
      WHERE ip_address IS NOT DISTINCT FROM ${initialVisit.ip_address}
        AND user_agent IS NOT DISTINCT FROM ${initialVisit.user_agent}
      RETURNING id;
    `;
    return { ok: true, deletedVisitCount: deletedVisits.length, deletedPhotoCount: photos.length };
  });
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

  if (!EXPECTED_PIN || !/^\d{6}$/.test(EXPECTED_PIN)) {
    return res.status(500).json({ ok: false, message: 'ADMIN_PIN must be a 6-digit numeric value.' });
  }

  if (SESSION_SECRET.length < 32) {
    return res.status(500).json({ ok: false, message: 'ADMIN_SESSION_SECRET must contain at least 32 characters.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { pin, action = 'list' } = body;

    if (action === 'login') {
      if (String(pin) !== EXPECTED_PIN) return invalidPinResponse(res);
      const timestamp = String(Date.now());
      const sessionToken = `${timestamp}.${signSession(timestamp)}`;
      const sql = getSql();
      if (!sql) {
        return res.status(500).json({ ok: false, message: 'NEON_DATABASE_URL is not configured.' });
      }
      return await sendVisits(sql, res, sessionToken);
    }

    const sessionToken = getValidSessionToken(req);
    if (!sessionToken) return invalidPinResponse(res);

    const sql = getSql();
    if (!sql) {
      return res.status(500).json({ ok: false, message: 'NEON_DATABASE_URL is not configured.' });
    }

    if (action === 'delete-photo') {
      if (typeof body.photoId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.photoId)) {
        return res.status(400).json({ ok: false, message: 'A valid photoId is required.' });
      }
      const result = await deletePhoto(sql, body.photoId);
      if (result.error) return res.status(result.status).json({ ok: false, message: result.error });
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete-visit') {
      if (typeof body.visitId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.visitId)) {
        return res.status(400).json({ ok: false, message: 'A valid visitId is required.' });
      }
      const result = await deleteVisit(sql, body.visitId);
      if (result.error) {
        return res.status(result.status).json({
          ok: false,
          message: result.error,
          ...(result.details ? { details: result.details } : {}),
        });
      }
      return res.status(200).json({
        ok: true,
        deletedVisitCount: result.deletedVisitCount,
        deletedPhotoCount: result.deletedPhotoCount,
      });
    }

    return await sendVisits(sql, res);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return res.status(400).json({ ok: false, message: 'Invalid request body.' });
    }
    console.error('admin error', error);
    return res.status(500).json({ ok: false, message: 'Failed to load admin data.' });
  }
}
