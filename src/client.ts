// Browser half: one beacon per call, for interactions that never reach the
// server. Stores nothing in the browser; the server attributes and anonymises
// each beacon, and drops any event name or prop it hasn't allow-listed.

import type { ClientEventName, EventRegistry, PropsOf } from "./events";

export type { ClientEventName } from "./events";

export type ClientProps = Record<string, string | number | boolean>;

export interface SendOptions {
  /** Where the site mounted the events handler. Default "/api/events". */
  endpoint?: string;
}

const CONTENT_TYPE = "text/plain;charset=UTF-8";

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign"] as const;

interface Attribution {
  utm?: Record<string, string>;
  referrer?: string;
}

// A beacon's own URL carries no campaign and its Referer is the page itself,
// so the page's UTM parameters and referrer travel in the body instead. Both
// are re-sanitised server-side; nothing here is trusted.
const attribution = (): Attribution => {
  const out: Attribution = {};
  try {
    const params = new URLSearchParams(location.search ?? "");
    const utm: Record<string, string> = {};
    for (const key of UTM_KEYS) {
      const value = params.get(key);
      if (value) utm[key] = value;
    }
    if (Object.keys(utm).length > 0) out.utm = utm;
  } catch {
    // No location, or an unparseable query string: send no campaign.
  }
  try {
    if (document.referrer) out.referrer = document.referrer;
  } catch {
    // No document: send no referrer.
  }
  return out;
};

export function send(
  name: string,
  props: ClientProps = {},
  options: SendOptions = {},
): void {
  try {
    const endpoint = options.endpoint ?? "/api/events";
    const body = JSON.stringify({
      name,
      props,
      path: location.pathname,
      ...attribution(),
    });
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

export interface Client<E extends EventRegistry> {
  send<N extends ClientEventName<E>>(name: N, props?: PropsOf<E[N]>): void;
}

/**
 * `send`, checked against the site's registry. An unknown name, a
 * `source: "server"` event or a prop outside its allow-list fails typecheck
 * instead of being dropped silently by the endpoint.
 *
 *   // analytics.events.ts — safe to import in the browser
 *   import { defineEvents } from "@alexpricedev/billet-analytics/events";
 *   export const EVENTS = defineEvents({
 *     cta_click: { source: "client", props: { id: ["hero", "pricing"] } },
 *   });
 *
 *   // in the browser
 *   import { createClient } from "@alexpricedev/billet-analytics/client";
 *   const analytics = createClient<typeof EVENTS>();
 *   analytics.send("cta_click", { id: "hero" });
 */
export const createClient = <E extends EventRegistry>(
  options: SendOptions = {},
): Client<E> => ({
  send: (name, props) => send(name, (props ?? {}) as ClientProps, options),
});
