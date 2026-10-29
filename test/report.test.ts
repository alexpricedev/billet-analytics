import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createAnalytics, type Dimension, defineEvents } from "../src/index";
import { db, resetSchema, truncate } from "./helpers";

const analytics = createAnalytics({
  db,
  events: defineEvents({
    signup_requested: { source: "server", label: "Signup requested" },
    cta_click: { source: "client", label: "CTA click" },
  }),
});
const { report } = analytics;

// Two UK days in October (BST, UTC+1) plus one row outside the period.
const seed = async () => {
  await db`INSERT INTO analytics_event
    (occurred_at, name, source, visitor_hash, route, referrer_host, device, browser, utm_source, props)
  VALUES
    ('2026-10-05T23:00:00Z', 'page_view', 'server', 'a', '/', 'google.com', 'desktop', 'Chrome', 'newsletter', '{}'),
    ('2026-10-06T09:00:00Z', 'page_view', 'server', 'a', '/about', NULL, 'desktop', 'Chrome', NULL, '{}'),
    ('2026-10-06T10:00:00Z', 'page_view', 'server', 'b', '/', 'google.com', 'mobile', 'Safari', NULL, '{}'),
    ('2026-10-06T10:00:00Z', 'signup_requested', 'server', 'b', '/signup', NULL, 'mobile', 'Safari', NULL, '{}'),
    ('2026-10-06T23:00:00Z', 'page_view', 'server', 'c', '/', 'bing.com', 'desktop', 'Firefox', NULL, '{}'),
    ('2026-10-07T08:00:00Z', 'cta_click', 'client', 'c', '/', NULL, 'desktop', 'Firefox', NULL, '{"id":"hero"}'),
    ('2026-10-07T08:00:00Z', 'cta_click', 'server', 'c', '/', NULL, 'desktop', 'Firefox', NULL, '{}'),
    ('2026-10-09T12:00:00Z', 'page_view', 'server', 'z', '/', NULL, 'desktop', 'Chrome', NULL, '{}')`;
};

// 6 and 7 October, UK time.
const period = {
  from: new Date("2026-10-05T23:00:00Z"),
  to: new Date("2026-10-07T23:00:00Z"),
};

