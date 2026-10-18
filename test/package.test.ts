import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await Bun.file(join(root, path)).text()) as Record<
    string,
    unknown
  >;

describe("package manifest", () => {
  test("defines the scripts CI and the build rely on", async () => {
    const scripts = (await readJson("package.json")).scripts as Record<
      string,
      string
    >;
    for (const name of ["build", "check", "test"]) {
      expect(scripts[name]).toBeString();
    }
  });

  test("the browser entries pull in nothing from bun", async () => {
    // ./client and ./events are bundled into the page, so neither they nor
    // anything they import may reach for Bun's SQL.
    for (const file of ["src/client.ts", "src/events.ts", "src/classify.ts"]) {
      const source = await Bun.file(join(root, file)).text();
      expect(source).not.toInclude('from "bun"');
      expect(source).not.toInclude("./analytics");
      expect(source).not.toInclude("./report");
    }
  });

  test("every export target exists on disk", async () => {
    const pkg = await readJson("package.json");
    const targets: string[] = [];
    for (const entry of Object.values(
      pkg.exports as Record<string, Record<string, string>>,
    )) {
      targets.push(...Object.values(entry));
    }
    for (const key of ["module", "types"]) {
      targets.push(pkg[key] as string);
    }
    for (const target of targets) {
      expect(existsSync(join(root, target))).toBe(true);
    }
  });
});
