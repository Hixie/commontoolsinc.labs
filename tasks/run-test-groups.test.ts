import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  dropContainerCases,
  parseJUnit,
} from "@commonfabric/test-support/records";
import {
  collectTestFiles,
  mergeJUnitReports,
  runTestBatches,
  runTestGroups,
} from "./run-test-groups.ts";

/** A directory holding the files a case describes, by name and source. */
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "groups-fixture-" });
  for (const [name, source] of Object.entries(files)) {
    await Deno.writeTextFile(`${dir}/${name}`, source);
  }
  return dir;
}

/** The names and outcomes of the cases the report at `file` holds. */
async function outcomes(file: string): Promise<Map<string, string>> {
  return new Map(
    dropContainerCases(parseJUnit(await Deno.readTextFile(file)))
      .map((leaf) => [leaf.name, leaf.outcome]),
  );
}

describe("run-test-groups", () => {
  it("collects test modules recursively in stable order", async () => {
    const dir = await Deno.makeTempDir({ prefix: "groups-tests-" });
    try {
      await Deno.mkdir(`${dir}/nested`);
      await Deno.writeTextFile(`${dir}/z.test.ts`, "");
      await Deno.writeTextFile(`${dir}/nested/a_test.ts`, "");
      await Deno.writeTextFile(`${dir}/nested/helper.ts`, "");

      expect(await collectTestFiles(dir)).toEqual([
        "nested/a_test.ts",
        "z.test.ts",
      ]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("leaves out what the member excludes, as the topology does", async () => {
    // The runner and the topology have to list the same files. A file only the
    // runner lists runs in the full run but belongs to no unit, so no lane can
    // ask for it.
    const dir = await Deno.makeTempDir({ prefix: "groups-rule-" });
    try {
      await Deno.writeTextFile(
        `${dir}/deno.json`,
        JSON.stringify({ test: { exclude: ["fixtures/"] } }),
      );
      await Deno.mkdir(`${dir}/fixtures`);
      await Deno.mkdir(`${dir}/node_modules`);
      await Deno.writeTextFile(`${dir}/taken.test.ts`, "");
      await Deno.writeTextFile(`${dir}/fixtures/sample.test.ts`, "");
      await Deno.writeTextFile(`${dir}/passed-test.ts`, "");
      await Deno.writeTextFile(`${dir}/node_modules/vendored.test.ts`, "");

      expect(await collectTestFiles(dir)).toEqual(["taken.test.ts"]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("leaves out what the runner's `--ignore` names", async () => {
    const dir = await Deno.makeTempDir({ prefix: "groups-ignore-" });
    try {
      await Deno.mkdir(`${dir}/fixtures`);
      await Deno.writeTextFile(`${dir}/taken.test.ts`, "");
      await Deno.writeTextFile(`${dir}/fixtures/pattern.test.tsx`, "");
      await Deno.writeTextFile(`${dir}/left.test.ts`, "");

      expect(
        await collectTestFiles(dir, {
          paths: ["."],
          ignores: ["**/*.test.tsx", "left.test.ts"],
        }),
      ).toEqual(["taken.test.ts"]);
      expect(await collectTestFiles(dir)).toEqual([
        "fixtures/pattern.test.tsx",
        "left.test.ts",
        "taken.test.ts",
      ]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  describe("mergeJUnitReports()", () => {
    const report = (tests: number, failures: number, body: string) =>
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<testsuites name="deno test" tests="${tests}" failures="${failures}" ` +
      `errors="0" time="0.500">\n${body}</testsuites>\n`;

    it("holds every suite of each report, and sums the root's counts", () => {
      const merged = mergeJUnitReports([
        report(
          1,
          0,
          '<testsuite name="./a.test.ts"><testcase name="a"/></testsuite>\n',
        ),
        report(
          2,
          1,
          '<testsuite name="./b.test.ts"><testcase name="b"/><testcase name="c"><failure/></testcase></testsuite>\n',
        ),
      ]);
      expect(dropContainerCases(parseJUnit(merged)).map((leaf) => leaf.name))
        .toEqual(["a", "b", "c"]);
      expect(merged).toContain(
        '<testsuites name="deno test" tests="3" failures="1" errors="0" ' +
          'time="1.000">',
      );
    });

    it("throws on a report with no root element", () => {
      expect(() => mergeJUnitReports(["<testsuite/>"])).toThrow(
        "Not a JUnit report",
      );
    });
  });

  describe("runTestBatches()", () => {
    it("leaves one report holding every batch's tests", async () => {
      const dir = await fixture({
        "a.test.ts": 'Deno.test("rises", () => {});\n',
        "b.test.ts": 'Deno.test("sets", () => {});\n',
      });
      try {
        const junit = `--junit-path=${dir}/report.xml`;
        const code = await runTestBatches([
          {
            flags: ["--no-config", "--no-check", junit],
            files: [`${dir}/a.test.ts`],
          },
          {
            flags: ["--no-config", "--no-check", junit],
            files: [`${dir}/b.test.ts`],
          },
        ]);
        expect(code).toBe(0);
        expect(await outcomes(`${dir}/report.xml`)).toEqual(
          new Map([["rises", "pass"], ["sets", "pass"]]),
        );
        expect(
          (await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name).sort(),
        ).toEqual(["a.test.ts", "b.test.ts", "report.xml"]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("runs every batch past a failing one, and returns its code", async () => {
      const dir = await fixture({
        "a.test.ts": 'Deno.test("fails on purpose", () => {\n' +
          '  throw new Error("a fixture of runTestBatches() failing");\n' +
          "});\n",
        "b.test.ts": 'Deno.test("sets", () => {});\n',
      });
      try {
        const junit = `--junit-path=${dir}/report.xml`;
        const code = await runTestBatches([
          {
            flags: ["--no-config", "--no-check", junit],
            files: [`${dir}/a.test.ts`],
          },
          {
            flags: ["--no-config", "--no-check", junit],
            files: [`${dir}/b.test.ts`],
          },
        ]);
        expect(code).not.toBe(0);
        expect(await outcomes(`${dir}/report.xml`)).toEqual(
          new Map([["fails on purpose", "fail"], ["sets", "pass"]]),
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("merges the reports where the path is written as two words", async () => {
      const dir = await fixture({
        "a.test.ts": 'Deno.test("rises", () => {});\n',
        "b.test.ts": 'Deno.test("sets", () => {});\n',
      });
      try {
        const junit = ["--junit-path", `${dir}/report.xml`];
        const code = await runTestBatches([
          { flags: ["--no-config", ...junit], files: [`${dir}/a.test.ts`] },
          { flags: ["--no-config", ...junit], files: [`${dir}/b.test.ts`] },
        ]);
        expect(code).toBe(0);
        expect(await outcomes(`${dir}/report.xml`)).toEqual(
          new Map([["rises", "pass"], ["sets", "pass"]]),
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("hands a lone batch the report path as it stands", async () => {
      const dir = await fixture({
        "a.test.ts": 'Deno.test("rises", () => {});\n',
      });
      try {
        const code = await runTestBatches([{
          flags: [
            "--no-config",
            "--no-check",
            `--junit-path=${dir}/report.xml`,
          ],
          files: [`${dir}/a.test.ts`],
        }]);
        expect(code).toBe(0);
        expect(await outcomes(`${dir}/report.xml`)).toEqual(
          new Map([["rises", "pass"]]),
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });

  describe("runTestGroups()", () => {
    const FILES = {
      "rise.test.ts": 'Deno.test("rises", () => {});\n',
      "proof.serial.test.ts": 'Deno.test("proofs", () => {});\n',
    };

    it("runs every file in its group, and leaves one report", async () => {
      const dir = await fixture(FILES);
      const report = await Deno.makeTempFile({ suffix: ".xml" });
      try {
        const code = await runTestGroups(
          [
            ".",
            "--serial=**/*.serial.test.ts",
            "--",
            "--no-config",
            "--parallel",
            `--junit-path=${report}`,
          ],
          dir,
        );
        expect(code).toBe(0);
        expect(await outcomes(report)).toEqual(
          new Map([["rises", "pass"], ["proofs", "pass"]]),
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
        await Deno.remove(report);
      }
    });

    it("throws naming a glob that matches no test file", async () => {
      const dir = await fixture(FILES);
      try {
        await expect(
          runTestGroups(
            [".", "--all-access=oven.test.ts", "--", "--no-config"],
            dir,
          ),
        ).rejects.toThrow("No test file matches `oven.test.ts`.");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("throws when the member holds no test file to run", async () => {
      const dir = await fixture({ "helper.ts": "export {};\n" });
      try {
        await expect(
          runTestGroups([".", "--"], dir),
        ).rejects.toThrow("No test files found.");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("throws the usage for arguments with no separator", async () => {
      await expect(runTestGroups(["."], ".")).rejects.toThrow(
        "Usage: run-test-groups.ts",
      );
    });
  });
});
