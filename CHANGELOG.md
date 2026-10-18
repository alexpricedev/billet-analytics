# Changelog

All notable changes to this project are documented here. This project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0]

- Initial release: `createAnalytics`
  with a typed event registry (`defineEvents`), automatic request capture, `track`,
  the `/api/events` beacon handler, the client `send()` helper, the `analytics_event`
  and `analytics_salt` migration, retention purge, and a small read side (KPIs, daily
  or weekly series, one-dimension breakdowns, event tallies).
