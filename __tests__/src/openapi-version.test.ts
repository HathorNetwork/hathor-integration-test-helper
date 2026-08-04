import { describe, test, expect } from "bun:test";

// `docs/openapi.yaml` declares `info.version`, and client generators stamp it
// into generated package metadata — so a stale value is worse than a missing
// one. Nothing else keeps it aligned with package.json: the schema validator
// only checks the document against the OpenAPI meta-schema, and it would call
// any semver string valid. This is the only thing that notices a release bump
// that forgot the spec.
describe("openapi document", () => {
  test("info.version matches package.json", async () => {
    const pkg = await Bun.file(
      new URL("../../package.json", import.meta.url),
    ).json();
    const spec = await Bun.file(
      new URL("../../docs/openapi.yaml", import.meta.url),
    ).text();

    // Deliberately a line match rather than a YAML parse: `info.version` is a
    // flat scalar, and matching the literal line keeps this test free of a
    // YAML dependency it would otherwise be the only reason to add.
    const match = spec.match(/^\s{2}version:\s*["']?([^"'\s]+)["']?\s*$/m);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(pkg.version);
  });
});
