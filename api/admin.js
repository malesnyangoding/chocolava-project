import { createHmac, timingSafeEqual } from 'node:crypto';
import { ensureSchema, getSql } from './_lib/db.js';

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
    SELECT
      v.id,
      v.ip_address,
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
    ...(sessionToken ? { sessionToken } : {}),
    visits: rows.map((row) => ({
      ...row,
      visit_time: row.visit_time ? new Date(row.visit_time).toISOString() : null,
    })),
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

    return await sendVisits(sql, res);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return res.status(400).json({ ok: false, message: 'Invalid request body.' });
    }
    console.error('admin error', error);
    return res.status(500).json({ ok: false, message: 'Failed to load admin data.' });
  }
}
