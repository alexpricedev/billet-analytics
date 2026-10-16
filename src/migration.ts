import type { SQL } from "bun";

// Re-export from a file in the site's own migrations folder:
//
//   // src/server/database/migrations/20261016000000_create_analytics.ts
//   export { up, down } from "@alexpricedev/billet-analytics/migration";

export const up = async (db: SQL): Promise<void> => {
  // First-party, anonymous event log. Nothing here identifies a person: the
  // visitor hash is salted with a key that is deleted once its day ends (see
  // analytics_salt), routes are stored as patterns, and the user agent and
  // referrer are reduced to coarse labels before they are written.
  await db`
    CREATE TABLE analytics_event (
      id BIGSERIAL PRIMARY KEY,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      name TEXT NOT NULL,
      source TEXT NOT NULL CONSTRAINT analytics_event_source_check
        CHECK (source IN ('server', 'client')),
      visitor_hash TEXT NOT NULL,
      route TEXT NULL,
      method TEXT NULL,
      status SMALLINT NULL,
      authenticated BOOLEAN NOT NULL DEFAULT false,
      referrer_host TEXT NULL,
      utm_source TEXT NULL,
      utm_medium TEXT NULL,
      utm_campaign TEXT NULL,
      device TEXT NULL,
      browser TEXT NULL,
      props JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `;
  await db`CREATE INDEX idx_analytics_event_time ON analytics_event (occurred_at)`;
  await db`CREATE INDEX idx_analytics_event_name_time ON analytics_event (name, occurred_at)`;

  // One random salt per local day (the configured time zone). Only today's is
  // kept; earlier days' salts are deleted, which is what makes old visitor
  // hashes irreversible.
  await db`
    CREATE TABLE analytics_salt (
      day DATE PRIMARY KEY,
      salt TEXT NOT NULL
    )
  `;
};

export const down = async (db: SQL): Promise<void> => {
  await db`DROP TABLE IF EXISTS analytics_salt`;
  await db`DROP TABLE IF EXISTS analytics_event`;
};
