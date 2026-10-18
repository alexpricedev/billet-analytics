import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, send } from "../src/client";
import { defineEvents } from "../src/events";

type Beacon = { url: string; body: string; type: string };

const globals = globalThis as unknown as {
  navigator: { sendBeacon?: (url: string, data: Blob) => boolean };
  location: { pathname: string; search?: string };
  document?: { referrer: string };
  fetch: typeof fetch;
};

const EVENTS = defineEvents({
  cta_click: { source: "client", props: { id: ["hero", "pricing"] } },
  signup_requested: { source: "server" },
});

describe("client send", () => {
  const original = {
    navigator: globals.navigator,
    location: globals.location,
    fetch: globals.fetch,
  };
  let beacons: Beacon[];
  let fetches: { url: string; init: RequestInit }[];

  const useBeacon = (accepts: boolean) => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        sendBeacon: (url: string, data: Blob) => {
          void data
            .text()
            .then((body) => beacons.push({ url, body, type: data.type }));
          return accepts;
        },
      },
    });
  };

  const useNavigator = (value: object) => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value,
    });
  };

  beforeEach(() => {
    beacons = [];
    fetches = [];
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { pathname: "/projects/42" },
    });
    globals.fetch = (async (url: string, init: RequestInit) => {
      fetches.push({ url, init });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
  });

  const usePage = (search: string, referrer: string) => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { pathname: "/pricing", search },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { referrer },
    });
  };

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "document");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: original.navigator,
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: original.location,
    });
    globals.fetch = original.fetch;
  });

  test("sends the name, props and current path as a beacon", async () => {
    useBeacon(true);
    send("cta_click", { id: "hero" });
    await Bun.sleep(5);
    expect(beacons).toEqual([
      {
        url: "/api/events",
        body: JSON.stringify({
          name: "cta_click",
          props: { id: "hero" },
          path: "/projects/42",
        }),
        type: "text/plain;charset=utf-8",
      },
    ]);
    expect(fetches).toHaveLength(0);
  });

  test("posts to a custom endpoint", async () => {
    useBeacon(true);
    send("report_printed", {}, { endpoint: "/t" });
    await Bun.sleep(5);
    expect(beacons[0]?.url).toBe("/t");
  });

  test("falls back to a keepalive fetch when the beacon is refused", () => {
    useBeacon(false);
    send("report_printed");
    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.url).toBe("/api/events");
    expect(fetches[0]?.init.keepalive).toBe(true);
    expect(fetches[0]?.init.method).toBe("POST");
  });

  test("the fallback fetch carries the beacon's body and content type", async () => {
    useBeacon(false);
    send("cta_click", { id: "hero" });
    await Bun.sleep(5);
    const [sent] = beacons;
    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.init.body).toBe(sent?.body);
    expect(
      new Headers(fetches[0]?.init.headers).get("content-type")?.toLowerCase(),
    ).toBe(sent?.type);
  });

  test("falls back to fetch when sendBeacon is missing", () => {
    useNavigator({});
    send("report_printed");
    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.init.keepalive).toBe(true);
  });

  test("falls back to fetch when sendBeacon throws", () => {
    useNavigator({
      sendBeacon: () => {
        throw new TypeError("blocked");
      },
    });
    send("report_printed");
    expect(fetches).toHaveLength(1);
  });

  test("never throws, even with no browser globals", () => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: undefined,
    });
    expect(() => send("report_printed")).not.toThrow();
  });

  test("carries the page's campaign and referrer", async () => {
    useBeacon(true);
    usePage(
      "?utm_source=newsletter&utm_medium=email&utm_campaign=launch&ref=x",
      "https://www.news.example/story",
    );
    send("cta_click", { id: "hero" });
    await Bun.sleep(5);
    expect(JSON.parse(beacons[0]?.body ?? "{}")).toEqual({
      name: "cta_click",
      props: { id: "hero" },
      path: "/pricing",
      utm: {
        utm_source: "newsletter",
        utm_medium: "email",
        utm_campaign: "launch",
      },
      referrer: "https://www.news.example/story",
    });
  });

  test("sends no utm or referrer keys when the page has neither", async () => {
    useBeacon(true);
    usePage("?ref=x", "");
    send("cta_click");
    await Bun.sleep(5);
    expect(Object.keys(JSON.parse(beacons[0]?.body ?? "{}"))).toEqual([
      "name",
      "props",
      "path",
    ]);
  });

  test("sends only the campaign keys that are present", async () => {
    useBeacon(true);
    usePage("?utm_source=newsletter", "");
    send("cta_click");
    await Bun.sleep(5);
    expect(JSON.parse(beacons[0]?.body ?? "{}").utm).toEqual({
      utm_source: "newsletter",
    });
  });

  test("createClient sends through the registry, with its endpoint", async () => {
    useBeacon(true);
    const analytics = createClient<typeof EVENTS>({ endpoint: "/t" });
    analytics.send("cta_click", { id: "pricing" });
    analytics.send("cta_click");
    await Bun.sleep(5);
    expect(beacons.map((b) => b.url)).toEqual(["/t", "/t"]);
    expect(JSON.parse(beacons[0]?.body ?? "{}").props).toEqual({
      id: "pricing",
    });
    expect(JSON.parse(beacons[1]?.body ?? "{}").props).toEqual({});

    // @ts-expect-error a server-only event can't be sent from the browser
    analytics.send("signup_requested");
    // @ts-expect-error an unregistered name
    analytics.send("cta_clik");
    // @ts-expect-error a value outside the prop's allow-list
    analytics.send("cta_click", { id: "footer" });
    // @ts-expect-error a prop the event doesn't declare
    analytics.send("cta_click", { href: "/" });
  });
});
