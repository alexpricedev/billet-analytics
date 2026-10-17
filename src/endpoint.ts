import { normalizePath } from "./classify";

// Beacons from the client `send()`. No CSRF token: sendBeacon can't set
// headers, there is no session to ride, and all this can do is append an
// allow-listed, anonymous event. Same-origin and a rate limit keep it honest.
// It always answers 204 so it gives a scripted caller nothing to probe, and
// answers without waiting for the write: nobody reads the reply.

export interface EndpointOptions {
  /** Beacons per client per window. Default 60. */
  maxRequests?: number;
  /** Default 60 000 (one minute). */
  windowMs?: number;
  /** A real beacon is a few hundred bytes. Default 2048. */
  maxBodyBytes?: number;
}

export const DEFAULT_MAX_BODY_BYTES = 2048;

/** The most clients the rate limiter remembers at once. */
export const MAX_TRACKED_CLIENTS = 10_000;

interface HandlerDeps<N extends string> {
  options: EndpointOptions | undefined;
  /** The site's public origin, already parsed. */
  siteOrigin: string | null;
  clientIp: (req: Request) => string;
  accepts: (name: unknown) => name is N;
  record: (
    req: Request,
    name: N,
    route: string | null,
    props: unknown,
  ) => Promise<void>;
  onError: (message: string, error: unknown) => void;
}

const noContent = () => new Response(null, { status: 204 });

// Its own in-memory budget, so beacons never spend a form's rate limit. One
// sweep per window keeps the map from growing with every address seen, and a
// hard cap (oldest client out first) bounds it within a window too.
const createLimiter = (maxRequests: number, windowMs: number) => {
  const log = new Map<string, number[]>();
  let lastSweep = Date.now();
  return (key: string): boolean => {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [k, times] of log) {
        if (times.every((t) => now - t >= windowMs)) log.delete(k);
      }
      lastSweep = now;
    }
    const recent = (log.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= maxRequests) return true;
    recent.push(now);
    log.delete(key);
    if (log.size >= MAX_TRACKED_CLIENTS) {
      log.delete(log.keys().next().value as string);
    }
    log.set(key, recent);
    return false;
  };
};

// Reads at most `maxBytes` of the body, counting bytes rather than characters,
// and stops reading as soon as it passes the cap. Null when it's too big.
const readCapped = async (
  req: Request,
  maxBytes: number,
): Promise<string | null> => {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
};

/** Throws a clear config error when `siteUrl` isn't an absolute URL. */
export const parseSiteOrigin = (siteUrl: string | undefined): string | null => {
  if (!siteUrl) return null;
  try {
    return new URL(siteUrl).origin;
  } catch {
    throw new Error(
      `billet-analytics: siteUrl (or APP_URL) must be an absolute URL, got "${siteUrl}"`,
    );
  }
};

export const createEventsHandler = <N extends string>(deps: HandlerDeps<N>) => {
  const maxBodyBytes = deps.options?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const limited = createLimiter(
    deps.options?.maxRequests ?? 60,
    deps.options?.windowMs ?? 60_000,
  );

  const sameOrigin = (req: Request): boolean => {
    const site = req.headers.get("sec-fetch-site");
    if (site) return site === "same-origin";
    const origin = req.headers.get("origin");
    if (!origin) return false;
    return origin === new URL(req.url).origin || origin === deps.siteOrigin;
  };

  const handle = async (req: Request): Promise<void> => {
    if (req.method !== "POST") return;
    if (!sameOrigin(req)) return;
    if (limited(deps.clientIp(req))) return;
    if (Number(req.headers.get("content-length")) > maxBodyBytes) return;

    let body: { name?: unknown; props?: unknown; path?: unknown };
    try {
      const text = await readCapped(req, maxBodyBytes);
      if (text === null) return;
      body = JSON.parse(text) as typeof body;
    } catch {
      return;
    }
    if (typeof body !== "object" || body === null) return;
    if (!deps.accepts(body.name)) return;

    void deps.record(
      req,
      body.name,
      typeof body.path === "string" ? normalizePath(body.path) : null,
      body.props,
    );
  };

  return async (req: Request): Promise<Response> => {
    try {
      await handle(req);
    } catch (err) {
      // A throwing onError mustn't break "always 204", so its own error is dropped.
      try {
        deps.onError("Events endpoint failed", err);
      } catch {}
    }
    return noContent();
  };
};
