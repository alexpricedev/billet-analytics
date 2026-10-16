import { afterAll, describe, expect, test } from "bun:test";
import { down, up } from "../src/migration";
import { db } from "./helpers";

const tables = async (): Promise<string[]> =>
  (
    (await db`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name LIKE 'analytics_%'
      ORDER BY table_name
    `) as { table_name: string }[]
  ).map((r) => r.table_name);

describe("migration", () => {
  afterAll(async () => {
    await down(db);
    await up(db);
  });

  test("up creates both tables and their indexes; down removes them", async () => {
    await down(db);
    expect(await tables()).toEqual([]);

    await up(db);
    expect(await tables()).toEqual(["analytics_event", "analytics_salt"]);
    const indexes = (
      (await db`
        SELECT indexname FROM pg_indexes WHERE tablename = 'analytics_event'
        ORDER BY indexname
      `) as { indexname: string }[]
    ).map((r) => r.indexname);
    expect(indexes).toEqual([
      "analytics_event_pkey",
      "idx_analytics_event_name_time",
      "idx_analytics_event_time",
    ]);

    await down(db);
    expect(await tables()).toEqual([]);
  });

  test("down is safe to run twice", async () => {
    await down(db);
    await down(db);
    expect(await tables()).toEqual([]);
  });

  test("the source column only takes server or client", async () => {
    await up(db);
    let failed = false;
    try {
      await db`INSERT INTO analytics_event (name, source, visitor_hash) VALUES ('x', 'other', 'v')`;
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
