# @alexpricedev/billet-analytics

First-party, cookie-free, anonymous-by-default analytics for Billet apps. Bun + Postgres, no third party, nothing stored on the device. It records page views, form submits, 404s, 500s and the domain events you name, into two tables your app owns. There's no dashboard: you query the data with a few read helpers and build your own report.

Every default can be changed through config.

## Copy this to your coding agent

Paste this into your agent (Claude Code, Cursor, etc.):

```text
Install and wire up @alexpricedev/billet-analytics in this Billet app.

1. Read the package README first:
   https://github.com/alexpricedev/billet-analytics#readme.
   Follow its "Wire up a Billet app" section, steps 1 to 6. Adapt the
   snippets to this repo's file names and signatures where they differ;
   don't paste blindly.

2. Read this repo's CLAUDE.md or AGENTS.md and follow its conventions
   (logger, lint rules, where tests go, the guarded db pool). They
   override anything generic in the package README.

3. Keep the defaults: no visitorId override, timestamps to the hour,
   13-month retention. Exclude platform admins. Read the session
   read-only: analytics must never create a guest session.

4. Add only the domain events the task asks for to defineEvents, each
   with typed props. Don't add free-text props.

5. Add tests: a request through the guarded pipeline writes one
   page_view row (switch analytics on in that test with
   analytics.setEnabled(true)), an admin's request writes none, and
   POST /api/events records a client event. Run the repo's check and
   test scripts.

6. If the repo has a privacy page or runbooks/PRIVACY.md, add a short
   section describing what is collected, adapted from the package
   README's "What it collects".

7. Open a PR. Check `git log` for the repo's commit convention first.

Out of scope: dashboards or admin pages, client auto-tracking, and
changing any privacy default.
```

## For AI agents

