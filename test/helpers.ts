import { SQL } from "bun";
import { down, up } from "../src/migration";

// resetSchema drops and recreates both tables, so the tests refuse to run
// against anything but a throwaway database. Put the URL in .env.test (which
// Bun loads over .env under NODE_ENV=test), not .env.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the database tests");
}

const databaseName = (url: string): string => {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return "";
  }
};

const name = databaseName(databaseUrl);
if (!name.endsWith("-test")) {
  throw new Error(
    `billet-analytics tests drop and recreate their tables, so they refuse to run against "${name || databaseUrl}". Point DATABASE_URL at a database whose name ends in "-test" (see .env.test in the README's Development section).`,
  );
}

export const db = new SQL(databaseUrl, { max: 3 });

/** Drop and recreate the package's tables. */
export const resetSchema = async (): Promise<void> => {
  await down(db);
  await up(db);
};

export const truncate = async (): Promise<void> => {
  await db`TRUNCATE analytics_event, analytics_salt RESTART IDENTITY`;
};

export const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
export const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

export const visit = (
  url: string,
  init: RequestInit = {},
  headers: Record<string, string> = {},
): Request =>
  new Request(url, {
    ...init,
    headers: {
      "user-agent": CHROME,
      "x-forwarded-for": "203.0.113.7",
      ...headers,
    },
  });

export const html = (status = 200, headers: Record<string, string> = {}) =>
  new Response("<html></html>", {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });

export type Row = {
  id: number;
  occurred_at: Date;
  name: string;
  source: string;
  route: string | null;
  method: string | null;
  status: number | null;
  authenticated: boolean;
  referrer_host: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  device: string;
  browser: string;
  visitor_hash: string;
  props: Record<string, unknown>;
};

export const events = async (): Promise<Row[]> =>
  [...(await db`SELECT * FROM analytics_event ORDER BY id`)] as Row[];

/**
 * The endpoint answers before its write lands. Poll until `expected` rows
 * exist, then give a stray extra write a moment to show up too.
 */
export const waitForRows = async <T>(
  read: () => Promise<T[]>,
  expected: number,
  timeoutMs = 1000,
): Promise<T[]> => {
  const deadline = Date.now() + timeoutMs;
  let rows = await read();
  while (rows.length < expected && Date.now() < deadline) {
    await Bun.sleep(10);
    rows = await read();
  }
  await Bun.sleep(30);
  return read();
};
