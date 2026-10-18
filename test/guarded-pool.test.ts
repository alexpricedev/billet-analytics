import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createAnalytics, defineEvents } from "../src/index";
import { db, events, html, resetSchema, truncate, visit } from "./helpers";

// Billet's `db` is a Proxy that throws when a tagged-template query binds an
// array or a plain object, because Bun would silently store "a,b" or
// "[object Object]". The package has to work through it unchanged.
const guarded = new Proxy(db, {
  apply(target, thisArg, args: unknown[]) {
    const [first, ...values] = args;
    if (first && typeof first === "object" && "raw" in first) {
      for (const value of values) {
        if (
          Array.isArray(value) ||
          (value !== null &&
            typeof value === "object" &&
            Object.getPrototypeOf(value) === Object.prototype)
        ) {
          throw new Error("guarded pool: refused an array or plain object");
        }
      }
    }
    return Reflect.apply(target, thisArg, args);
  },
}) as SQL;

const EVENTS = defineEvents({
  project_created: { source: "server", props: { kind: ["solar"] } },
});

describe("through a guarded pool", () => {
  beforeAll(resetSchema);
  beforeEach(truncate);

  test("recording, purging and every report helper run unchanged", async () => {
    const errors: unknown[] = [];
    const analytics = createAnalytics({
      db: guarded,
      events: EVENTS,
      enabled: true,
      onError: (_message, err) => errors.push(err),
    });
    await analytics.track(visit("https://site.test/"), "project_created", {
      kind: "solar",
    });
    await analytics.captureRequest(
      visit("https://site.test/login", { method: "POST" }),
      "/login",
      new Response(null, { status: 303, headers: { location: "/" } }),
    );
    await analytics.captureRequest(visit("https://site.test/"), "/", html());
    expect(errors).toEqual([]);
    expect((await events()).map((r) => r.props)).toEqual([
      { kind: "solar" },
      { outcome: "redirect", target: "/" },
      {},
    ]);

    const period = {
      from: analytics.startOfDay(new Date(), 1),
      to: new Date(Date.now() + 3_600_000),
    };
    const { report } = analytics;
    expect(
      (await report.kpis(period, { events: ["project_created"] })).counts,
    ).toEqual({ project_created: 1 });
    expect((await report.timeSeries(period)).length).toBeGreaterThan(0);
    expect(await report.breakdown(period, "route")).toHaveLength(1);
    expect(await report.eventTallies(period)).toHaveLength(3);
    await analytics.purgeExpired();
  });
});
