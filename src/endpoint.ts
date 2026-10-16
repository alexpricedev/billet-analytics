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

interface HandlerDeps<N extends string> {
  options: EndpointOptions | undefined;
  siteUrl: string | undefined;
  clientIp: (req: Request) => string;
  accepts: (name: unknown) => name is N;
  record: (
    req: Request,
    name: N,
    route: string | null,
    props: unknown,
  ) => Promise<void>;
}

const noContent = () => new Response(null, { status: 204 });

// Its own in-memory budget, so beacons never spend a form's rate limit. One
// sweep per window keeps the map from growing with every address seen.
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
    log.set(key, recent);
    return false;
  };
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
    const allowed = [new URL(req.url).origin];
    if (deps.siteUrl) allowed.push(new URL(deps.siteUrl).origin);
    return allowed.includes(origin);
  };

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return noContent();
    if (!sameOrigin(req)) return noContent();
    if (limited(deps.clientIp(req))) return noContent();
    if (Number(req.headers.get("content-length")) > maxBodyBytes) {
      return noContent();
    }

    let body: { name?: unknown; props?: unknown; path?: unknown };
    try {
      const text = await req.text();
      if (text.length > maxBodyBytes) return noContent();
      body = JSON.parse(text) as typeof body;
    } catch {
      return noContent();
    }
    if (typeof body !== "object" || body === null) return noContent();
    if (!deps.accepts(body.name)) return noContent();

    void deps.record(
      req,
      body.name,
      typeof body.path === "string" ? normalizePath(body.path) : null,
      body.props,
    );
    return noContent();
  };
};
