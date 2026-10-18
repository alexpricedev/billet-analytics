# Changelog

All notable changes to this project are documented here. This project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0]

Added

- `createClient<typeof EVENTS>()` in `./client`: a `send` checked against the registry, so an unknown name, a `source: "server"` event or a prop outside its allow-list fails typecheck instead of being dropped in silence.
- `./events` entry point, exporting `defineEvents` and the registry types with nothing imported from Bun, so the registry can be shared with a browser bundle.
- `onDrop(reason, req)` config. Every dropped client event — refused by the endpoint, or dropped later as a bot, an excluded caller or an unregistered name — reports why. Default: `console.warn`, off under `NODE_ENV` `production` and `test`.
- Client events carry attribution. Each beacon sends the page's `utm_source`, `utm_medium`, `utm_campaign` and `document.referrer`, sanitised server-side exactly as a page view's are, so a click can be tied to the campaign that brought the visitor without joining on `visitor_hash` and day.
- `report.eventSeries(period, name, unit)`: a per-event time series on the same buckets as `timeSeries`.
- `report.breakdown(period, { prop: "id" }, { event })`: group an event by one of its own props.
- `hostFromReferrer` and `utmValue` are exported alongside the other pure helpers.

Changed

- The tests refuse to run unless `DATABASE_URL` names a database ending in `-test`; they drop and recreate both tables.
- The daily salt lookup falls back to the salt it just offered if the row disappears between the insert and the select, instead of throwing the event away.

## [0.1.0]

- Initial release: `createAnalytics`
  with a typed event registry (`defineEvents`), automatic request capture, `track`,
  the `/api/events` beacon handler, the client `send()` helper, the `analytics_event`
  and `analytics_salt` migration, retention purge, and a small read side (KPIs, daily
  or weekly series, one-dimension breakdowns, event tallies).
