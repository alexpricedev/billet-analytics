// Browser half: one beacon per call, for interactions that never reach the
// server. Stores nothing in the browser; the server attributes and anonymises
// each beacon, and drops any event name or prop it hasn't allow-listed.

export type ClientProps = Record<string, string | number | boolean>;

export interface SendOptions {
  /** Where the site mounted the events handler. Default "/api/events". */
  endpoint?: string;
}

const CONTENT_TYPE = "text/plain;charset=UTF-8";

export function send(
  name: string,
  props: ClientProps = {},
  options: SendOptions = {},
): void {
  try {
    const endpoint = options.endpoint ?? "/api/events";
    const body = JSON.stringify({ name, props, path: location.pathname });
    // text/plain keeps both requests CORS-simple; the endpoint ignores Content-Type.
    const blob = new Blob([body], { type: CONTENT_TYPE });
    try {
      if (navigator.sendBeacon?.(endpoint, blob)) return;
    } catch {
      // A throwing or missing sendBeacon falls through to fetch.
    }
    void fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": CONTENT_TYPE },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Analytics must never break the page.
  }
}