- **Package**: `@alexpricedev/billet-analytics`
- **Install**: `bun add github:alexpricedev/billet-analytics#v0.2.0` (not on npm yet — pin the tag, see [Install and add the migration](#1-install-and-add-the-migration))
- **Runtime**: Bun ≥ 1.2, PostgreSQL. Uses Bun's `SQL`; no other dependencies.
- **Exports**: `.` (server), `./client` (browser `send()`, `createClient`), `./events` (`defineEvents`, browser-safe), `./migration` (`up`/`down`)
- **Tables**: `analytics_event`, `analytics_salt`, created by the package's migration
- **Side effects**: none at import. `createAnalytics()` only validates config; nothing is written until a request is recorded.
- **Off in tests**: disabled when `NODE_ENV=test` unless `enabled: true` or `setEnabled(true)`
- **Verify install**: after a page load, `SELECT name, route FROM analytics_event` shows a `page_view`

## What it collects

With the defaults, every rule below holds, which is why no consent banner is needed for it. Under PECR/ePrivacy, consent is about storing or reading information on the device for a non-essential purpose, and this does neither. Under GDPR the short-lived visitor hash is pseudonymous for one day, which a site can rely on legitimate interests for. Say so in your privacy policy.

- **Nothing touches the device.** No cookie, no `localStorage`, no client-generated id. Your session cookie may be *read* (through your `authenticated` and `exclude` callbacks) to tell signed-in from guest and to drop admin traffic, but analytics never writes it or stores it.
- **Visitor ids expire.** `visitor_hash` = sha256(daily salt ‖ IP ‖ user agent), cut to 32 hex characters. Only today's salt (in the configured time zone) is kept in `analytics_salt`. `purgeExpired()` deletes it on its first run after midnight, and after that no one can recompute or link a hash. Visitors can't be linked across days or devices.
- **Nothing identifying is written.** No raw IP, no user agent (only coarse `device` and `browser` labels), no user id, and no query string except `utm_source`, `utm_medium` and `utm_campaign` (lowercased, each in its own column, dropped unless they pass `SAFE_STRING`). The referrer is cut to its host. Routes are stored as patterns (`/projects/:id`). Every prop is checked against the event's allow-list: strings must match `SAFE_STRING` (`[\w .:/+-]`, 1–80 characters), which has no `@`, so an email address can't get in.
- **Every event is stored to the hour.** Domain events happen at the same moment as a write to an account table, and the page view after each redirect lands a moment later, so an exact time would let the two be joined and that day's hash tied to a person.
- **Never order events within an hour.** The `id` sequence still records insert order. Group and count by hour or coarser. Never show or export events in id order, and never add a finer-grained timestamp column.
- **Retention is 13 months**, enforced by `purgeExpired()`.
- **Bots, prefetches and HEAD requests are dropped**, and whoever `exclude` names (e.g. platform admins) is dropped at write time.

### What overriding a default changes

| Override | Effect on the rules above |
|---|---|
| `visitorId` | Whatever it returns is stored as given. A stable id (a user id, a cookie value) makes visitors linkable across days and is personal data; if it is read from or stored on the device, it needs **consent**. |
| `roundTimestamps: "none"` | Exact times can be joined to account writes. Treat the events as personal data. `"day"` is coarser than the default and safe. |
| `retentionMonths` | Shorter is always fine. Longer needs a reason in your privacy policy. |
| A `"string"` prop | Free text, filtered only by `SAFE_STRING`. Prefer an enum list (`["hero", "pricing"]`) so a stray value can't carry typed text. |
| `authenticated` / `exclude` | Only booleans are stored. Never let them write a session or a cookie. |

If a change breaks a rule (a client id, a third-party script, free-text props from user input), it now needs a consent banner (see [`@alexpricedev/billet-cookie-consent`](https://github.com/alexpricedev/billet-cookie-consent)) and a policy update.

## Wire up a Billet app

Paths below are Billet's. Adapt them where your app differs.

### 1. Install and add the migration

```bash
bun add github:alexpricedev/billet-analytics#v0.2.0
```

Pin the tag. Without `#v0.2.0` the dependency tracks `main`, so `bun install` on a fresh checkout can pull a different version than the one you tested. Releases are tagged `vX.Y.Z` ([all tags](https://github.com/alexpricedev/billet-analytics/tags)); bump the tag deliberately and read [CHANGELOG.md](CHANGELOG.md).

Add one file to `src/server/database/migrations/` (name it with today's timestamp):

```ts
// src/server/database/migrations/20261016000000_create_analytics.ts
export { down, up } from "@alexpricedev/billet-analytics/migration";
```

Billet runs migrations on boot, so the tables appear on the next start (and before `bun run test`).

### 2. Create the analytics service

```ts
// src/server/services/analytics.ts
import { createAnalytics } from "@alexpricedev/billet-analytics";
import type { BunRequest } from "bun";
import { clientKey } from "../middleware/client-ip";
import { EVENTS } from "../../shared/analytics-events";
import { db } from "./database";
import { log } from "./logger";
import {
  getSessionContextFromDB,
  getSessionIdFromRequest,
  type SessionContext,
} from "./sessions";

// Read-only lookup, once per request: getSessionContext would mint a guest
// session, and analytics must never create one. The `fetch` fallback (404s)
// gets a plain Request with no `.cookies`, so only routed requests are read.
const sessions = new WeakMap<Request, Promise<SessionContext | null>>();
const sessionFor = (req: Request): Promise<SessionContext | null> => {
  let lookup = sessions.get(req);
  if (!lookup) {
    const id = "cookies" in req ? getSessionIdFromRequest(req as BunRequest) : null;
    lookup = id ? getSessionContextFromDB(id) : Promise.resolve(null);
    sessions.set(req, lookup);
  }
  return lookup;
};

export const analytics = createAnalytics({
  db,
  events: EVENTS, // src/shared/analytics-events.ts — see step 5
  clientIp: clientKey,
  authenticated: async (req) => (await sessionFor(req))?.isAuthenticated ?? false,
  exclude: async (req) => (await sessionFor(req))?.user?.role === "admin",
  onError: (message, err) => log.error("analytics", `${message}: ${String(err)}`),
});
```

`clientKey` is Billet's rate-limit key: the socket address, or the last `X-Forwarded-For` hop when `TRUST_PROXY=true`. Pass whatever your app trusts.

Without `clientIp`, the package uses the last `X-Forwarded-For` entry. That is only safe behind a proxy that appends the caller's address (Railway, Fly, most load balancers). With no proxy, a caller can send any `X-Forwarded-For` they like, which gets round the endpoint's rate limit and splits one visitor into many; with no header at all, every caller shares one budget. In either case pass a `clientIp` that reads the socket address.

#### On an older Billet fork

`clientKey` and `runCleanupSweep` (step 6) are recent Billet helpers. An older fork has neither. Both have a short standalone replacement.

For `clientIp`, read the socket address from the server. Bun exposes it through `server.requestIP(req)`, so keep the server on the module and look it up per request:

```ts
// src/server/services/client-ip.ts
import type { Server } from "bun";

let server: Server | null = null;

/** Call once, straight after Bun.serve(). */
export const setServer = (value: Server): void => {
  server = value;
};

export const clientKey = (req: Request): string =>
  server?.requestIP(req)?.address ??
  req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ??
  "unknown";
```

```ts
// main.ts
const server = Bun.serve({ /* ... */ });
setServer(server);
```

Behind a proxy that appends the caller's address, keep using the default (drop `clientIp` entirely) — the socket address there is the proxy's, which puts every visitor in one bucket.

### 3. Capture every routed request

In `src/server/utils/security-headers.ts`, give `handleGuarded` the route pattern, start the context before the handler, and capture the response after it. Capture is fire-and-forget and never throws.

```ts
import { analytics } from "../services/analytics";

export const handleGuarded = async <R extends Request>(
  req: R,
  produce: (req: R) => Response | Promise<Response>,
  route: string | null = null,
): Promise<Response> => {
  const maintenance = maintenanceResponse(req);
  if (maintenance) return finalizeResponse(req, maintenance);

  const failed = (error: unknown): Response => {
    const { pathname } = new URL(req.url);
    log.error("server", `Unhandled error on ${req.method} ${pathname}: ${error}`);
    return render500();
  };

  analytics.beginRequest(req, route);
  let res: Response;
  try {
    res = await produce(req);
  } catch (error) {
    res = failed(error);
  }
  void analytics.captureRequest(req, route, res);

  try {
    return await finalizeResponse(req, res);
  } catch (error) {
    return finalizeResponse(req, failed(error));
  }
};

export const secureRoutes = <T extends Record<string, RouteHandler>>(routes: T): T => {
  const wrapped: Record<string, RouteHandler> = {};
  for (const [path, handler] of Object.entries(routes)) {
    wrapped[path] = (req) => handleGuarded(req, handler, path);
  }
  return wrapped as T;
};
```

The `fetch` fallback in `main.ts` keeps calling `handleGuarded(req, handleFallback)`, so its route is `null`: 404s are grouped by first path segment and `/assets/*` is ignored.

`beginRequest` reads the session *before* the handler on the routes in `sessionChangingRoutes` (default Billet's `/auth/logout`, `/auth/callback`, `/invites/accept`), so a sign-out still counts as signed in. On every other route it's read after the handler, only if something is recorded.

Record domain events from controllers:

```ts
void analytics.track(req, "signup_requested");
void analytics.track(req, "magic_link_verified", { new_user: true });
```

`track` is typed from your registry: an unknown name or a prop outside its allow-list fails `bun run typecheck`, and is dropped at runtime anyway. When a handler learns mid-request that the caller is excluded (an admin signing in), call `analytics.markExcluded(req)` before tracking.

### 4. Mount the events endpoint

```ts
// src/server/routes/api.ts
import { analytics } from "../services/analytics";

export const apiRoutes = {
  // ...
  "/api/events": createApiRouteHandler({ POST: analytics.handleEvents }),
};
```

It only accepts events registered with `source: "client"`, reports every drop through `onDrop` (see [When a beacon vanishes](#when-a-beacon-vanishes)), checks the request is same-origin (`Sec-Fetch-Site`, or `Origin` against the request and `siteUrl`), rate limits each client (60 a minute, its own budget, remembering at most 10,000 clients), caps the body at 2 KB (counted in bytes as it streams in) and always answers 204 without waiting for the write. There's no CSRF token: `sendBeacon` can't set headers, and all it can do is append an allow-listed, anonymous event.

### 5. Send client events

Move the registry into its own file so the browser can import it without pulling in the server:

```ts
// src/shared/analytics-events.ts
import { defineEvents } from "@alexpricedev/billet-analytics/events";

export const EVENTS = defineEvents({
  signup_requested: { source: "server" },
  magic_link_verified: { source: "server", props: { new_user: "boolean" } },
  cta_click: { source: "client", label: "CTA click", props: { id: ["hero", "pricing"] } },
});
```

`src/server/services/analytics.ts` then imports `EVENTS` from there and passes it to `createAnalytics`, and the browser gets a `send` checked against it:

```ts
import { createClient } from "@alexpricedev/billet-analytics/client";
import type { EVENTS } from "../shared/analytics-events";

const analytics = createClient<typeof EVENTS>();

for (const el of document.querySelectorAll<HTMLElement>("[data-cta]")) {
  el.addEventListener("click", () => analytics.send("cta_click", { id: el.dataset.cta ?? "" }));
}
```

`createClient<typeof EVENTS>()` fails `bun run typecheck` on an unknown name, a `source: "server"` event, or a prop outside its allow-list — the mistakes the endpoint would otherwise drop in silence. `./events` imports nothing from Bun, so it is safe in a browser bundle.

The untyped `send(name, props, { endpoint })` is still exported for a page with no registry to hand. Both post one beacon (falling back to a keepalive `fetch`), never throw, and store nothing in the browser. Each beacon also carries the page's path, `utm_source`/`utm_medium`/`utm_campaign` and `document.referrer`, so a click is attributed to the campaign that brought the visitor; all three are re-sanitised server-side exactly as a page view's are. In Billet's client tiers this is presentation-only: it changes no state the server owns.

#### When a beacon vanishes

The endpoint answers 204 for everything, so a drop is invisible to the browser by design. Outside `NODE_ENV=production` and `test` the server prints the reason instead:

```
[analytics] dropped a client event: "cta_clik" is not a registered client event
[analytics] dropped a client event: not same-origin
```

Route them to your logger (or silence them) with `onDrop`:

```ts
onDrop: (reason) => log.warn("analytics", `Dropped a client event: ${reason}`),
```

### 6. Purge on the housekeeping sweep

Add the purge to `runCleanupSweep` in `src/server/services/cleanup.ts`, which Billet runs hourly. It must run at least once a day for yesterday's salt to be deleted.

```ts
import { analytics } from "./analytics";

export const runCleanupSweep = async (): Promise<void> => {
  await cleanupExpired();
  await analytics.purgeExpired();
  // ...
};
```

If your fork has no `runCleanupSweep`, a timer on the server module does the same job. Run it on boot and hourly; `purgeExpired` is idempotent, so a missed or doubled run costs nothing.

```ts
// src/server/services/analytics-purge.ts
import { analytics } from "./analytics";
import { log } from "./logger";

const HOURLY = 60 * 60 * 1000;

const purge = () =>
  analytics
    .purgeExpired()
    .catch((err) => log.error("analytics", `Purge failed: ${String(err)}`));

/** Call once on boot. */
export const startAnalyticsPurge = (): (() => void) => {
  void purge();
  const timer = setInterval(purge, HOURLY);
  // Don't hold the process open in tests or a one-off script.
  timer.unref?.();
  return () => clearInterval(timer);
};
```

In a multi-instance deploy every instance runs it, which is harmless: the deletes are the same rows. Under `NODE_ENV=test`, don't start it.

### Tests

Analytics is off when `NODE_ENV=test`. A test that asserts on it switches it on and back off:

```ts
beforeEach(() => analytics.setEnabled(true));
afterEach(() => analytics.setEnabled(false));
```

Capture is fire-and-forget: `handleGuarded` doesn't await `captureRequest`, and the events endpoint answers before its write lands. So a test that makes a request and then reads `analytics_event` straight away can miss the row. Either call `captureRequest` (or `track`) yourself and await it, or poll for the row:

```ts
const waitForEvent = async (name: string, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db`SELECT * FROM analytics_event WHERE name = ${name}`;
    if (row) return row;
    await Bun.sleep(10);
  }
  throw new Error(`No ${name} event within ${timeoutMs}ms`);
};
```

The package binds every value as a primitive (props go in as text and are cast to `jsonb`), so it works through Billet's guarded `db` pool unchanged.

## Config

`createAnalytics(config)` takes the app's Bun `SQL` instance and these options. Every default can be changed through config.

| Option | Default | Change when |
|---|---|---|
| `db` | _required_ | Always: your app's `SQL` instance |
| `events` | none (the four built-ins only) | You have domain or client events. Use `defineEvents`. |
| `exclude(req)` | nobody | Drop staff, admins or test accounts at write time |
| `authenticated(req)` | `false` | You want signed-in vs guest. Must not create a session. |
| `visitorId(req)` | daily-salted hash of IP + UA | Rarely. See "What overriding a default changes". |
| `clientIp(req)` | last `X-Forwarded-For` entry (only safe behind an appending proxy) | Your app has its own trusted IP source (Billet's `clientKey`), or runs without a proxy |
| `retentionMonths` | `13` | A shorter (or justified longer) retention |
| `roundTimestamps` | `"hour"` | `"day"` for coarser; `"none"` only with a privacy reason |
| `timeZone` | `"Europe/London"` | The site's audience lives elsewhere. Moves the salt day and report buckets. |
| `untrackedRoutes` | `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/site.webmanifest`, `/.well-known/security.txt`, `/health`, `/api/events` | Your machine endpoints differ, or you mounted the endpoint elsewhere. Replaces the list. |
| `sessionChangingRoutes` | `/auth/logout`, `/auth/callback`, `/invites/accept` | Your sign-in and sign-out routes differ. Replaces the list. |
| `siteUrl` | `process.env.APP_URL` | The public origin differs from `APP_URL` |
| `enabled` | off under `NODE_ENV=test` | Force on or off. `setEnabled()` flips it later. |
| `endpoint` | `{ maxRequests: 60, windowMs: 60000, maxBodyBytes: 2048 }` | Your beacons are bigger or busier |
| `onError(message, err)` | `console.error` | Route failures to your logger |
| `onDrop(reason, req)` | `console.warn`, off under `NODE_ENV` `production` and `test` | Route dropped client events to your logger, or pass `() => {}` to silence them |

### Events

```ts
export const EVENTS = defineEvents({
  project_created: {
    source: "server",
    label: "Project created", // what a report shows
    props: { kind: ["solar", "wind"], count: "number" },
  },
  report_printed: { source: "client" },
});
```

A prop is `"string"` (must pass `SAFE_STRING`), `"number"` (finite), `"boolean"`, or a list of allowed strings. Anything else, and any key not listed, is dropped before it's written. `source: "client"` events may arrive through the endpoint; `"server"` ones never do. The built-in `page_view`, `form_submit` (`outcome`, `target`), `not_found` and `server_error` can't be redefined.

`label` is presentation only. The name stays the identifier a beacon sends and the column stores, so changing a label needs no migration and never touches stored rows. Leave it out and the name is humanised (`signup_requested` → "Signup requested"); set it when that split would read wrong (`cta_click` → "CTA click"). `analytics.lexicon` is the whole mapping, built-ins included, for a report to name an event without a query:

```ts
analytics.lexicon.page_view; // "Page view"
analytics.lexicon.signup_requested; // "Signup requested"
```

`captureRequest` turns a finished request into at most one event: a `page_view` for a routed `GET` answering 200 HTML, a `form_submit` for a routed `POST` (outcome `ok`, `redirect`, `error` or `rate_limited`, and the redirect target as a pattern, or only its host when it leaves the site), `not_found` for a 404 and `server_error` for a 5xx.

## Read helpers

No rendering, just data. A period is `{ from, to }` (from inclusive, to exclusive).

```ts
const now = new Date();
const period = { from: analytics.startOfDay(now, 29), to: now }; // today plus the 29 days before

await analytics.report.kpis(period, { events: ["signup_requested"] });
// { visitors, pageViews, events, counts: { signup_requested } }

await analytics.report.timeSeries(period, "day"); // or "week"
// [{ bucket: "2026-10-01", visitors, pageViews }, ...] one per local day, empty days included

await analytics.report.eventSeries(period, "cta_click", "day"); // or "week"
// [{ bucket: "2026-10-01", count, visitors }, ...] same buckets, one event

await analytics.report.breakdown(period, "referrer_host", { event: "page_view", limit: 10 });
// [{ label, count, visitors }, ...] most visitors first

await analytics.report.breakdown(period, { prop: "id" }, { event: "cta_click" });
// [{ label: "hero", count, visitors }, ...] grouped by that event's prop

await analytics.report.eventTallies(period);
// [{ name, label, sources, count, visitors }, ...]
```

`breakdown` dimensions: `route`, `referrer_host`, `device`, `browser`, `utm_source`, `utm_medium`, `utm_campaign`, or `{ prop: "<key>" }` for one of an event's own props (rows without the key are skipped; the key must be a plain identifier). Visitor hashes rotate daily, so "visitors" over a range is the sum of daily uniques, the same number Plausible-style tools report. `eventTallies` returns both the stored `name` and its display `label`; a name that has since left the registry is humanised rather than shown raw.

The pure helpers are exported too: `isBot`, `isPrefetch`, `classifyUserAgent`, `normalizePath`, `notFoundBucket`, `referrerHost`, `hostFromReferrer`, `utm`, `utmValue`, `SAFE_STRING`, `sanitizeProps`, `humanizeEventName`, `createLexicon`, `startOfDay`, `localDay`.

## Development

```bash
bun install
createdb billet-analytics-test
echo "DATABASE_URL=postgresql://localhost/billet-analytics-test" > .env.test
bun run check   # biome + tsc
bun test        # the database tests drop and recreate the two tables
```

`.env.test` is not optional. The tests drop and recreate `analytics_event` and `analytics_salt`, so they refuse to start unless `DATABASE_URL` names a database ending in `-test`. Bun loads `.env.test` over `.env` under `NODE_ENV=test`, which `bun test` sets.

## License

MIT © Alex Price
