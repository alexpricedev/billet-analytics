import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  type AnalyticsConfig,
  createAnalytics,
  DEFAULT_MAX_BODY_BYTES,
  defineEvents,
  MAX_TRACKED_CLIENTS,
} from "../src/index";
import { CHROME, db, resetSchema, truncate, waitForRows } from "./helpers";

const EVENTS = defineEvents({
  report_printed: { source: "client" },
  mailto_click: { source: "client" },
  pathway_copied: {
    source: "client",
    props: { format: ["document", "link"] },
  },
  project_created: { source: "server" },
});

const make = (overrides: Partial<AnalyticsConfig<typeof EVENTS>> = {}) =>
  createAnalytics({
    db,
    events: EVENTS,
    enabled: true,
    siteUrl: "https://site.test",
    ...overrides,
  });

const beacon = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://site.test/api/events", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "user-agent": CHROME,
      "sec-fetch-site": "same-origin",
      "x-forwarded-for": "198.51.100.4",
      ...headers,
    },
  });

const rows = async () =>
  [
    ...(await db`SELECT name, source, route, props FROM analytics_event ORDER BY id`),
  ] as {
    name: string;
    source: string;
    route: string | null;
    props: Record<string, unknown>;
  }[];

describe("events endpoint", () => {
  beforeAll(resetSchema);
  beforeEach(truncate);

  test("records an allow-listed client event with its page route", async () => {
    const res = await make().handleEvents(
      beacon({
        name: "pathway_copied",
        props: { format: "link", extra: "dropped" },
        path: "/projects/0b6f7c1e-4c1a-4a0e-9a8e-2f3c4d5e6f70?ref=x",
      }),
    );
    expect(res.status).toBe(204);
    expect(await waitForRows(rows, 1)).toEqual([
      {
        name: "pathway_copied",
        source: "client",
        route: "/projects/:id",
        props: { format: "link" },
      },
    ]);
  });

  test("accepts a matching Origin when Sec-Fetch-Site is absent", async () => {
    const analytics = make();
    const req = beacon(
      { name: "report_printed", path: "/" },
      { origin: "https://site.test" },
    );
    req.headers.delete("sec-fetch-site");
    await analytics.handleEvents(req);
    expect(await waitForRows(rows, 1)).toHaveLength(1);
  });

  test("accepts the configured siteUrl's origin behind a proxy", async () => {
    const analytics = make({ siteUrl: "https://www.example.org" });
    const req = beacon(
      { name: "report_printed", path: "/" },
      { origin: "https://www.example.org" },
    );
    req.headers.delete("sec-fetch-site");
    await analytics.handleEvents(req);
    expect(await waitForRows(rows, 1)).toHaveLength(1);
  });

  test("drops a beacon with neither Sec-Fetch-Site nor Origin", async () => {
    const req = beacon({ name: "report_printed" });
    req.headers.delete("sec-fetch-site");
    await make().handleEvents(req);
    expect(await waitForRows(rows, 0)).toHaveLength(0);
  });

  test("drops unknown and server-only event names", async () => {
    const analytics = make();
    await analytics.handleEvents(beacon({ name: "made_up" }));
    await analytics.handleEvents(beacon({ name: "page_view" }));
    await analytics.handleEvents(beacon({ name: "project_created" }));
    await analytics.handleEvents(beacon({ name: "toString" }));
    expect(await waitForRows(rows, 0)).toHaveLength(0);
  });

  test("drops cross-site beacons", async () => {
    const res = await make().handleEvents(
      beacon({ name: "report_printed" }, { "sec-fetch-site": "cross-site" }),
    );
    expect(res.status).toBe(204);
    expect(await waitForRows(rows, 0)).toHaveLength(0);
  });

  test("drops a cross-origin Origin", async () => {
    const req = beacon(
      { name: "report_printed" },
      { origin: "https://evil.test" },
    );
    req.headers.delete("sec-fetch-site");
    await make().handleEvents(req);
    expect(await waitForRows(rows, 0)).toHaveLength(0);
  });

  test("answers 204 to malformed JSON without recording", async () => {
    const res = await make().handleEvents(beacon("{not json"));
    expect(res.status).toBe(204);
    expect(await waitForRows(rows, 0)).toHaveLength(0);
  });

  test("answers 204 to a JSON body that is not an object", async () => {
    const res = await make().handleEvents(beacon("null"));
    expect(res.status).toBe(204);
    expect(await waitForRows(rows, 0)).toHaveLength(0);
  });

  test("answers 204 to anything but POST", async () => {
    const res = await make().handleEvents(
      new Request("https://site.test/api/events", {
        headers: { "sec-fetch-site": "same-origin" },
      }),
    );
    expect(res.status).toBe(204);
    expect(await waitForRows(rows, 0)).toHaveLength(0);
  });

  test("drops a body whose Content-Length is over the cap without reading it", async () => {
    const req = beacon(
      { name: "report_printed", path: "/" },
      { "content-length": String(DEFAULT_MAX_BODY_BYTES + 1) },
    );
    const res = await make().handleEvents(req);
    expect(res.status).toBe(204);
    expect(req.bodyUsed).toBe(false);
    expect(await waitForRows(rows, 0)).toHaveLength(0);
  });

  test("drops an oversized body even when Content-Length is absent", async () => {
    const body = JSON.stringify({
      name: "report_printed",
      path: `/${"a".repeat(DEFAULT_MAX_BODY_BYTES)}`,
    });
    const req = beacon(body);
    req.headers.delete("content-length");
    const res = await make().handleEvents(req);
    expect(res.status).toBe(204);
    expect(await waitForRows(rows, 0)).toHaveLength(0);
  });

  test("records a body right at the cap", async () => {
    const base = JSON.stringify({ name: "report_printed", path: "/" });
    const padded = JSON.stringify({
      name: "report_printed",
      path: `/${"a".repeat(DEFAULT_MAX_BODY_BYTES - base.length)}`,
    });
    expect(padded.length).toBe(DEFAULT_MAX_BODY_BYTES);
    const res = await make().handleEvents(beacon(padded));
    expect(res.status).toBe(204);
    expect(await waitForRows(rows, 1)).toHaveLength(1);
  });

  test("drops a streamed body that passes the cap, with no Content-Length", async () => {
    const chunk = new TextEncoder().encode("a".repeat(1024));
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > 100) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const req = new Request("https://site.test/api/events", {
      method: "POST",
      body: stream,
      headers: {
        "user-agent": CHROME,
        "sec-fetch-site": "same-origin",
        "x-forwarded-for": "198.51.100.4",
      },
    });
    expect(req.headers.get("content-length")).toBeNull();
    const res = await make().handleEvents(req);
    expect(res.status).toBe(204);
    // It stopped reading a few chunks past the 2 KB cap, not at the end.
    expect(pulls).toBeLessThan(10);
    expect(await waitForRows(rows, 0)).toHaveLength(0);
  });

  test("counts the cap in bytes, not characters", async () => {
    const base = JSON.stringify({ name: "report_printed", path: "/" });
    // "é" is one UTF-16 unit but two UTF-8 bytes.
    const body = JSON.stringify({
      name: "report_printed",
      path: `/${"é".repeat(DEFAULT_MAX_BODY_BYTES - base.length)}`,
    });
    expect(body.length).toBe(DEFAULT_MAX_BODY_BYTES);
    const req = beacon(body);
    req.headers.delete("content-length");
    await make().handleEvents(req);
    expect(await waitForRows(rows, 0)).toHaveLength(0);
  });

  test("a throwing clientIp is reported and still answers 204", async () => {
    const errors: string[] = [];
    const analytics = make({
      clientIp: () => {
        throw new Error("no socket");
      },
      onError: (message) => errors.push(message),
    });
    const res = await analytics.handleEvents(
      beacon({ name: "report_printed" }),
    );
    expect(res.status).toBe(204);
    expect(errors).toEqual(["Events endpoint failed"]);
    expect(await waitForRows(rows, 0)).toHaveLength(0);
  });

  test("a throwing onError still answers 204", async () => {
    const analytics = make({
      clientIp: () => {
        throw new Error("no socket");
      },
      onError: () => {
        throw new Error("logger down");
      },
    });
    const res = await analytics.handleEvents(
      beacon({ name: "report_printed" }),
    );
    expect(res.status).toBe(204);
  });

  test("a siteUrl that isn't a URL is a config error", () => {
    expect(() => make({ siteUrl: "site.test" })).toThrow(
      "siteUrl (or APP_URL) must be an absolute URL",
    );
  });

  test("the limiter forgets the oldest client past MAX_TRACKED_CLIENTS", async () => {
    const analytics = make({
      enabled: false,
      endpoint: { maxRequests: 1, windowMs: 60_000 },
    });
    let ip = "198.51.100.1";
    const send = () =>
      analytics.handleEvents(
        beacon({ name: "report_printed" }, { "x-forwarded-for": ip }),
      );
    await send();
    for (let i = 0; i < MAX_TRACKED_CLIENTS; i++) {
      ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
      await send();
    }
    // The first client was evicted, so it gets a fresh budget.
    analytics.setEnabled(true);
    ip = "198.51.100.1";
    await send();
    expect(await waitForRows(rows, 1)).toHaveLength(1);
  });

  test("maxBodyBytes replaces the cap", async () => {
    const analytics = make({ endpoint: { maxBodyBytes: 40 } });
    await analytics.handleEvents(
      beacon({ name: "report_printed", path: "/a-path-long-enough" }),
    );
    expect(await waitForRows(rows, 0)).toHaveLength(0);
  });

  test("excluded traffic is silently dropped", async () => {
    const analytics = make({
      exclude: (req) => req.headers.get("cookie") === "session_id=admin",
    });
    await analytics.handleEvents(
      beacon({ name: "report_printed" }, { cookie: "session_id=admin" }),
    );
    await analytics.handleEvents(
      beacon({ name: "mailto_click" }, { "x-forwarded-for": "198.51.100.9" }),
    );
    expect((await waitForRows(rows, 1)).map((r) => r.name)).toEqual([
      "mailto_click",
    ]);
  });

  test("rate limits a single client", async () => {
    const analytics = make();
    for (let i = 0; i < 65; i++) {
      await analytics.handleEvents(beacon({ name: "report_printed" }));
    }
    expect(await waitForRows(rows, 60)).toHaveLength(60);
  });

  test("a forged X-Forwarded-For entry doesn't get round the limit", async () => {
    const analytics = make();
    for (let i = 0; i < 65; i++) {
      await analytics.handleEvents(
        beacon(
          { name: "report_printed" },
          { "x-forwarded-for": `10.0.0.${i}, 198.51.100.4` },
        ),
      );
    }
    expect(await waitForRows(rows, 60)).toHaveLength(60);
  });

  test("the limit is configurable", async () => {
    const analytics = make({ endpoint: { maxRequests: 3, windowMs: 60_000 } });
    for (let i = 0; i < 5; i++) {
      await analytics.handleEvents(beacon({ name: "report_printed" }));
    }
    expect(await waitForRows(rows, 3)).toHaveLength(3);
  });

  test("the window lets a client back in once it has passed", async () => {
    const analytics = make({ endpoint: { maxRequests: 1, windowMs: 50 } });
    await analytics.handleEvents(beacon({ name: "report_printed" }));
    await analytics.handleEvents(beacon({ name: "report_printed" }));
    await Bun.sleep(80);
    await analytics.handleEvents(beacon({ name: "report_printed" }));
    expect(await waitForRows(rows, 2)).toHaveLength(2);
  });

  test("records nothing while analytics is disabled", async () => {
    const analytics = make({ enabled: false });
    const res = await analytics.handleEvents(
      beacon({ name: "report_printed" }),
    );
    expect(res.status).toBe(204);
    expect(await waitForRows(rows, 0)).toHaveLength(0);
  });
});

