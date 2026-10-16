// Calendar arithmetic in one IANA time zone. The salt rotates, the purge keeps
// and the read side buckets on the same local day, so a visitor at 00:30 and
// 09:00 local time is one visitor that day, not two.

export type Rounding = "hour" | "day" | "none";

const dayFormats = new Map<string, Intl.DateTimeFormat>();
const clockFormats = new Map<string, Intl.DateTimeFormat>();

const dayFormat = (timeZone: string): Intl.DateTimeFormat => {
  let format = dayFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormats.set(timeZone, format);
  }
  return format;
};

const clockFormat = (timeZone: string): Intl.DateTimeFormat => {
  let format = clockFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    clockFormats.set(timeZone, format);
  }
  return format;
};

/** Throws a RangeError on a zone the runtime doesn't know. */
export const assertTimeZone = (timeZone: string): void => {
  dayFormat(timeZone);
};

/** The local date, as YYYY-MM-DD. */
export const localDay = (timeZone: string, date = new Date()): string =>
  dayFormat(timeZone).format(date);

// How far the zone's wall clock is ahead of UTC at an instant, in ms.
const offsetAt = (timeZone: string, at: number): number => {
  const parts = Object.fromEntries(
    clockFormat(timeZone)
      .formatToParts(new Date(at))
      .map((p) => [p.type, Number(p.value)]),
  );
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return wall - Math.floor(at / 1000) * 1000;
};

/**
 * Midnight at the start of the local day `daysBack` days before `now`'s local
 * day. The offset is read twice, the second time at the first guess, so a
 * zone whose clocks change near midnight still lands on the right instant.
 */
export const startOfDay = (
  timeZone: string,
  now = new Date(),
  daysBack = 0,
): Date => {
  const [y, m, d] = localDay(timeZone, now).split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const wallMidnight = Date.UTC(y, m - 1, d - daysBack);
  const guess = wallMidnight - offsetAt(timeZone, wallMidnight);
  return new Date(wallMidnight - offsetAt(timeZone, guess));
};

/**
 * Stored timestamps are coarse on purpose: most events happen at the same
 * moment as a write to an account table, so an exact time would let the two be
 * joined and the visitor hash tied to a person. Rounds on the zone's wall
 * clock, so a "day" row sits at local midnight and lands in its local-day
 * bucket, and an "hour" row in a half-hour zone (Asia/Kolkata) stays on the
 * local hour.
 */
export const roundTimestamp = (
  rounding: Rounding,
  timeZone: string,
  now = new Date(),
): Date => {
  if (rounding === "day") return startOfDay(timeZone, now);
  if (rounding === "hour") {
    const at = now.getTime();
    const offset = offsetAt(timeZone, at);
    const wall = at + offset;
    return new Date(
      wall - (((wall % 3_600_000) + 3_600_000) % 3_600_000) - offset,
    );
  }
  return new Date(now);
};
