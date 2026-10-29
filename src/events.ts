import { SAFE_STRING } from "./classify";

/**
 * The type of one allowed prop: free text that passes `SAFE_STRING`, a finite
 * number, a boolean, or one of a fixed list of strings.
 */
export type PropSpec = "string" | "number" | "boolean" | readonly string[];

export interface EventSpec {
  /** "client" events may arrive through the events endpoint; "server" ones never do. */
  source: "server" | "client";
  /**
   * The human-readable name a report shows, e.g. "Signup requested". The name
   * stays the key the beacon sends and the column stores; only the read side
   * uses the label. Default: the name, humanised (`signup_requested` →
   * "Signup requested").
   */
  label?: string;
  props?: Readonly<Record<string, PropSpec>>;
}

export type EventRegistry = Readonly<Record<string, EventSpec>>;

export type PropValue = string | number | boolean;
export type EventProps = Record<string, PropValue>;

type ValueOf<P> = P extends readonly (infer V)[]
  ? V
  : P extends "string"
    ? string
    : P extends "number"
      ? number
      : P extends "boolean"
        ? boolean
        : never;

/** The props an event accepts, typed from its spec. */
export type PropsOf<S extends EventSpec> =
  S["props"] extends Readonly<Record<string, PropSpec>>
    ? { [K in keyof S["props"]]?: ValueOf<S["props"][K]> }
    : Record<string, never>;

/** The names in a registry a beacon may carry: its `source: "client"` events. */
export type ClientEventName<E extends EventRegistry> = {
  [K in keyof E]: E[K]["source"] extends "client" ? K : never;
}[keyof E] &
  string;

/** Recorded by `captureRequest`; a site's own registry can't redefine them. */
export const BUILT_IN_EVENTS = {
  page_view: { source: "server", label: "Page view" },
  form_submit: {
    source: "server",
    label: "Form submit",
    props: {
      outcome: ["ok", "redirect", "error", "rate_limited"],
      target: "string",
    },
  },
  not_found: { source: "server", label: "Not found" },
  server_error: { source: "server", label: "Server error" },
} as const satisfies EventRegistry;

export type BuiltInEvents = typeof BUILT_IN_EVENTS;

/**
 * Declare a site's events. Only the identity function: it exists so the names,
 * sources and prop types are inferred literally and `track` can check them.
 *
 *   export const EVENTS = defineEvents({
 *     signup_requested: { source: "server" },
 *     cta_click: { source: "client", props: { id: ["hero", "pricing"] } },
 *   });
 */
export const defineEvents = <const E extends EventRegistry>(events: E): E =>
  events;

export const mergeRegistry = <E extends EventRegistry>(
  events: E,
): BuiltInEvents & E => {
  for (const name of Object.keys(events)) {
    if (Object.hasOwn(BUILT_IN_EVENTS, name)) {
      throw new Error(
        `billet-analytics: "${name}" is a built-in event and can't be redefined`,
      );
    }
  }
  return { ...BUILT_IN_EVENTS, ...events };
};

// "signup_requested" -> "Signup requested". Words keep their case, so
// "CTA_click" -> "CTA click"; an explicit `label` is always the better choice
// for anything an automatic split would get wrong.
export const humanizeEventName = (name: string): string => {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return name;
  const [first, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
};

/**
 * The display names for a registry: each event's `label`, or its humanised
 * name. Built-in events are included, so this is the whole lexicon a report
 * needs. Frozen: it's shared by every report.
 */
export const createLexicon = <E extends EventRegistry>(
  registry: E,
): Readonly<Record<string, string>> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(registry).map(([name, spec]) => [
        name,
        spec.label ?? humanizeEventName(name),
      ]),
    ),
  );

/** Keep only allow-listed, well-typed props; strings must match SAFE_STRING. */
export const sanitizeProps = (
  registry: EventRegistry,
  name: string,
  input: unknown,
): EventProps => {
  const spec = (Object.hasOwn(registry, name) && registry[name]?.props) || {};
  if (typeof input !== "object" || input === null) return {};
  const out: EventProps = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(spec, key)) continue;
    const kind = spec[key];
    if (Array.isArray(kind)) {
      if (typeof value === "string" && kind.includes(value)) out[key] = value;
    } else if (kind === "string") {
      if (typeof value === "string" && SAFE_STRING.test(value)) {
        out[key] = value;
      }
    } else if (kind === "number") {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    } else if (kind === "boolean") {
      if (typeof value === "boolean") out[key] = value;
    }
  }
  return out;
};