describe("report", () => {
  beforeAll(resetSchema);
  beforeEach(async () => {
    await truncate();
    await seed();
  });

  test("kpis counts visitors, page views and events in the period", async () => {
    expect(await report.kpis(period)).toEqual({
      visitors: 3,
      pageViews: 4,
      events: 7,
      counts: {},
    });
  });

  test("kpis counts the named events, with 0 for ones that didn't happen", async () => {
    const { counts } = await report.kpis(period, {
      events: ["signup_requested", "cta_click", "never_seen"],
    });
    expect(counts).toEqual({
      signup_requested: 1,
      cta_click: 2,
      never_seen: 0,
    });
  });

  test("timeSeries has one bucket per local day, empty days included", async () => {
    const wide = {
      from: period.from,
      to: new Date("2026-10-08T23:00:00Z"),
    };
    expect(await report.timeSeries(wide)).toEqual([
      { bucket: "2026-10-06", visitors: 2, pageViews: 3 },
      { bucket: "2026-10-07", visitors: 1, pageViews: 1 },
      { bucket: "2026-10-08", visitors: 0, pageViews: 0 },
    ]);
  });

  test("timeSeries buckets by the configured zone", async () => {
    const utc = createAnalytics({ db, timeZone: "UTC" }).report;
    const series = await utc.timeSeries(period);
    // 23:00 UTC on the 5th is the 5th in UTC, though the 6th in the UK.
    expect(series.map((p) => p.bucket)).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
    ]);
    expect(series[0]).toEqual({
      bucket: "2026-10-05",
      visitors: 1,
      pageViews: 1,
    });
  });

  test("timeSeries can bucket by ISO week", async () => {
    const series = await report.timeSeries(period, "week");
    expect(series).toEqual([
      { bucket: "2026-10-05", visitors: 3, pageViews: 4 },
    ]);
  });

  test("breakdown tallies one dimension, most visitors first", async () => {
    expect(await report.breakdown(period, "route")).toEqual([
      { label: "/", count: 3, visitors: 3 },
      { label: "/about", count: 1, visitors: 1 },
    ]);
    expect(await report.breakdown(period, "referrer_host")).toEqual([
      { label: "google.com", count: 2, visitors: 2 },
      { label: "bing.com", count: 1, visitors: 1 },
    ]);
  });

  test("breakdown takes another event and a limit", async () => {
    expect(
      await report.breakdown(period, "browser", { event: "cta_click" }),
    ).toEqual([{ label: "Firefox", count: 2, visitors: 1 }]);
    expect(await report.breakdown(period, "device", { limit: 1 })).toEqual([
      { label: "desktop", count: 3, visitors: 2 },
    ]);
  });

  test("breakdown refuses a dimension outside the closed list", async () => {
    let message = "";
    try {
      await report.breakdown(period, "visitor_hash" as Dimension);
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain("unknown dimension");
  });

  test("eventTallies lists every event with its sources and display name", async () => {
    expect(await report.eventTallies(period)).toEqual([
      {
        name: "page_view",
        label: "Page view",
        sources: "server",
        count: 4,
        visitors: 3,
      },
      {
        name: "cta_click",
        label: "CTA click",
        sources: "client, server",
        count: 2,
        visitors: 1,
      },
      {
        name: "signup_requested",
        label: "Signup requested",
        sources: "server",
        count: 1,
        visitors: 1,
      },
    ]);
  });

  test("an event no longer in the registry is humanised, not raw", async () => {
    await db`INSERT INTO analytics_event
      (occurred_at, name, source, visitor_hash, route, props)
    VALUES ('2026-10-06T12:00:00Z', 'legacy_signup', 'server', 'f', '/', '{}')`;
    const tallies = await report.eventTallies(period);
    expect(tallies.find((t) => t.name === "legacy_signup")).toEqual({
      name: "legacy_signup",
      label: "Legacy signup",
      sources: "server",
      count: 1,
      visitors: 1,
    });
  });

  test("the analytics lexicon covers the built-ins and the site's labels", () => {
    expect(analytics.lexicon).toMatchObject({
      page_view: "Page view",
      server_error: "Server error",
      signup_requested: "Signup requested",
      cta_click: "CTA click",
    });
  });

  test("a row exactly at `to` is outside the period everywhere", async () => {
    await db`INSERT INTO analytics_event
      (occurred_at, name, source, visitor_hash, route, referrer_host, device, browser, props)
    VALUES (${period.to.toISOString()}, 'page_view', 'server', 'edge', '/edge', 'edge.test', 'tablet', 'Edge', '{}')`;
    expect(await report.kpis(period)).toEqual({
      visitors: 3,
      pageViews: 4,
      events: 7,
      counts: {},
    });
    expect(await report.timeSeries(period)).toEqual([
      { bucket: "2026-10-06", visitors: 2, pageViews: 3 },
      { bucket: "2026-10-07", visitors: 1, pageViews: 1 },
    ]);
    const routes = await report.breakdown(period, "route");
    expect(routes.map((r) => r.label)).not.toContain("/edge");
    const hosts = await report.breakdown(period, "referrer_host");
    expect(hosts.map((r) => r.label)).not.toContain("edge.test");
    const tallies = await report.eventTallies(period);
    expect(tallies.find((t) => t.name === "page_view")?.count).toBe(4);
  });

  test("an empty period gives zeros and empty buckets", async () => {
    const empty = {
      from: new Date("2026-09-01T23:00:00Z"),
      to: new Date("2026-09-03T23:00:00Z"),
    };
    expect(await report.kpis(empty, { events: ["cta_click"] })).toEqual({
      visitors: 0,
      pageViews: 0,
      events: 0,
      counts: { cta_click: 0 },
    });
    expect(await report.timeSeries(empty)).toEqual([
      { bucket: "2026-09-02", visitors: 0, pageViews: 0 },
      { bucket: "2026-09-03", visitors: 0, pageViews: 0 },
    ]);
    expect(await report.breakdown(empty, "route")).toEqual([]);
    expect(await report.eventTallies(empty)).toEqual([]);
  });

  test("eventSeries counts one event per bucket, empty days included", async () => {
    expect(await report.eventSeries(period, "cta_click")).toEqual([
      { bucket: "2026-10-06", count: 0, visitors: 0 },
      { bucket: "2026-10-07", count: 2, visitors: 1 },
    ]);
  });

  test("eventSeries buckets by week too", async () => {
    const series = await report.eventSeries(period, "page_view", "week");
    expect(series).toEqual([{ bucket: "2026-10-05", count: 4, visitors: 3 }]);
  });

  test("breakdown groups by a prop key", async () => {
    await db`INSERT INTO analytics_event
      (occurred_at, name, source, visitor_hash, route, device, browser, props)
    VALUES
      ('2026-10-07T09:00:00Z', 'cta_click', 'client', 'd', '/', 'desktop', 'Chrome', '{"id":"pricing"}'),
      ('2026-10-07T09:00:00Z', 'cta_click', 'client', 'e', '/', 'desktop', 'Chrome', '{"id":"pricing"}')`;
    expect(
      await report.breakdown(period, { prop: "id" }, { event: "cta_click" }),
    ).toEqual([
      { label: "pricing", count: 2, visitors: 2 },
      { label: "hero", count: 1, visitors: 1 },
    ]);
  });

  test("a prop breakdown skips rows without the key and honours limit", async () => {
    const rows = await report.breakdown(
      period,
      { prop: "id" },
      { event: "cta_click", limit: 1 },
    );
    // The server-side cta_click has no props at all.
    expect(rows).toEqual([{ label: "hero", count: 1, visitors: 1 }]);
  });

  test("a prop breakdown rejects a key that isn't a plain identifier", async () => {
    await expect(
      report.breakdown(period, {
        prop: "id'); DROP TABLE analytics_event; --",
      }),
    ).rejects.toThrow(/unusable prop key/);
  });

  test("startOfDay gives a period of whole local days", async () => {
    const now = new Date("2026-10-07T12:00:00Z");
    const from = analytics.startOfDay(now, 1);
    expect(from.toISOString()).toBe("2026-10-05T23:00:00.000Z");
    const series = await report.timeSeries({ from, to: now });
    expect(series.map((p) => p.bucket)).toEqual(["2026-10-06", "2026-10-07"]);
  });
});
