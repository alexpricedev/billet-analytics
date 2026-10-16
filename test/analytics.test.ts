import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  type AnalyticsConfig,
  createAnalytics,
  defineEvents,
  visitorHash,
} from "../src/index";
import {
  CHROME,
  db,
  events,
  html,
  IPHONE,
  resetSchema,
  truncate,
  visit,
} from "./helpers";

const EVENTS = defineEvents({
  project_created: { source: "server", props: { kind: ["solar", "wind"] } },
  magic_link_verified: { source: "server", props: { new_user: "boolean" } },
  report_printed: { source: "client" },
});

const make = (overrides: Partial<AnalyticsConfig<typeof EVENTS>> = {}) =>
  createAnalytics({ db, events: EVENTS, enabled: true, ...overrides });

describe("createAnalytics", () => {
  beforeAll(resetSchema);
  beforeEach(truncate);

  describe("recording", () => {
    test("every event is stored to the hour", async () => {
      const analytics = make();
      await analytics.recordEvent(visit("https://site.test/projects/new"), {
        name: "page_view",
        source: "server",
        route: "/projects/new",
      });
      await analytics.track(visit("https://site.test/team"), "project_created");
      const rows = await events();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const stored = new Date(row.occurred_at);
        expect(stored.getUTCMinutes()).toBe(0);
        expect(stored.getUTCSeconds()).toBe(0);
        expect(stored.getUTCMilliseconds()).toBe(0);
      }
    });

    test("stores coarse, anonymous context and nothing identifying", async () => {
      const analytics = make();
      const req = visit(
        "https://site.test/?utm_source=Newsletter&utm_medium=Email&utm_campaign=launch",
        {},
        { referer: "https://www.linkedin.com/feed/some/post" },
      );
      await analytics.recordEvent(req, {
        name: "page_view",
        source: "server",
        route: "/",
      });

      const [row] = await events();
      expect(row?.referrer_host).toBe("linkedin.com");
      expect(row?.utm_source).toBe("newsletter");
      expect(row?.utm_medium).toBe("email");
      expect(row?.utm_campaign).toBe("launch");
      expect(row?.device).toBe("desktop");
      expect(row?.browser).toBe("Chrome");
      expect(row?.authenticated).toBe(false);
      expect(row?.visitor_hash).toMatch(/^[0-9a-f]{32}$/);
      const serialised = JSON.stringify(row);
      expect(serialised).not.toContain("203.0.113.7");
      expect(serialised).not.toContain("Macintosh");
    });

    test("props land as a jsonb object, allow-listed", async () => {
      const analytics = make();
      await analytics.recordEvent(visit("https://site.test/projects"), {
        name: "project_created",
        source: "server",
        props: { kind: "solar", email: "someone@example.com" },
      });
      const [row] = await events();
      expect(row?.props).toEqual({ kind: "solar" });
      const [typed] =
        await db`SELECT jsonb_typeof(props) AS t, props->>'kind' AS kind FROM analytics_event`;
      expect(typed).toEqual({ t: "object", kind: "solar" });
    });

    test("the same visitor gets the same hash on the same day; another doesn't", async () => {
      const analytics = make();
      const view = (req: Request) =>
        analytics.recordEvent(req, { name: "page_view", source: "server" });
      await view(visit("https://site.test/"));
      await view(visit("https://site.test/about"));
      await view(
        visit("https://site.test/", {}, { "x-forwarded-for": "198.51.100.9" }),
      );
      await view(visit("https://site.test/", {}, { "user-agent": IPHONE }));
      const [a, b, c, d] = await events();
      expect(a?.visitor_hash).toBe(b?.visitor_hash as string);
      expect(c?.visitor_hash).not.toBe(a?.visitor_hash as string);
      expect(d?.visitor_hash).not.toBe(a?.visitor_hash as string);
      expect(d?.device).toBe("mobile");
    });

    test("ignores internal referrers", async () => {
      const analytics = make();
      await analytics.recordEvent(
        visit("https://site.test/about", {}, { referer: "https://site.test/" }),
        { name: "page_view", source: "server", route: "/about" },
      );
      const [row] = await events();
      expect(row?.referrer_host).toBeNull();
    });

    test("skips bots and prefetches", async () => {
      const analytics = make();
      await analytics.recordEvent(
        visit("https://site.test/", {}, { "user-agent": "Googlebot" }),
        { name: "page_view", source: "server" },
      );
      await analytics.recordEvent(
        visit("https://site.test/", {}, { "sec-purpose": "prefetch" }),
        { name: "page_view", source: "server" },
      );
      expect(await events()).toHaveLength(0);
    });

    test("drops event names that aren't registered", async () => {
      const analytics = make();
      await analytics.recordEvent(visit("https://site.test/"), {
        name: "made_up",
        source: "server",
      });
      expect(await events()).toHaveLength(0);
    });

    test("track attributes a domain event to the normalised path", async () => {
      const analytics = make();
      await analytics.track(
        visit(
          "https://site.test/projects/0b6f7c1e-4c1a-4a0e-9a8e-2f3c4d5e6f70",
        ),
        "project_created",
        { kind: "wind" },
      );
      const [row] = await events();
      expect(row?.name).toBe("project_created");
      expect(row?.route).toBe("/projects/:id");
      expect(row?.source).toBe("server");
      expect(row?.props).toEqual({ kind: "wind" });
    });

    test("track's names and props are type-checked", () => {
      const analytics = make({ enabled: false });
      const req = visit("https://site.test/");
      // @ts-expect-error: not a registered event
      void analytics.track(req, "made_up");
      // @ts-expect-error: not one of the allowed values
      void analytics.track(req, "project_created", { kind: "coal" });
      // @ts-expect-error: wrong prop type
      void analytics.track(req, "magic_link_verified", { new_user: "yes" });
      void analytics.track(req, "magic_link_verified", { new_user: true });
    });

    test("never throws into a request when the write fails", async () => {
      const errors: string[] = [];
      const analytics = make({ onError: (message) => errors.push(message) });
      await db`ALTER TABLE analytics_event RENAME TO analytics_event_away`;
      try {
        await analytics.track(visit("https://site.test/"), "project_created");
      } finally {
        await db`ALTER TABLE analytics_event_away RENAME TO analytics_event`;
      }
      expect(errors).toEqual(["Failed to record project_created"]);
    });

    test("is off under NODE_ENV=test unless switched on", async () => {
      const analytics = createAnalytics({ db, events: EVENTS });
      await analytics.track(visit("https://site.test/"), "project_created");
      expect(await events()).toHaveLength(0);
      analytics.setEnabled(true);
      await analytics.track(visit("https://site.test/"), "project_created");
      expect(await events()).toHaveLength(1);
    });
  });

  describe("daily salt", () => {
    test("is stable within a day and different across days", async () => {
      const analytics = make();
      const a = await analytics.getDailySalt(new Date("2026-10-07T09:00:00Z"));
      analytics.resetSaltCache();
      const b = await analytics.getDailySalt(new Date("2026-10-07T22:30:00Z"));
      const c = await analytics.getDailySalt(new Date("2026-10-07T23:30:00Z"));
      expect(a).toBe(b);
      expect(c).not.toBe(a);
      expect(visitorHash(a, "1.2.3.4", CHROME)).not.toBe(
        visitorHash(c, "1.2.3.4", CHROME),
      );
    });

    test("rotates on the configured zone's day, not the UTC day", async () => {
      // 00:30 and 09:00 BST on 7 October: two UTC days, one UK day.
      const analytics = make();
      const a = await analytics.getDailySalt(new Date("2026-10-06T23:30:00Z"));
      analytics.resetSaltCache();
      expect(
        await analytics.getDailySalt(new Date("2026-10-07T08:00:00Z")),
      ).toBe(a);
      const days =
        await db`SELECT to_char(day, 'YYYY-MM-DD') AS day FROM analytics_salt`;
      expect([...days]).toEqual([{ day: "2026-10-07" }]);
    });

    test("a different timeZone moves the boundary", async () => {
      const analytics = make({ timeZone: "UTC" });
      const a = await analytics.getDailySalt(new Date("2026-10-06T23:30:00Z"));
      analytics.resetSaltCache();
      const b = await analytics.getDailySalt(new Date("2026-10-07T08:00:00Z"));
      expect(b).not.toBe(a);
    });

    test("two instances share the day's salt through the table", async () => {
      const at = new Date("2026-10-07T09:00:00Z");
      const [a, b] = await Promise.all([
        make().getDailySalt(at),
        make().getDailySalt(at),
      ]);
      expect(a).toBe(b);
    });
  });

  describe("retention", () => {
    test("counts calendar months, even from the 31st", async () => {
      // 13 months before 31 March 2027 is 28 February 2026, not "31 February".
      await db`INSERT INTO analytics_event (name, source, visitor_hash, occurred_at) VALUES
        ('page_view', 'server', 'expired', '2026-02-27T12:00:00Z'),
        ('page_view', 'server', 'kept', '2026-03-01T00:00:00Z')`;
      await make().purgeExpired(new Date("2027-03-31T12:00:00Z"));
      expect((await events()).map((r) => r.visitor_hash)).toEqual(["kept"]);
    });

    test("keeps only today's salt and deletes events past retention", async () => {
      await db`INSERT INTO analytics_salt (day, salt) VALUES
        ('2026-10-01', 'old'), ('2026-10-06', 'yesterday'), ('2026-10-07', 'today')`;
      await db`INSERT INTO analytics_event (name, source, visitor_hash, occurred_at) VALUES
        ('page_view', 'server', 'a', '2025-08-01T00:00:00Z'),
        ('page_view', 'server', 'b', '2026-10-01T00:00:00Z')`;

      await make().purgeExpired(new Date("2026-10-07T12:00:00Z"));

      const salts = await db`SELECT salt FROM analytics_salt ORDER BY day`;
      expect(salts.map((s: { salt: string }) => s.salt)).toEqual(["today"]);
      expect((await events()).map((r) => r.visitor_hash)).toEqual(["b"]);
    });

    test("keeps the local day's salt late in the UTC day", async () => {
      // 23:30 UTC on 7 October is already 8 October in the UK.
      await db`INSERT INTO analytics_salt (day, salt) VALUES
        ('2026-10-07', 'utc-day'), ('2026-10-08', 'uk-day')`;
      await make().purgeExpired(new Date("2026-10-07T23:30:00Z"));
      const salts = await db`SELECT salt FROM analytics_salt ORDER BY day`;
      expect(salts.map((s: { salt: string }) => s.salt)).toEqual(["uk-day"]);
    });
  });

  describe("captureRequest", () => {
    test("records a page view for a routed HTML GET", async () => {
      await make().captureRequest(
        visit("https://site.test/about"),
        "/about",
        html(),
      );
      const [row] = await events();
      expect(row?.name).toBe("page_view");
      expect(row?.route).toBe("/about");
      expect(row?.method).toBe("GET");
      expect(row?.status).toBe(200);
    });

    test("uses the route pattern, never the concrete path", async () => {
      await make().captureRequest(
        visit("https://site.test/interest/confirm?token=secret-token-value"),
        "/interest/confirm",
        html(),
      );
      const [row] = await events();
      expect(JSON.stringify(row)).not.toContain("secret-token-value");
    });

    test("records form submissions with outcome and target pattern", async () => {
      const analytics = make();
      await analytics.captureRequest(
        visit("https://site.test/projects/new", { method: "POST" }),
        "/projects/new",
        new Response(null, {
          status: 303,
          headers: {
            location: "/projects/0b6f7c1e-4c1a-4a0e-9a8e-2f3c4d5e6f70",
          },
        }),
      );
      await analytics.captureRequest(
        visit("https://site.test/login", { method: "POST" }),
        "/login",
        Response.json({ error: "Too many requests" }, { status: 429 }),
      );
      await analytics.captureRequest(
        visit("https://site.test/login", { method: "POST" }),
        "/login",
        html(422),
      );
      await analytics.captureRequest(
        visit("https://site.test/login", { method: "POST" }),
        "/login",
        html(200),
      );
      const [submit, limited, invalid, ok] = await events();
      expect(submit?.name).toBe("form_submit");
      expect(submit?.props).toEqual({
        outcome: "redirect",
        target: "/projects/:id",
      });
      expect(limited?.props).toEqual({ outcome: "rate_limited" });
      expect(invalid?.props).toEqual({ outcome: "error" });
      expect(ok?.props).toEqual({ outcome: "ok" });
    });

    test("records 404s and 500s, grouped without raw paths", async () => {
      const analytics = make();
      await analytics.captureRequest(
        visit("https://site.test/wp-admin/install.php"),
        null,
        html(404),
      );
      await analytics.captureRequest(
        visit("https://site.test/projects/new"),
        "/projects/new",
        html(500),
      );
      const [missing, broken] = await events();
      expect(missing?.name).toBe("not_found");
      expect(missing?.route).toBe("/wp-admin/*");
      expect(broken?.name).toBe("server_error");
      expect(broken?.route).toBe("/projects/new");
    });

    test("ignores static files, machine endpoints, HEAD and non-HTML", async () => {
      const analytics = make();
      await analytics.captureRequest(
        visit("https://site.test/assets/main.js"),
        null,
        new Response("x"),
      );
      await analytics.captureRequest(
        visit("https://site.test/favicon.svg"),
        null,
        new Response("x"),
      );
      await analytics.captureRequest(
        visit("https://site.test/robots.txt"),
        "/robots.txt",
        new Response("x"),
      );
      await analytics.captureRequest(
        visit("https://site.test/", { method: "HEAD" }),
        "/",
        html(),
      );
      await analytics.captureRequest(
        visit("https://site.test/api/events", { method: "POST" }),
        "/api/events",
        new Response(null, { status: 204 }),
      );
      await analytics.captureRequest(
        visit("https://site.test/projects"),
        "/projects",
        new Response(null, {
          status: 302,
          headers: { location: "/projects/new" },
        }),
      );
      await analytics.captureRequest(
        visit("https://site.test/api/stats"),
        "/api/stats",
        Response.json({ ok: true }),
      );
      expect(await events()).toHaveLength(0);
    });
  });

  describe("config overrides", () => {
    test("exclude drops the request's events", async () => {
      const analytics = make({
        exclude: (req) => req.headers.get("x-role") === "admin",
      });
      await analytics.track(
        visit("https://site.test/", {}, { "x-role": "admin" }),
        "project_created",
      );
      await analytics.track(visit("https://site.test/"), "project_created");
      expect(await events()).toHaveLength(1);
    });

    test("exclude may be async", async () => {
      const analytics = make({ exclude: async () => true });
      await analytics.track(visit("https://site.test/"), "project_created");
      expect(await events()).toHaveLength(0);
    });

    test("markExcluded drops the rest of a request revealed mid-way", async () => {
      const analytics = make();
      const signingIn = visit("https://site.test/auth/callback");
      const someoneElse = visit("https://site.test/auth/callback");
      analytics.markExcluded(signingIn);
      await analytics.track(signingIn, "magic_link_verified", {
        new_user: false,
      });
      await analytics.track(someoneElse, "magic_link_verified", {
        new_user: false,
      });
      expect(await events()).toHaveLength(1);
    });

    test("authenticated fills the column", async () => {
      const analytics = make({
        authenticated: (req) => req.headers.has("cookie"),
      });
      await analytics.track(
        visit("https://site.test/", {}, { cookie: "session_id=abc" }),
        "project_created",
      );
      const [row] = await events();
      expect(row?.authenticated).toBe(true);
      expect(JSON.stringify(row)).not.toContain("abc");
    });

    test("a custom visitorId is stored as given, and no salt is minted", async () => {
      const analytics = make({ visitorId: () => "visitor-42" });
      await analytics.track(visit("https://site.test/"), "project_created");
      const [row] = await events();
      expect(row?.visitor_hash).toBe("visitor-42");
      const salts = await db`SELECT count(*)::int AS n FROM analytics_salt`;
      expect(salts[0]).toEqual({ n: 0 });
    });

    test("a custom clientIp feeds the hash", async () => {
      const analytics = make({ clientIp: () => "192.0.2.1" });
      await analytics.track(
        visit("https://site.test/", {}, { "x-forwarded-for": "198.51.100.1" }),
        "project_created",
      );
      await analytics.track(
        visit("https://site.test/", {}, { "x-forwarded-for": "198.51.100.2" }),
        "project_created",
      );
      const [a, b] = await events();
      const salt = await analytics.getDailySalt();
      expect(a?.visitor_hash).toBe(visitorHash(salt, "192.0.2.1", CHROME));
      expect(b?.visitor_hash).toBe(a?.visitor_hash as string);
    });

    test("roundTimestamps: none keeps the exact time", async () => {
      const analytics = make({ roundTimestamps: "none" });
      const before = Date.now();
      await analytics.track(visit("https://site.test/"), "project_created");
      const [row] = await events();
      const stored = new Date(row!.occurred_at).getTime();
      expect(stored).toBeGreaterThanOrEqual(before - 1);
      expect(stored).toBeLessThanOrEqual(Date.now() + 1);
    });

    test("roundTimestamps: day truncates to midnight UTC", async () => {
      const analytics = make({ roundTimestamps: "day" });
      await analytics.track(visit("https://site.test/"), "project_created");
      const [row] = await events();
      expect(new Date(row!.occurred_at).toISOString()).toMatch(
        /T00:00:00\.000Z$/,
      );
    });

    test("retentionMonths replaces 13", async () => {
      await db`INSERT INTO analytics_event (name, source, visitor_hash, occurred_at) VALUES
        ('page_view', 'server', 'old', '2026-08-01T00:00:00Z'),
        ('page_view', 'server', 'new', '2026-09-15T00:00:00Z')`;
      await make({ retentionMonths: 2 }).purgeExpired(
        new Date("2026-10-07T12:00:00Z"),
      );
      expect((await events()).map((r) => r.visitor_hash)).toEqual(["new"]);
    });

    test("untrackedRoutes replaces the default list", async () => {
      const analytics = make({ untrackedRoutes: ["/status"] });
      await analytics.captureRequest(
        visit("https://site.test/status"),
        "/status",
        html(),
      );
      await analytics.captureRequest(
        visit("https://site.test/health"),
        "/health",
        html(),
      );
      expect((await events()).map((r) => r.route)).toEqual(["/health"]);
    });

    test("siteUrl decides which referrers are internal", async () => {
      const analytics = make({ siteUrl: "https://www.example.org" });
      await analytics.track(
        visit(
          "https://app.internal/",
          {},
          {
            referer: "https://www.example.org/pricing",
          },
        ),
        "project_created",
      );
      const [row] = await events();
      expect(row?.referrer_host).toBeNull();
    });

    test("bad config is refused at startup", () => {
      expect(() => make({ timeZone: "Mars/Olympus" })).toThrow(RangeError);
      expect(() => make({ retentionMonths: 0 })).toThrow(/retentionMonths/);
    });
  });

  describe("session lookup timing", () => {
    // A session store the handler can end mid-request, standing in for the
    // app's sessions table.
    const sessions = new Set<string>();
    const sessionOf = (req: Request) =>
      /session_id=(\w+)/.exec(req.headers.get("cookie") ?? "")?.[1];
    const signedIn = () =>
      make({
        authenticated: (req) => sessions.has(sessionOf(req) ?? ""),
      });

    beforeEach(() => {
      sessions.clear();
      sessions.add("abc");
    });

    test("reads the session after the handler on ordinary routes", async () => {
      const analytics = signedIn();
      const req = visit(
        "https://site.test/about",
        {},
        {
          cookie: "session_id=abc",
        },
      );
      analytics.beginRequest(req, "/about");
      sessions.delete("abc");
      await analytics.captureRequest(req, "/about", html());
      const [row] = await events();
      expect(row?.authenticated).toBe(false);
    });

    test("reads it before the handler on a sign-out", async () => {
      const analytics = signedIn();
      const req = visit(
        "https://site.test/auth/logout",
        { method: "POST" },
        {
          cookie: "session_id=abc",
        },
      );
      analytics.beginRequest(req, "/auth/logout");
      sessions.delete("abc");
      await analytics.captureRequest(
        req,
        "/auth/logout",
        new Response(null, { status: 303, headers: { location: "/" } }),
      );
      const [row] = await events();
      expect(row?.name).toBe("form_submit");
      expect(row?.authenticated).toBe(true);
    });

    test("sessionChangingRoutes replaces the default list", async () => {
      const analytics = createAnalytics({
        db,
        enabled: true,
        sessionChangingRoutes: ["/signout"],
        authenticated: (req) => sessions.has(sessionOf(req) ?? ""),
      });
      const req = visit(
        "https://site.test/signout",
        { method: "POST" },
        {
          cookie: "session_id=abc",
        },
      );
      analytics.beginRequest(req, "/signout");
      sessions.delete("abc");
      await analytics.captureRequest(
        req,
        "/signout",
        new Response(null, { status: 303, headers: { location: "/" } }),
      );
      const [row] = await events();
      expect(row?.authenticated).toBe(true);
    });
  });
});
