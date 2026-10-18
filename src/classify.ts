// Pure request classification: no database, no state. Turns a request into
// the coarse labels the event log stores.

// Strings are restricted to a slug-like alphabet so free text (and anything
// shaped like an email) can't get in.
export const SAFE_STRING = /^[\w .:/+-]{1,80}$/;

const BOT_PATTERN =
  /bot|crawl|spider|slurp|archiver|facebookexternalhit|embedly|preview|headless|lighthouse|pagespeed|curl|wget|python-|httpx|go-http-client|node-fetch|axios|okhttp|java\/|libwww|scrapy|monitor|uptime|pingdom|statuscake|scan/i;

export const isBot = (userAgent: string | null): boolean =>
  !userAgent || BOT_PATTERN.test(userAgent);

export const isPrefetch = (req: Request): boolean => {
  const purpose =
    req.headers.get("sec-purpose") ?? req.headers.get("purpose") ?? "";
  return /prefetch|prerender/i.test(purpose);
};

export const classifyUserAgent = (
  userAgent: string | null,
): { device: string; browser: string } => {
  const ua = userAgent ?? "";
  const device = /iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)
    ? "tablet"
    : /Mobi|iPhone|iPod|Android/i.test(ua)
      ? "mobile"
      : "desktop";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /SamsungBrowser/.test(ua)
        ? "Samsung Internet"
        : /Firefox\/|FxiOS/.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS/.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : "Other";
  return { device, browser };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Collapse a concrete path to a low-cardinality pattern: ids and tokens become
// placeholders and the query string is dropped, so nothing sensitive (magic
// link or invite tokens, record ids) is ever stored.
export const normalizePath = (path: string): string => {
  const pathname = path.split(/[?#]/)[0] || "/";
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .slice(0, 6)
    .map((segment) => {
      if (UUID.test(segment)) return ":id";
      if (/^\d+$/.test(segment)) return ":n";
      if (segment.length > 24 && /^[\w-]+$/.test(segment)) return ":token";
      return segment.slice(0, 40).toLowerCase();
    });
  return `/${segments.join("/")}`;
};

// 404s have no route, and the raw path of a probe is noise. Keep the first
// segment so "/wp-admin/..." and friends still group usefully.
export const notFoundBucket = (path: string): string => {
  const [first, ...rest] = normalizePath(path).split("/").filter(Boolean);
  if (!first) return "/";
  return rest.length > 0 ? `/${first}/*` : `/${first}`;
};

/** The referring host, or null for none, a malformed one, or the site itself. */
export const referrerHost = (
  req: Request,
  siteUrl: string | undefined = process.env.APP_URL,
): string | null => {
  const referer = req.headers.get("referer");
  if (!referer) return null;
  try {
    const host = new URL(referer).hostname.toLowerCase();
    const own = new URL(req.url).hostname.toLowerCase();
    const site = siteUrl ? new URL(siteUrl).hostname.toLowerCase() : own;
    return host === own || host === site ? null : host.replace(/^www\./, "");
  } catch {
    return null;
  }
};

export const utm = (url: URL, key: string): string | null => {
  const value = url.searchParams.get(key)?.trim().toLowerCase();
  return value && SAFE_STRING.test(value) ? value : null;
};

// A proxy such as Railway's appends the caller's address to X-Forwarded-For,
// so the last entry is the only one a caller can't forge. Without a proxy
// there is no header; pass your own `clientIp` to read the socket address.
export const forwardedClientIp = (req: Request): string =>
  req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
