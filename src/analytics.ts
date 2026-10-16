import { createHash, randomBytes } from "node:crypto";
import type { SQL } from "bun";
import {
  classifyUserAgent,
  forwardedClientIp,
  isBot,
  isPrefetch,
  normalizePath,
  notFoundBucket,
  referrerHost,
  utm,
} from "./classify";
import { createEventsHandler, type EndpointOptions } from "./endpoint";
import {
  type BuiltInEvents,
  type EventProps,
  type EventRegistry,
  mergeRegistry,
  type PropsOf,
  sanitizeProps,
} from "./events";
import { createReport } from "./report";
import {
  assertTimeZone,
  localDay,
  type Rounding,
  roundTimestamp,
  startOfDay,
} from "./time";

// First-party, anonymous analytics. With the defaults nothing written here
// identifies a person: no cookie, no IP, no user agent, no user id. A visitor
// is a hash of (daily salt, IP, user agent); the salt is deleted once its day
// ends, so hashes cannot be reversed or linked across days. See the README's
// "What it collects" before changing a default.

type MaybePromise<T> = T | Promise<T>;

export interface AnalyticsConfig<E extends EventRegistry = EventRegistry> {
  /** The app's Bun SQL instance (Billet's `db`). */
  db: SQL;
  /** The site's own events, from `defineEvents`. The four automatic events are built in. */
  events?: E;
  /** True to drop the request's events entirely (e.g. platform admins). Default: nobody. */
  exclude?: (req: Request) => MaybePromise<boolean>;
  /** Fills the `authenticated` column. Must not create a session. Default: false. */
  authenticated?: (req: Request) => MaybePromise<boolean>;
  /**
   * Replaces the daily-salted hash. Whatever it returns is stored as the
   * visitor id, so a stable id makes visitors linkable across days and, if
   * it is kept on the device, needs consent.
   */
  visitorId?: (req: Request) => MaybePromise<string>;
  /** The caller's address, for the default hash and the endpoint's rate limit. Default: the last X-Forwarded-For entry. */
  clientIp?: (req: Request) => string;
  /** Default 13. */
  retentionMonths?: number;
  /** Default "hour". */
  roundTimestamps?: Rounding;
  /** The day the salt rotates on and the read side buckets by. Default "Europe/London". */
  timeZone?: string;
  /** Exact routes that are never visits. Replaces the default list. */
  untrackedRoutes?: Iterable<string>;
  /** Routes whose handler ends or swaps the session; `beginRequest` reads the request before them. */
  sessionChangingRoutes?: Iterable<string>;
  /** The site's public origin, for internal referrers and the endpoint's origin check. Default: APP_URL. */
  siteUrl?: string;
  /** Default: off under NODE_ENV=test, on otherwise. */
  enabled?: boolean;
  endpoint?: EndpointOptions;
  /** Where failures are reported. Analytics never throws into a request. Default: console.error. */
  onError?: (message: string, error: unknown) => void;
}

/** Machine endpoints and static files are not visits. */
export const DEFAULT_UNTRACKED_ROUTES: readonly string[] = [
  "/robots.txt",
  "/sitemap.xml",
  "/llms.txt",
  "/site.webmanifest",
  "/.well-known/security.txt",
  "/health",
  "/api/events",
];

/** Billet's routes that end or swap the session. */
export const DEFAULT_SESSION_CHANGING_ROUTES: readonly string[] = [
  "/auth/logout",
  "/auth/callback",
  "/invites/accept",
];

export interface RequestContext {
  excluded: boolean;
  visitorHash: string;
  authenticated: boolean;
  referrerHost: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  device: string;
  browser: string;
}

export interface RecordInput<N extends string = string> {
  name: N;
  source: "server" | "client";
  route?: string | null;
  method?: string | null;
  status?: number | null;
  /** Untrusted until sanitizeProps checks it against the event's allow-list. */
  props?: unknown;
}

export const visitorHash = (
  salt: string,
  ip: string,
  userAgent: string,
): string =>
  createHash("sha256")
    .update(`${salt}|${ip}|${userAgent}`)
    .digest("hex")
    .slice(0, 32);

const isHtml = (res: Response): boolean =>
  (res.headers.get("content-type") ?? "").includes("text/html");

const formOutcome = (status: number) =>
  status === 429
    ? "rate_limited"
    : status >= 300 && status < 400
      ? "redirect"
      : status >= 400
        ? "error"
        : "ok";

const defaultOnError = (message: string, error: unknown): void => {
  console.error(`[analytics] ${message}: ${String(error)}`);
};

export const createAnalytics = <
  const E extends EventRegistry = Record<never, never>,
