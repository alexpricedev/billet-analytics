import type { SQL } from "bun";

// The read side: a few plain queries a site can build its own report on. No
// rendering. Visitor hashes rotate daily, so "visitors" over a range is the
// sum of daily uniques, the same number Plausible-style tools report.

export interface Period {
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
}

export interface Kpis {
  visitors: number;
  pageViews: number;
  /** Every event in the period, page views included. */
  events: number;
  /** Count per event name asked for in `events`; 0 when none happened. */
  counts: Record<string, number>;
}

export interface SeriesPoint {
  /** The local date the bucket starts on, YYYY-MM-DD. */
  bucket: string;
  visitors: number;
  pageViews: number;
}

export interface Tally {
  label: string;
  count: number;
  visitors: number;
}

export interface EventTally extends Tally {
  /** Every source the event arrived from, e.g. "server" or "client, server". */
  sources: string;
}

export interface EventSeriesPoint {
  /** The local date the bucket starts on, YYYY-MM-DD. */
  bucket: string;
  count: number;
  visitors: number;
}

/** Group by one of an event's props instead of a column, e.g. `{ prop: "id" }`. */
export interface PropDimension {
  prop: string;
}

// Props are free-form keys, so the key is checked before it is used, even
// though it is bound as a parameter rather than spliced into the SQL.
const PROP_KEY = /^[a-z0-9_]{1,40}$/i;

