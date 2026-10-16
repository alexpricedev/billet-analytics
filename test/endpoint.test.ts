import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  type AnalyticsConfig,
  createAnalytics,
  DEFAULT_MAX_BODY_BYTES,
  defineEvents,
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
