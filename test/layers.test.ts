/**
 * Keel's check_imports, ported: levels point one way. A layer that imports the wrong way fails
 * here with the file and the import named.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "../src");

/** layer → layers it may import from (besides itself). */
const ALLOWED: Record<string, string[]> = {
  agents: [], // the runtime knows nothing of the application: not one import
  domain: ["agents"], // types and rules; the answer shapes are the runtime's OutputShape
  ports: ["agents", "domain"],
  adapters: ["agents", "domain", "ports"],
  services: ["agents", "domain", "ports"], // never an adapter: they arrive through assembly
  api: ["assembly", "services"], // interfaces are thin: they call services, nothing below them
  assembly: ["agents", "domain", "ports", "adapters", "services", "api"],
  main: ["assembly", "api"],
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

const layerOf = (path: string) => relative(SRC, path).split(/[/\\]/)[0].replace(/\.ts$/, "");

describe("layers", () => {
  it("import only in the allowed direction", () => {
    const wrong: string[] = [];
    for (const file of files(SRC)) {
      const from = layerOf(file);
      for (const [, spec] of readFileSync(file, "utf8").matchAll(/from\s+"(\.[^"]+)"/g)) {
        const to = layerOf(resolve(dirname(file), spec));
        if (to !== from && !ALLOWED[from]?.includes(to)) wrong.push(`${relative(SRC, file)} imports ${spec} (${from} → ${to})`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
