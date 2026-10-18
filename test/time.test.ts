import { describe, expect, test } from "bun:test";
import {
  assertTimeZone,
  localDay,
  roundTimestamp,
  startOfDay,
} from "../src/time";

describe("time", () => {
  test("rounds to the local hour, or the local day, or not at all", () => {
    const at = new Date("2026-10-07T14:37:12.345Z");
    expect(roundTimestamp("hour", "Europe/London", at).toISOString()).toBe(
      "2026-10-07T14:00:00.000Z",
    );
    expect(roundTimestamp("none", "Europe/London", at).toISOString()).toBe(
      "2026-10-07T14:37:12.345Z",
    );
  });

  test("day rounding lands on local midnight in BST", () => {
    // 00:30 BST on 7 October is 23:30 UTC on the 6th.
    const at = new Date("2026-10-06T23:30:00Z");
    const day = roundTimestamp("day", "Europe/London", at);
    expect(day.toISOString()).toBe("2026-10-06T23:00:00.000Z");
    expect(localDay("Europe/London", day)).toBe("2026-10-07");
  });

  test("rounding follows a half-hour zone (Asia/Kolkata, UTC+5:30)", () => {
    // 20:07 local on 7 October.
    const at = new Date("2026-10-07T14:37:12.345Z");
    expect(roundTimestamp("hour", "Asia/Kolkata", at).toISOString()).toBe(
      "2026-10-07T14:30:00.000Z",
    );
    // 03:00 local on the 8th is still the 7th in UTC.
    const early = new Date("2026-10-07T21:30:00Z");
    const day = roundTimestamp("day", "Asia/Kolkata", early);
    expect(day.toISOString()).toBe("2026-10-07T18:30:00.000Z");
    expect(localDay("Asia/Kolkata", day)).toBe("2026-10-08");
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
