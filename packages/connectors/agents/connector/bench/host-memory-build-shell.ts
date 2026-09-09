/** Builds the production shell into private benchmark output. */

import { copy } from "@std/fs";
import { fromFileUrl, relative } from "@std/path";
import { Builder } from "../../../../felt/builder.ts";
import { ResolvedConfig } from "../../../../felt/interface.ts";

const directory = Deno.args[0];
if (!directory) {
  throw new Error("An absolute shell output directory is required");
}
Deno.env.delete("API_URL");
Deno.env.set("PRODUCTION", "1");
Deno.env.set("EXPERIMENTAL_SERVER_EXECUTION", "false");
// deno-lint-ignore cf-imports/no-inline-module-import -- The build reads the environment installed above.
const { default: config } = await import("../../../../shell/felt.config.ts");
const root = fromFileUrl(new URL("../../../../shell/", import.meta.url));
const resolved = new ResolvedConfig({
  ...config,
  outDir: relative(root, directory),
}, root);
await copy(resolved.publicDir, resolved.outDir, { overwrite: true });
await new Builder(resolved).build();
