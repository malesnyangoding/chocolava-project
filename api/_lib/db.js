import postgres from 'postgres';

const dbUrl = process.env.NEON_DATABASE_URL;

export function getSql() {
  if (!dbUrl) {
    return null;
  }

  return postgres(dbUrl, {
    ssl: 'require',
    max: 1,
    idle_timeout: 30,
    connect_timeout: 30,
  });
}

export async function ensureSchema(sql) {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto;`;

  await sql`
    CREATE TABLE IF NOT EXISTS visits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ip_address TEXT,
      location TEXT,
      device_name TEXT,
      user_agent TEXT,
      page TEXT DEFAULT 'main',
      visit_time TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS visit_photos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      visit_id UUID NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
      photo_url TEXT NOT NULL,
      cloudinary_public_id TEXT,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source TEXT DEFAULT 'camera'
    );
  `;

  await sql`
    ALTER TABLE visit_photos
    ADD COLUMN IF NOT EXISTS cloudinary_public_id TEXT;
  `;
}
