import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { send } from "../src/client";

type Beacon = { url: string; body: string };

const globals = globalThis as unknown as {
  navigator: { sendBeacon?: (url: string, data: Blob) => boolean };
  location: { pathname: string };
  fetch: typeof fetch;
};

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
          void data.text().then((body) => beacons.push({ url, body }));
          return accepts;
        },
      },
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

  afterEach(() => {
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

  test("never throws, even with no browser globals", () => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: undefined,
    });
    expect(() => send("report_printed")).not.toThrow();
  });
});