export const DIMENSIONS = [
  "route",
  "referrer_host",
  "device",
  "browser",
  "utm_source",
  "utm_medium",
  "utm_campaign",
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

const iso = (date: Date): string => date.toISOString();

export const createReport = (db: SQL, timeZone: string) => {
  const kpis = async (
    { from, to }: Period,
    options: { events?: readonly string[] } = {},
  ): Promise<Kpis> => {
    const [row] = await db`
      SELECT
        count(DISTINCT visitor_hash)::int AS visitors,
        count(*) FILTER (WHERE name = 'page_view')::int AS page_views,
        count(*)::int AS events
      FROM analytics_event
      WHERE occurred_at >= ${iso(from)} AND occurred_at < ${iso(to)}
    `;
    const r = row as { visitors: number; page_views: number; events: number };

    const names = [...new Set(options.events ?? [])];
    const counts: Record<string, number> = Object.fromEntries(
      names.map((name) => [name, 0]),
    );
    if (names.length > 0) {
      const rows = await db`
        SELECT name, count(*)::int AS count
        FROM analytics_event
        WHERE name IN ${db(names)}
          AND occurred_at >= ${iso(from)} AND occurred_at < ${iso(to)}
        GROUP BY name
      `;
      for (const { name, count } of rows as { name: string; count: number }[]) {
        counts[name] = count;
      }
    }

    return {
      visitors: r.visitors,
      pageViews: r.page_views,
      events: r.events,
      counts,
    };
  };

  // Buckets are local dates in the configured zone, with empty days filled in
  // so a chart has one point per day (or ISO week).
  const timeSeries = async (
    { from, to }: Period,
    unit: "day" | "week" = "day",
  ): Promise<SeriesPoint[]> => {
    const rows = await db`
      WITH buckets AS (
        SELECT generate_series(
          date_trunc(${unit}, ${iso(from)}::timestamptz AT TIME ZONE ${timeZone}),
          date_trunc(${unit}, (${iso(to)}::timestamptz - interval '1 microsecond') AT TIME ZONE ${timeZone}),
          ('1 ' || ${unit})::interval
        ) AS bucket
      ),
      counts AS (
        SELECT
          date_trunc(${unit}, occurred_at AT TIME ZONE ${timeZone}) AS bucket,
          count(DISTINCT visitor_hash)::int AS visitors,
          count(*) FILTER (WHERE name = 'page_view')::int AS page_views
        FROM analytics_event
        WHERE occurred_at >= ${iso(from)} AND occurred_at < ${iso(to)}
        GROUP BY 1
      )
      SELECT to_char(b.bucket, 'YYYY-MM-DD') AS bucket,
             coalesce(c.visitors, 0)::int AS visitors,
             coalesce(c.page_views, 0)::int AS page_views
      FROM buckets b LEFT JOIN counts c USING (bucket)
      ORDER BY b.bucket
    `;
    return (
      rows as { bucket: string; visitors: number; page_views: number }[]
    ).map((r) => ({
      bucket: r.bucket,
      visitors: r.visitors,
      pageViews: r.page_views,
    }));
  };

  // Buckets as above, but one event's count and uniques rather than visits.
  const eventSeries = async (
    { from, to }: Period,
    name: string,
    unit: "day" | "week" = "day",
  ): Promise<EventSeriesPoint[]> => {
    const rows = await db`
      WITH buckets AS (
        SELECT generate_series(
          date_trunc(${unit}, ${iso(from)}::timestamptz AT TIME ZONE ${timeZone}),
          date_trunc(${unit}, (${iso(to)}::timestamptz - interval '1 microsecond') AT TIME ZONE ${timeZone}),
          ('1 ' || ${unit})::interval
        ) AS bucket
      ),
      counts AS (
        SELECT
          date_trunc(${unit}, occurred_at AT TIME ZONE ${timeZone}) AS bucket,
          count(*)::int AS count,
          count(DISTINCT visitor_hash)::int AS visitors
        FROM analytics_event
        WHERE name = ${name}
          AND occurred_at >= ${iso(from)} AND occurred_at < ${iso(to)}
        GROUP BY 1
      )
      SELECT to_char(b.bucket, 'YYYY-MM-DD') AS bucket,
             coalesce(c.count, 0)::int AS count,
             coalesce(c.visitors, 0)::int AS visitors
      FROM buckets b LEFT JOIN counts c USING (bucket)
      ORDER BY b.bucket
    `;
    return [...rows] as EventSeriesPoint[];
  };

  const propBreakdown = async (
    { from, to }: Period,
    key: string,
    options: { event?: string; limit?: number } = {},
  ): Promise<Tally[]> => {
    if (!PROP_KEY.test(key)) {
      throw new Error(`billet-analytics: unusable prop key "${key}"`);
    }
    const rows = await db`
      SELECT props->>${key} AS label, count(*)::int AS count,
             count(DISTINCT visitor_hash)::int AS visitors
      FROM analytics_event
      WHERE name = ${options.event ?? "page_view"} AND props->>${key} IS NOT NULL
        AND occurred_at >= ${iso(from)} AND occurred_at < ${iso(to)}
      GROUP BY 1 ORDER BY visitors DESC, count DESC, label
      LIMIT ${options.limit ?? 10}
    `;
    return [...rows] as Tally[];
  };

  const breakdown = async (
    period: Period,
    dimension: Dimension | PropDimension,
    options: { event?: string; limit?: number } = {},
  ): Promise<Tally[]> => {
    if (typeof dimension === "object") {
      return propBreakdown(period, dimension.prop, options);
    }
    const { from, to } = period;
    // The column comes from a closed list, never from input.
    if (!DIMENSIONS.includes(dimension)) {
      throw new Error(`billet-analytics: unknown dimension "${dimension}"`);
    }
    const column = db(dimension);
    const rows = await db`
      SELECT ${column} AS label, count(*)::int AS count,
             count(DISTINCT visitor_hash)::int AS visitors
      FROM analytics_event
      WHERE name = ${options.event ?? "page_view"} AND ${column} IS NOT NULL
        AND occurred_at >= ${iso(from)} AND occurred_at < ${iso(to)}
      GROUP BY 1 ORDER BY visitors DESC, count DESC, label
      LIMIT ${options.limit ?? 10}
    `;
    return [...rows] as Tally[];
  };

  const eventTallies = async ({ from, to }: Period): Promise<EventTally[]> => {
    const rows = await db`
      SELECT name AS label,
             string_agg(DISTINCT source, ', ' ORDER BY source) AS sources,
             count(*)::int AS count,
             count(DISTINCT visitor_hash)::int AS visitors
      FROM analytics_event
      WHERE occurred_at >= ${iso(from)} AND occurred_at < ${iso(to)}
      GROUP BY name ORDER BY count DESC, name
    `;
    return [...rows] as EventTally[];
  };

  return { kpis, timeSeries, eventSeries, breakdown, eventTallies };
};
