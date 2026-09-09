/** Verifies deterministic inventory selection and private scratch recovery. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { NativeInventory } from "../../src/drivers/native-inventory.ts";

describe("native session inventory", () => {
  it("selects duplicates independently of their enumeration order", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "agents-inventory-test-",
    });
    try {
      await using inventory = await NativeInventory.open(directory);
      const add = (path: string, mtime: number, canonical = false) =>
        inventory.addFile(
          { id: "session", path, archived: false },
          mtime,
          canonical,
        );
      add("/z", 10);
      add("/old", 1);
      add("/a", 10);
      expect([...inventory.sessions()]).toEqual([{
        id: "session",
        path: "/a",
        archived: 0,
      }]);
      add("/current", 5, true);
      add("/newer-copy", 20);
      expect([...inventory.sessions()]).toEqual([{
        id: "session",
        path: "/current",
        archived: 0,
      }]);
      inventory.addRow("database-only", {
        database: "history",
        table: "thread_items",
        row: 42,
      });
      inventory.addRow("database-only", {
        database: "history",
        table: "thread_items",
        row: 42,
      });
      expect([...inventory.rows("database-only")]).toEqual([{
        database: "history",
        table: "thread_items",
        row: 42,
      }]);
      expect([...inventory.sessions()][0]).toEqual({
        id: "database-only",
        path: null,
        archived: null,
      });
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("locks active scans and removes scratch files from an interrupted scan", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "agents-inventory-test-",
    });
    try {
      const path = `${directory}/inventory.sqlite`;
      await Deno.writeTextFile(path, "abandoned private data", { mode: 0o600 });
      {
        await using inventory = await NativeInventory.open(directory);
        expect([...inventory.sessions()]).toEqual([]);
        await expect(NativeInventory.open(directory)).rejects.toThrow(
          "already open",
        );
        if (Deno.build.os !== "windows") {
          expect((await Deno.stat(path)).mode! & 0o777).toBe(0o600);
        }
      }
      await expect(Deno.stat(path)).rejects.toBeInstanceOf(
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("refuses a scratch database symlink without removing its target", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "agents-inventory-test-",
    });
    try {
      const target = `${directory}/keep`;
      await Deno.writeTextFile(target, "keep", { mode: 0o600 });
      await Deno.symlink(target, `${directory}/inventory.sqlite`);
      await expect(NativeInventory.open(directory)).rejects.toThrow(
        "plain files",
      );
      expect(await Deno.readTextFile(target)).toBe("keep");
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
});
