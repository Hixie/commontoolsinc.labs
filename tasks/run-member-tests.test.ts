import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import {
  DENO_TEST_TASK,
  memberTasks,
  plan,
  readInvocation,
} from "./run-member-tests.ts";

/** Every directory a case made, removed when the case is done. */
const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

/** A member directory holding the manifest a case describes. */
async function member(tasks: Record<string, unknown>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "member-tests-" });
  made.push(dir);
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({ tasks }, null, 2),
  );
  return dir;
}

describe("run-member-tests", () => {
  describe("readInvocation()", () => {
    it("returns the names before the first flag as the tasks to run", () => {
      expect(readInvocation(["check", DENO_TEST_TASK])).toEqual({
        tasks: ["check", DENO_TEST_TASK],
        forwarded: [],
      });
    });

    it("returns the flags a caller appended as the ones to forward", () => {
      // A caller appends to the task line, so its flags arrive after
      // whatever names that line already carried.
      expect(
        readInvocation([DENO_TEST_TASK, "--junit-path=/x.xml", "--preload=/p"]),
      ).toEqual({
        tasks: [DENO_TEST_TASK],
        forwarded: ["--junit-path=/x.xml", "--preload=/p"],
      });
    });

    it("returns no tasks for a line that names none", () => {
      expect(readInvocation([])).toEqual({ tasks: [], forwarded: [] });
      expect(readInvocation(["--junit-path=/x.xml"])).toEqual({
        tasks: [],
        forwarded: ["--junit-path=/x.xml"],
      });
    });

    it("forwards the value a flag takes as its next argument", () => {
      // `deno task test --filter "a name"` is how one test is run, and
      // reading the name as a task would refuse it.
      expect(readInvocation([DENO_TEST_TASK, "--filter", "a name"])).toEqual({
        tasks: [DENO_TEST_TASK],
        forwarded: ["--filter", "a name"],
      });
    });
  });

  describe("plan()", () => {
    const defined = new Set([DENO_TEST_TASK, "browser-test", "check"]);

    it("returns the tasks in the order the line names them", () => {
      // The line says the whole of what runs, so a member keeps whatever
      // order it had rather than taking one this imposes.
      expect(
        plan({ tasks: ["check", DENO_TEST_TASK], forwarded: [] }, defined),
      ).toEqual(["check", DENO_TEST_TASK]);
      expect(
        plan(
          { tasks: [DENO_TEST_TASK, "browser-test"], forwarded: [] },
          defined,
        ),
      ).toEqual([DENO_TEST_TASK, "browser-test"]);
    });

    it("refuses a line naming no Deno half", () => {
      // There would be nothing for an appended report path to reach, so
      // the member would run and report a pass with no record of it.
      expect(() => plan({ tasks: ["browser-test"], forwarded: [] }, defined))
        .toThrow(`no \`${DENO_TEST_TASK}\``);
    });

    it("refuses a name the member defines no task for", () => {
      expect(() =>
        plan({ tasks: [DENO_TEST_TASK, "typo-test"], forwarded: [] }, defined)
      ).toThrow("typo-test");
    });

    it("names the missing task before complaining about the Deno half", () => {
      // A misspelled `deno-test` is one mistake, and reporting it as two
      // sends the reader looking for a second one.
      expect(() => plan({ tasks: ["dneo-test"], forwarded: [] }, defined))
        .toThrow("dneo-test");
    });
  });

  describe("memberTasks()", () => {
    it("returns the task names the member's manifest defines", async () => {
      const dir = await member({
        [DENO_TEST_TASK]: "deno test",
        check: "deno check",
      });
      expect([...await memberTasks(dir)].toSorted())
        .toEqual([DENO_TEST_TASK, "check"].toSorted());
    });

    it("returns nothing for a directory holding no manifest", async () => {
      const dir = await Deno.makeTempDir({ prefix: "member-tests-none-" });
      made.push(dir);
      expect([...await memberTasks(dir)]).toEqual([]);
    });
  });
});
