import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { readCoverageProfileUrls } from "./coverage-profiles.ts";

describe("coverage-profiles", () => {
  describe("readCoverageProfileUrls()", () => {
    it("returns the script URL of each profile in the directory", async () => {
      const dir = await Deno.makeTempDir();
      try {
        await Deno.writeTextFile(
          join(dir, "a.json"),
          JSON.stringify({ url: "file:///a.ts", functions: [] }, null, 2),
        );
        await Deno.writeTextFile(
          join(dir, "b.json"),
          JSON.stringify({ url: "file:///b.ts", functions: [] }, null, 2),
        );

        const urls = await readCoverageProfileUrls(dir);

        expect(urls.toSorted()).toEqual(["file:///a.ts", "file:///b.ts"]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("throws naming a profile that ends partway through", async () => {
      const dir = await Deno.makeTempDir();
      try {
        const whole = JSON.stringify(
          { url: "file:///a.ts", functions: [] },
          null,
          2,
        );
        await Deno.writeTextFile(
          join(dir, "cut.json"),
          whole.slice(0, whole.length / 2),
        );

        await expect(readCoverageProfileUrls(dir)).rejects.toThrow(
          "coverage profile cut.json is incomplete",
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });
});
