/**
 * These pin what the gate calls a test runner and what it calls a
 * command carrying a seed, in both directions: a false positive blocks a
 * pull request over a command that runs no tests, and a false negative
 * lets a runner reach the tree in declaration order, which is the one
 * thing the gate exists to stop.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assert } from "@std/assert";
import { join } from "@std/path";
import {
  commandsOf,
  problemWith,
  scan,
  staleRecords,
} from "./check-test-shuffle.ts";

const SHUFFLE = "--shuffle=$(deno task -q test-seed)";

/** Makes a git repository holding one workspace member's manifest. */
async function fixtureRepo(
  memberTask: unknown,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "check-test-shuffle-" });
  const run = async (...args: string[]) => {
    const { success, stderr } = await new Deno.Command("git", {
      args,
      cwd: root,
      stdout: "null",
      stderr: "piped",
    }).output();
    assert(
      success,
      `git ${args.join(" ")}: ${new TextDecoder().decode(stderr)}`,
    );
  };
  await run("init", "-q");
  await Deno.writeTextFile(
    join(root, "deno.jsonc"),
    JSON.stringify({ workspace: ["./member"], tasks: {} }, null, 2),
  );
  await Deno.mkdir(join(root, "member"));
  await Deno.writeTextFile(
    join(root, "member", "deno.jsonc"),
    JSON.stringify({ tasks: { test: memberTask } }, null, 2),
  );
  await run("add", "deno.jsonc", "member/deno.jsonc");
  return root;
}