>(
  config: AnalyticsConfig<E>,
) => {
  type Registry = BuiltInEvents & E;
  type Name = keyof Registry & string;

  const { db } = config;
  const registry: Registry = mergeRegistry(config.events ?? ({} as E));
  const timeZone = config.timeZone ?? "Europe/London";
  assertTimeZone(timeZone);
  const rounding = config.roundTimestamps ?? "hour";
  const retentionMonths = config.retentionMonths ?? 13;
  if (!Number.isInteger(retentionMonths) || retentionMonths < 1) {
    throw new Error("billet-analytics: retentionMonths must be a whole number");
  }
  const untracked = new Set(config.untrackedRoutes ?? DEFAULT_UNTRACKED_ROUTES);
  const sessionChanging = new Set(
    config.sessionChangingRoutes ?? DEFAULT_SESSION_CHANGING_ROUTES,
  );
  const siteUrl = config.siteUrl ?? process.env.APP_URL;
  const clientIp = config.clientIp ?? forwardedClientIp;
  const onError = config.onError ?? defaultOnError;
  let enabled = config.enabled ?? process.env.NODE_ENV !== "test";

  const isEventName = (name: unknown): name is Name =>
    typeof name === "string" && Object.hasOwn(registry, name);

  const isClientEvent = (name: Name): boolean =>
    registry[name].source === "client";

  // ─── Daily salt ────────────────────────────────────────────────────────────

  let saltCache: { day: string; salt: string } | null = null;

  const getDailySalt = async (now = new Date()): Promise<string> => {
    const day = localDay(timeZone, now);
    if (saltCache?.day === day) return saltCache.salt;
    const candidate = randomBytes(32).toString("hex");
    await db`
      INSERT INTO analytics_salt (day, salt) VALUES (${day}, ${candidate})
      ON CONFLICT (day) DO NOTHING
    `;
    const [row] = await db`SELECT salt FROM analytics_salt WHERE day = ${day}`;
    const salt = (row as { salt: string }).salt;
    saltCache = { day, salt };
    return salt;
  };

  // ─── Per-request context ───────────────────────────────────────────────────

  const contexts = new WeakMap<Request, Promise<RequestContext | null>>();

  const buildContext = async (req: Request): Promise<RequestContext | null> => {
    const userAgent = req.headers.get("user-agent");
    if (isBot(userAgent) || isPrefetch(req)) return null;

    const [excluded, authenticated, visitor] = await Promise.all([
      config.exclude?.(req) ?? false,
      config.authenticated?.(req) ?? false,
      config.visitorId
        ? config.visitorId(req)
        : getDailySalt().then((salt) =>
            visitorHash(salt, clientIp(req), userAgent ?? ""),
          ),
    ]);

    const url = new URL(req.url);
    const { device, browser } = classifyUserAgent(userAgent);
    return {
      excluded,
      visitorHash: visitor,
      authenticated,
      referrerHost: referrerHost(req, siteUrl),
      utmSource: utm(url, "utm_source"),
      utmMedium: utm(url, "utm_medium"),
      utmCampaign: utm(url, "utm_campaign"),
      device,
      browser,
    };
  };

  // Memoised per request. Built on first use, which for most requests is after
  // the handler, so requests that record nothing never pay for the lookup.
  // beginRequest starts it early on the routes that end or swap the session.
  const requestContext = (req: Request): Promise<RequestContext | null> => {
    let ctx = contexts.get(req);
    if (!ctx) {
      ctx = buildContext(req).catch((err) => {
        onError("Context failed", err);
        return null;
      });
      contexts.set(req, ctx);
    }
    return ctx;
  };

  /**
   * Drop this request's events from now on. For a handler that learns
   * mid-request that the caller is excluded, e.g. an admin signing in.
   */
  const markExcluded = (req: Request): void => {
    const ctx = requestContext(req).then((c) => c && { ...c, excluded: true });
    contexts.set(req, ctx);
  };

  // ─── Recording ─────────────────────────────────────────────────────────────

  const insertEvent = async (
    ctx: RequestContext,
    input: RecordInput,
  ): Promise<void> => {
    // Bound as text and cast, so a guarded pool that refuses plain objects
    // (Billet's) still accepts it, and it lands as a jsonb object.
    const props = JSON.stringify(
      sanitizeProps(registry, input.name, input.props ?? {}),
    );
    await db`
      INSERT INTO analytics_event (
        occurred_at, name, source, visitor_hash, route, method, status, authenticated,
        referrer_host, utm_source, utm_medium, utm_campaign, device, browser, props
      ) VALUES (
        ${roundTimestamp(rounding).toISOString()}, ${input.name}, ${input.source}, ${ctx.visitorHash},
        ${input.route ?? null}, ${input.method ?? null}, ${input.status ?? null}, ${ctx.authenticated},
        ${ctx.referrerHost}, ${ctx.utmSource}, ${ctx.utmMedium}, ${ctx.utmCampaign},
        ${ctx.device}, ${ctx.browser}, ${props}::text::jsonb
      )
    `;
  };

  /** Best-effort: never throws into a request. Unknown event names are dropped. */
  const recordEvent = async (
    req: Request,
    input: RecordInput,
  ): Promise<void> => {
    if (!enabled || !isEventName(input.name)) return;
    try {
      const ctx = await requestContext(req);
      if (!ctx || ctx.excluded) return;
      await insertEvent(ctx, input);
    } catch (err) {
      onError(`Failed to record ${input.name}`, err);
    }
  };

  /** A named domain event, attributed to the path that emitted it. */
  const track = <N extends Name>(
    req: Request,
    name: N,
    props?: PropsOf<Registry[N]>,
  ): Promise<void> => {
    const route = normalizePath(new URL(req.url).pathname);
    return recordEvent(req, { name, source: "server", route, props });
  };

  const isTrackable = (req: Request, route: string | null): boolean => {
    if (!enabled || req.method === "HEAD") return false;
    if (route) return !untracked.has(route);
    const pathname = new URL(req.url).pathname;
    return !untracked.has(pathname) && !pathname.startsWith("/assets/");
  };

  /**
   * Turn one finished request into at most one event. `route` is the matched
   * route pattern (e.g. "/projects/:id"), or null for the fallback handler.
   */
  const captureRequest = async (
    req: Request,
    route: string | null,
    res: Response,
  ): Promise<void> => {
    if (!isTrackable(req, route)) return;

    const base = {
      source: "server" as const,
      method: req.method,
      status: res.status,
    };

    const failure =
      res.status >= 500
        ? "server_error"
        : res.status === 404
          ? "not_found"
          : null;
    if (failure) {
      await recordEvent(req, {
        ...base,
        name: failure,
        route: route ?? notFoundBucket(new URL(req.url).pathname),
      });
      return;
    }
    if (!route) return;

    if (req.method === "GET" && res.status === 200 && isHtml(res)) {
      await recordEvent(req, { ...base, name: "page_view", route });
      return;
    }
    if (req.method === "POST") {
      const location = res.headers.get("location");
      await recordEvent(req, {
        ...base,
        name: "form_submit",
        route,
        props: {
          outcome: formOutcome(res.status),
          ...(location ? { target: normalizePath(location) } : {}),
        },
      });
    }
  };

  /** Start the context lookup before the handler on routes that change the session. */
  const beginRequest = (req: Request, route: string | null): void => {
    if (route && sessionChanging.has(route) && isTrackable(req, route)) {
      void requestContext(req);
    }
  };

  // ─── Retention ─────────────────────────────────────────────────────────────

  // Month arithmetic in Postgres: 31 March minus 13 months is 28 February, not
  // the "31 February" that rolls forward into March in JavaScript. Run it at
  // least daily: the salt is only gone once this has run after midnight.
  const purgeExpired = async (now = new Date()): Promise<void> => {
    await db`
      DELETE FROM analytics_event
      WHERE occurred_at < ${now.toISOString()}::timestamptz - make_interval(months => ${retentionMonths}::int)
    `;
    await db`DELETE FROM analytics_salt WHERE day < ${localDay(timeZone, now)}`;
  };

  const handleEvents = createEventsHandler({
    options: config.endpoint,
    siteUrl,
    clientIp,
    accepts: (name): name is Name => isEventName(name) && isClientEvent(name),
    record: (req, name, route, props) =>
      recordEvent(req, { name, source: "client", route, props }),
  });

  return {
    /** The merged registry: the built-in events plus the site's own. */
    events: registry,
    timeZone,
    track,
    recordEvent,
    captureRequest,
    beginRequest,
    markExcluded,
    /** POST handler for the events endpoint. Always answers 204. */
    handleEvents,
    purgeExpired,
    report: createReport(db, timeZone),
    /** Start of the local day `daysBack` days before `now`'s, in the configured zone. */
    startOfDay: (now = new Date(), daysBack = 0) =>
      startOfDay(timeZone, now, daysBack),
    sanitizeProps: (name: string, input: unknown): EventProps =>
      sanitizeProps(registry, name, input),
    isEventName,
    getDailySalt,
    /** Clear the in-memory salt so the next event reads it from the table again. */
    resetSaltCache: (): void => {
      saltCache = null;
    },
    setEnabled: (value: boolean): void => {
      enabled = value;
    },
  };
};

export type Analytics<E extends EventRegistry = EventRegistry> = ReturnType<
  typeof createAnalytics<E>
>;
