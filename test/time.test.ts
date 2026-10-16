import { describe, expect, test } from "bun:test";
import {
  assertTimeZone,
  localDay,
  roundTimestamp,
  startOfDay,
} from "../src/time";

describe("time", () => {
  test("rounds to the hour by default, or the day, or not at all", () => {
    const at = new Date("2026-10-07T14:37:12.345Z");
    expect(roundTimestamp("hour", at).toISOString()).toBe(
      "2026-10-07T14:00:00.000Z",
    );
    expect(roundTimestamp("day", at).toISOString()).toBe(
      "2026-10-07T00:00:00.000Z",
    );
    expect(roundTimestamp("none", at).toISOString()).toBe(
      "2026-10-07T14:37:12.345Z",
    );
  });

  test("localDay follows the zone, not UTC", () => {
    // 00:30 BST on 7 October is still 6 October in UTC.
    expect(localDay("Europe/London", new Date("2026-10-06T23:30:00Z"))).toBe(
      "2026-10-07",
    );
    expect(localDay("UTC", new Date("2026-10-06T23:30:00Z"))).toBe(
      "2026-10-06",
    );
    expect(localDay("America/New_York", new Date("2026-10-07T02:00:00Z"))).toBe(
      "2026-10-06",
    );
  });

  test("startOfDay is local midnight, across clock changes", () => {
    const london = "Europe/London";
    expect(
      startOfDay(london, new Date("2026-10-07T12:00:00Z")).toISOString(),
    ).toBe("2026-10-06T23:00:00.000Z");
    expect(
      startOfDay(london, new Date("2026-12-07T12:00:00Z")).toISOString(),
    ).toBe("2026-12-07T00:00:00.000Z");
    // Seven days back from 1 November (GMT) is 25 October (BST until 01:00 UTC).
    expect(
      startOfDay(london, new Date("2026-11-01T12:00:00Z"), 7).toISOString(),
    ).toBe("2026-10-24T23:00:00.000Z");
    expect(
      startOfDay(
        "America/New_York",
        new Date("2026-07-01T12:00:00Z"),
      ).toISOString(),
    ).toBe("2026-07-01T04:00:00.000Z");
  });

  test("an unknown zone is refused", () => {
    expect(() => assertTimeZone("Mars/Olympus")).toThrow(RangeError);
  });
});