describe("check-test-shuffle", () => {
  describe("commandsOf()", () => {
    it("separates the commands a task line joins", () => {
      expect(commandsOf("deno test -A && deno check .")).toEqual([
        "deno test -A",
        "deno check .",
      ]);
    });

    it("keeps a command substitution out of the command list", () => {
      // The `deno eval` below is an argument to the permission flag, not
      // a command of its own, and reading it as one would have the gate
      // judging a command nobody runs.
      expect(
        commandsOf(
          'deno test --allow-run=$(deno eval "console.log(Deno.execPath())")',
        ),
      ).toEqual(["deno test --allow-run="]);
    });
  });

  describe("problemWith()", () => {
    it("accepts a `deno test` carrying a seed", () => {
      expect(problemWith(`deno test ${SHUFFLE} -A`)).toBeUndefined();
      expect(problemWith("ENV=test deno test --shuffle=20260922 -A"))
        .toBeUndefined();
    });

    it("refuses a `deno test` carrying none", () => {
      expect(problemWith("deno test -A")).toContain("--shuffle=");
      expect(problemWith("ENV=test deno test --no-check test/"))
        .toContain("--shuffle=");
    });

    it("refuses a runner that forwards its flags and is given none", () => {
      expect(
        problemWith(
          "deno run -A ../../tasks/run-sharded-test-files.ts X piece . -- -A",
        ),
      ).toContain("run-sharded-test-files.ts");
    });

    it("accepts that same runner once it is given one", () => {
      expect(
        problemWith(
          `deno run -A ../../tasks/run-sharded-test-files.ts X piece . -- ${SHUFFLE}`,
        ),
      ).toBeUndefined();
    });

    it("accepts a runner that shuffles in its own code", () => {
      expect(problemWith("deno run -A ../deno-web-test/cli.ts **/*.test.ts"))
        .toBeUndefined();
      expect(problemWith("deno run -A test/runner.ts")).toBeUndefined();
    });

    it("accepts a shell harness whose order is recorded as the test", () => {
      expect(problemWith("./integration/integration.sh")).toBeUndefined();
      expect(problemWith("timeout 600 ./integration/fuse-exec.sh"))
        .toBeUndefined();
    });

    it("refuses a shell harness nobody has decided about", () => {
      expect(problemWith("./integration/brand-new-drill.sh"))
        .toContain("EXEMPTIONS");
    });

    it("leaves a command that starts no test runner alone", () => {
      expect(problemWith("deno check .")).toBeUndefined();
      expect(problemWith("deno run -A perf/run-tsc.ts")).toBeUndefined();
      expect(problemWith("echo 'No tests defined.'")).toBeUndefined();
      // The word appears, but not as the command.
      expect(problemWith("deno run -A ./tasks/latest-deno-test-report.ts"))
        .toBeUndefined();
    });
  });

  describe("staleRecords()", () => {
    // What the real tree holds, so a case can take one thing away from
    // it and see only that thing reported.
    const TRACKED = [
      "tasks/run-sharded-test-files.ts",
      "packages/cli/test/run-tests.ts",
      "packages/dashboard/test/runner.ts",
      "packages/deno-web-test/runner.ts",
      "packages/cli/lib/test-runner.ts",
      "packages/cli/integration/integration.sh",
      "packages/cli/integration/acl.sh",
      "packages/cli/integration/fuse-exec.sh",
    ];
    const WRITTEN = [
      "run-sharded-test-files.ts test/run-tests.ts test/runner.ts " +
      "deno-web-test/cli.ts cf test",
    ];

    it("says nothing while every record still describes the tree", () => {
      expect(staleRecords(TRACKED, WRITTEN)).toEqual([]);
    });

    it("names a runner no command starts any more", () => {
      const stale = staleRecords(
        TRACKED,
        ["test/run-tests.ts test/runner.ts deno-web-test/cli.ts cf test"],
      );
      expect(stale).toHaveLength(1);
      expect(stale[0]!.command).toBe("run-sharded-test-files.ts");
    });

    it("names a runner whose implementation has moved", () => {
      const stale = staleRecords(
        TRACKED.filter((file) => file !== "packages/deno-web-test/runner.ts"),
        WRITTEN,
      );
      expect(stale).toHaveLength(1);
      expect(stale[0]!.command).toBe("packages/deno-web-test/runner.ts");
    });

    it("names an exemption for a harness the tree no longer holds", () => {
      const stale = staleRecords(
        TRACKED.filter((file) => file !== "packages/cli/integration/acl.sh"),
        WRITTEN,
      );
      expect(stale).toHaveLength(1);
      expect(stale[0]!.command).toBe("packages/cli/integration/acl.sh");
    });

    it("names an exemption a second harness of the same name would take", () => {
      const stale = staleRecords(
        [...TRACKED, "packages/oven/integration/acl.sh"],
        WRITTEN,
      );
      expect(stale).toHaveLength(1);
      expect(stale[0]!.problem).toContain("packages/oven/integration/acl.sh");
    });
  });

  describe("scan()", () => {
    it("passes a member whose test task carries a seed", async () => {
      const root = await fixtureRepo(`deno test ${SHUFFLE} -A`);
      expect(await scan(root)).toEqual([]);
    });

    it("fails a member whose test task carries none", async () => {
      const root = await fixtureRepo("deno test -A");
      const violations = await scan(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.where).toContain("member/deno.jsonc");
    });

    it("passes a member that says it has no tests", async () => {
      const root = await fixtureRepo("echo 'No tests defined.'");
      expect(await scan(root)).toEqual([]);
    });

    it("fails a member whose test task reaches no runner it knows", async () => {
      const root = await fixtureRepo("node ./run-my-tests.js");
      const violations = await scan(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.problem).toContain("RUNNERS");
    });

    it("follows a test task built out of the member's other tasks", async () => {
      const root = await Deno.makeTempDir({ prefix: "check-test-shuffle-" });
      const run = async (...args: string[]) => {
        const { success } = await new Deno.Command("git", {
          args,
          cwd: root,
          stdout: "null",
          stderr: "null",
        }).output();
        assert(success, `git ${args.join(" ")}`);
      };
      await run("init", "-q");
      await Deno.writeTextFile(
        join(root, "deno.jsonc"),
        JSON.stringify({ workspace: ["./member"], tasks: {} }, null, 2),
      );
      await Deno.mkdir(join(root, "member"));
      await Deno.writeTextFile(
        join(root, "member", "deno.jsonc"),
        JSON.stringify(
          {
            tasks: {
              test: { dependencies: ["deno-test"] },
              "deno-test": `deno test ${SHUFFLE} -A`,
            },
          },
          null,
          2,
        ),
      );
      await run("add", "deno.jsonc", "member/deno.jsonc");
      expect(await scan(root)).toEqual([]);
    });
  });
});
