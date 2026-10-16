import { describe, expect, test } from "bun:test";
import {
  classifyUserAgent,
  forwardedClientIp,
  isBot,
  isPrefetch,
  normalizePath,
  notFoundBucket,
  referrerHost,
  utm,
} from "../src/classify";

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPAD =
  "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const FIREFOX =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";
const EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 Edg/128.0";

describe("classify", () => {
  test("normalizePath collapses ids and tokens and drops the query", () => {
    expect(
      normalizePath("/projects/0b6f7c1e-4c1a-4a0e-9a8e-2f3c4d5e6f70?x=1"),
    ).toBe("/projects/:id");
    expect(
      normalizePath("/invites/accept?token=abcdefghijklmnopqrstuvwxyz123"),
    ).toBe("/invites/accept");
    expect(normalizePath("/a/abcdefghijklmnopqrstuvwxyz0123456789")).toBe(
      "/a/:token",
    );
    expect(normalizePath("/team/members/42/role")).toBe(
      "/team/members/:n/role",
    );
    expect(normalizePath("/About#team")).toBe("/about");
    expect(normalizePath("/a/b/c/d/e/f/g/h")).toBe("/a/b/c/d/e/f");
    expect(normalizePath("")).toBe("/");
  });

  test("notFoundBucket keeps only the first segment", () => {
    expect(notFoundBucket("/wp-admin/setup-config.php")).toBe("/wp-admin/*");
    expect(notFoundBucket("/nope")).toBe("/nope");
    expect(notFoundBucket("/")).toBe("/");
  });

  test("isBot flags crawlers, scripts and missing user agents", () => {
    expect(isBot("Googlebot/2.1 (+http://www.google.com/bot.html)")).toBe(true);
    expect(isBot("curl/8.4.0")).toBe(true);
    expect(isBot("Mozilla/5.0 HeadlessChrome/128.0")).toBe(true);
    expect(isBot(null)).toBe(true);
    expect(isBot(CHROME)).toBe(false);
  });

  test("isPrefetch reads Sec-Purpose and Purpose", () => {
    const req = (headers: Record<string, string>) =>
      new Request("https://site.test/", { headers });
    expect(isPrefetch(req({ "sec-purpose": "prefetch;prerender" }))).toBe(true);
    expect(isPrefetch(req({ purpose: "prefetch" }))).toBe(true);
    expect(isPrefetch(req({}))).toBe(false);
  });

  test("classifyUserAgent reduces a UA to coarse labels", () => {
    expect(classifyUserAgent(CHROME)).toEqual({
      device: "desktop",
      browser: "Chrome",
    });
    expect(classifyUserAgent(IPHONE)).toEqual({
      device: "mobile",
      browser: "Safari",
    });
    expect(classifyUserAgent(IPAD).device).toBe("tablet");
    expect(classifyUserAgent(FIREFOX).browser).toBe("Firefox");
    expect(classifyUserAgent(EDGE).browser).toBe("Edge");
    expect(classifyUserAgent(null)).toEqual({
      device: "desktop",
      browser: "Other",
    });
  });

  test("referrerHost keeps external hosts and drops the site's own", () => {
    const from = (referer: string) =>
      new Request("https://site.test/about", { headers: { referer } });
    expect(referrerHost(from("https://www.linkedin.com/feed/x"))).toBe(
      "linkedin.com",
    );
    expect(referrerHost(from("https://site.test/"))).toBeNull();
    expect(
      referrerHost(from("https://example.org/"), "https://example.org"),
    ).toBeNull();
    expect(referrerHost(from("not a url"))).toBeNull();
    expect(referrerHost(new Request("https://site.test/"))).toBeNull();
  });

  test("utm lowercases campaign tags and drops anything unsafe", () => {
    const url = new URL(
      "https://site.test/?utm_source=Newsletter&utm_campaign=me@example.com",
    );
    expect(utm(url, "utm_source")).toBe("newsletter");
    expect(utm(url, "utm_campaign")).toBeNull();
    expect(utm(url, "utm_medium")).toBeNull();
  });

  test("forwardedClientIp takes the last X-Forwarded-For entry", () => {
    const req = new Request("https://site.test/", {
      headers: { "x-forwarded-for": "10.0.0.1, 198.51.100.4" },
    });
    expect(forwardedClientIp(req)).toBe("198.51.100.4");
    expect(forwardedClientIp(new Request("https://site.test/"))).toBe(
      "unknown",
    );
  });
});