describe("beacon attribution", () => {
  beforeAll(resetSchema);
  beforeEach(truncate);

  const attribution = async () =>
    [
      ...(await db`SELECT referrer_host, utm_source, utm_medium, utm_campaign
                   FROM analytics_event ORDER BY id`),
    ] as {
      referrer_host: string | null;
      utm_source: string | null;
      utm_medium: string | null;
      utm_campaign: string | null;
    }[];

  test("takes the page's referrer and campaign from the body", async () => {
    await make().handleEvents(
      beacon({
        name: "report_printed",
        path: "/pricing",
        referrer: "https://www.news.example/story",
        utm: {
          utm_source: " Newsletter ",
          utm_medium: "email",
          utm_campaign: "launch",
        },
      }),
    );
    expect(await waitForRows(attribution, 1)).toEqual([
      {
        referrer_host: "news.example",
        utm_source: "newsletter",
        utm_medium: "email",
        utm_campaign: "launch",
      },
    ]);
  });

  test("drops an internal referrer and an unsafe campaign value", async () => {
    await make().handleEvents(
      beacon({
        name: "report_printed",
        referrer: "https://site.test/pricing",
        utm: { utm_source: "alex@example.com", utm_medium: 7 },
      }),
    );
    expect(await waitForRows(attribution, 1)).toEqual([
      {
        referrer_host: null,
        utm_source: null,
        utm_medium: null,
        utm_campaign: null,
      },
    ]);
  });

  test("a beacon without attribution records none", async () => {
    await make().handleEvents(
      beacon({ name: "report_printed", utm: "not an object" }),
    );
    expect(await waitForRows(attribution, 1)).toEqual([
      {
        referrer_host: null,
        utm_source: null,
        utm_medium: null,
        utm_campaign: null,
      },
    ]);
  });

  test("a server event still uses the request's own attribution", async () => {
    const analytics = make();
    const req = new Request("https://site.test/pricing?utm_source=ads", {
      headers: { "user-agent": CHROME, referer: "https://www.news.example/" },
    });
    await analytics.track(req, "project_created");
    expect(await attribution()).toEqual([
      {
        referrer_host: "news.example",
        utm_source: "ads",
        utm_medium: null,
        utm_campaign: null,
      },
    ]);
  });
});

