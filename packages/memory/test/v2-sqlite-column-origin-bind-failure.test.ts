// The column-origin binding after a bind that failed. Deno gives each test file
// its own module state, so the failure recorded here cannot reach
// v2-sqlite-column-origin-unbound.test.ts, which needs a module that has never
// tried to bind.

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  columnOrigins,
  columnOriginUnavailableReason,
  ensureColumnOriginAvailable,
} from "../v2/sqlite/column-origin.ts";

Deno.test("a bind failure is recorded and surfaces in the reason and the throw", async () => {
  // Point @db/sqlite's own loader at a file that is not a library — the shape
  // of a libsqlite3 built without SQLITE_ENABLE_COLUMN_METADATA, which loads
  // for @db/sqlite but exposes no column-origin symbols.
  // ensureColumnOriginAvailable must resolve false, record why, and make a
  // later labeled read throw the reason.

  const notALibrary = Deno.makeTempFileSync({ suffix: ".dylib" });
  Deno.writeTextFileSync(notALibrary, "not a library");
  const previous = Deno.env.get("DENO_SQLITE_PATH");
  Deno.env.set("DENO_SQLITE_PATH", notALibrary);
  try {
    assertEquals(await ensureColumnOriginAvailable(), false);

    const reason = columnOriginUnavailableReason();
    assertStringIncludes(reason ?? "", "$DENO_SQLITE_PATH");
    assertStringIncludes(reason ?? "", notALibrary);

    // A labeled read now fails loudly, carrying the recorded reason rather than
    // the generic "must resolve first" message.
    assertThrows(() => columnOrigins(null, 1), Error, reason!);
  } finally {
    if (previous === undefined) {
      Deno.env.delete("DENO_SQLITE_PATH");
    } else {
      Deno.env.set("DENO_SQLITE_PATH", previous);
    }
    Deno.removeSync(notALibrary);
  }
});
