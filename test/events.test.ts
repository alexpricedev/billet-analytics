import { describe, expect, test } from "bun:test";
import {
  BUILT_IN_EVENTS,
  createLexicon,
  defineEvents,
  humanizeEventName,
  mergeRegistry,
  sanitizeProps,
} from "../src/events";

const EVENTS = mergeRegistry(
  defineEvents({
    interest_registered: {
      source: "server",
      label: "Interest registered",
      props: { depth: ["simple", "advanced"] },
    },
    cta_click: { source: "client", props: { id: ["hero", "pricing"] } },
    projects_compared: { source: "server", props: { count: "number" } },
    magic_link_verified: { source: "server", props: { new_user: "boolean" } },
    search: { source: "client", props: { term: "string" } },
  }),
);

describe("events", () => {
  test("sanitizeProps keeps only allow-listed, well-typed values", () => {
    expect(
      sanitizeProps(EVENTS, "interest_registered", {
        depth: "advanced",
        email: "x",
      }),
    ).toEqual({ depth: "advanced" });
    expect(
      sanitizeProps(EVENTS, "interest_registered", { depth: "other" }),
    ).toEqual({});
    expect(sanitizeProps(EVENTS, "projects_compared", { count: "3" })).toEqual(
      {},
    );
    expect(sanitizeProps(EVENTS, "projects_compared", { count: 3 })).toEqual({
      count: 3,
    });
    expect(
      sanitizeProps(EVENTS, "projects_compared", { count: Number.NaN }),
    ).toEqual({});
    expect(
      sanitizeProps(EVENTS, "magic_link_verified", { new_user: "true" }),
    ).toEqual({});
    expect(
      sanitizeProps(EVENTS, "magic_link_verified", { new_user: true }),
    ).toEqual({ new_user: true });
    expect(sanitizeProps(EVENTS, "page_view", null)).toEqual({});
    expect(sanitizeProps(EVENTS, "page_view", { anything: "x" })).toEqual({});
  });

  test("free-text props must pass SAFE_STRING, so no email gets in", () => {
    expect(sanitizeProps(EVENTS, "search", { term: "solar panels" })).toEqual({
      term: "solar panels",
    });
    expect(
      sanitizeProps(EVENTS, "search", { term: "someone@example.com" }),
    ).toEqual({});
    expect(sanitizeProps(EVENTS, "search", { term: "x".repeat(81) })).toEqual(
      {},
    );
  });

  test("finite props only take their known values", () => {
    expect(sanitizeProps(EVENTS, "cta_click", { id: "hero" })).toEqual({
      id: "hero",
    });
    expect(sanitizeProps(EVENTS, "cta_click", { id: "my-typed-note" })).toEqual(
      {},
    );
  });

  test("unknown events and inherited keys get no props", () => {
    expect(sanitizeProps(EVENTS, "made_up", { id: "hero" })).toEqual({});
    expect(sanitizeProps(EVENTS, "toString", { id: "hero" })).toEqual({});
    expect(
      sanitizeProps(EVENTS, "cta_click", JSON.parse('{"__proto__":"hero"}')),
    ).toEqual({});
  });

  test("the four automatic events are built in", () => {
    expect(Object.keys(EVENTS)).toEqual(
      expect.arrayContaining(Object.keys(BUILT_IN_EVENTS)),
    );
    expect(
      sanitizeProps(EVENTS, "form_submit", {
        outcome: "redirect",
        target: "/projects/:id",
      }),
    ).toEqual({ outcome: "redirect", target: "/projects/:id" });
  });

  test("a site can't redefine a built-in event", () => {
    expect(() =>
      mergeRegistry({ page_view: { source: "client" } } as const),
    ).toThrow(/built-in/);
  });

  test("humanizeEventName turns an identifier into a sentence", () => {
    expect(humanizeEventName("signup_requested")).toBe("Signup requested");
    expect(humanizeEventName("cta-click")).toBe("Cta click");
    expect(humanizeEventName("upload")).toBe("Upload");
    expect(humanizeEventName("")).toBe("");
  });

  test("the lexicon prefers a label and humanises the rest", () => {
    const lexicon = createLexicon(EVENTS);
    expect(lexicon).toMatchObject({
      page_view: "Page view",
      form_submit: "Form submit",
      not_found: "Not found",
      server_error: "Server error",
      interest_registered: "Interest registered",
      cta_click: "Cta click",
      magic_link_verified: "Magic link verified",
    });
    expect(Object.isFrozen(lexicon)).toBe(true);
  });
});