describe("drop reasons", () => {
  beforeAll(resetSchema);
  beforeEach(truncate);

  const withDrops = (
    overrides: Partial<AnalyticsConfig<typeof EVENTS>> = {},
  ) => {
    const drops: string[] = [];
    const analytics = make({
      onDrop: (reason) => drops.push(reason),
      ...overrides,
    });
    return { analytics, drops };
  };

  test("a recorded beacon reports no drop", async () => {
    const { analytics, drops } = withDrops();
    await analytics.handleEvents(beacon({ name: "report_printed" }));
    await waitForRows(rows, 1);
    expect(drops).toEqual([]);
  });

  test("names an unregistered event", async () => {
    const { analytics, drops } = withDrops();
    await analytics.handleEvents(beacon({ name: "report_pirnted" }));
    expect(drops).toEqual([
      '"report_pirnted" is not a registered client event',
    ]);
  });

  test("names a server-only event sent from the browser", async () => {
    const { analytics, drops } = withDrops();
    await analytics.handleEvents(beacon({ name: "project_created" }));
    expect(drops).toEqual([
      '"project_created" is not a registered client event',
    ]);
  });

  test("reports a cross-origin beacon", async () => {
    const { analytics, drops } = withDrops();
    const req = beacon(
      { name: "report_printed" },
      { "sec-fetch-site": "cross-site" },
    );
    await analytics.handleEvents(req);
    expect(drops).toEqual(["not same-origin"]);
  });

  test("reports the wrong method, a bad body and the rate limit", async () => {
    const { analytics, drops } = withDrops({
      // The limiter runs before the body is read, so the unparseable beacon
      // spends a slot too.
      endpoint: { maxRequests: 2, windowMs: 60_000 },
    });
    const get = new Request("https://site.test/api/events", {
      headers: { "sec-fetch-site": "same-origin" },
    });
    await analytics.handleEvents(get);
    await analytics.handleEvents(beacon("{ not json"));
    await analytics.handleEvents(beacon({ name: "report_printed" }));
    await analytics.handleEvents(beacon({ name: "report_printed" }));
    expect(drops).toEqual([
      "method GET, not POST",
      "body is not JSON",
      "rate limited",
    ]);
  });

  test("reports a body over the cap", async () => {
    const { analytics, drops } = withDrops();
    await analytics.handleEvents(
      beacon({ name: "report_printed", props: { pad: "x".repeat(4000) } }),
    );
    expect(drops).toEqual([`body over ${DEFAULT_MAX_BODY_BYTES} bytes`]);
  });

  test("reports a beacon dropped after the endpoint accepted it", async () => {
    const { analytics, drops } = withDrops({ exclude: () => true });
    await analytics.handleEvents(beacon({ name: "report_printed" }));
    await Bun.sleep(50);
    expect(drops).toEqual(["excluded by exclude()"]);
    expect(await rows()).toHaveLength(0);
  });

  test("reports a bot's beacon, but not a bot's page view", async () => {
    const { analytics, drops } = withDrops();
    const bot = beacon({ name: "report_printed" }, { "user-agent": "curl/8" });
    await analytics.handleEvents(bot);
    await Bun.sleep(50);
    expect(drops).toEqual(["the request looks like a bot or prefetch"]);

    const crawl = new Request("https://site.test/", {
      headers: { "user-agent": "curl/8" },
    });
    await analytics.track(crawl, "project_created");
    expect(drops).toHaveLength(1);
  });

  test("a throwing onDrop still answers 204", async () => {
    const analytics = make({
      onDrop: () => {
        throw new Error("logger down");
      },
    });
    const res = await analytics.handleEvents(beacon({ name: "nope" }));
    expect(res.status).toBe(204);
  });
});
