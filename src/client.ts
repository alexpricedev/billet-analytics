// Browser half: one beacon per call, for interactions that never reach the
// server. Stores nothing in the browser; the server attributes and anonymises
// each beacon, and drops any event name or prop it hasn't allow-listed.

export type ClientProps = Record<string, string | number | boolean>;

export interface SendOptions {
  /** Where the site mounted the events handler. Default "/api/events". */
  endpoint?: string;
}

export function send(
  name: string,
  props: ClientProps = {},
  options: SendOptions = {},
): void {
  try {
    const endpoint = options.endpoint ?? "/api/events";
    const body = JSON.stringify({ name, props, path: location.pathname });
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon?.(endpoint, blob)) return;
    void fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Analytics must never break the page.
  }
}
