/**
 * The page behind the ci tile: what each of its states renders, the order it
 * puts jobs in, and what it says about a job it has no verdict or no reading
 * for. The page is a pure function of one collection, so every test here hands
 * it one and reads back the HTML of the live page that frames it.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  type CiJobs,
  CI_JOBS_PATH,
  ciJobsPage,
  type Job,
  sortTable,
  type SortOrder,
} from "./ci-jobs-page.ts";
import { livePage, livePageResponse } from "./live-page.ts";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 22, 14, 30);

function job(over: Partial<Job> = {}): Job {
  return {
    repo: "labs",
    workflow: "CI",
    pinned: false,
    status: "good",
    failing: false,
    result: "success",
    event: "push",
    startedAt: NOW - HOUR,
    ranMs: 17 * MINUTE + 3_000,
    href: "https://github.com/commonfabric/labs/actions/runs/1",
    ...over,
  };
}

function collection(over: Partial<CiJobs> = {}): CiJobs {
  return {
    jobs: [job()],
    repoCount: 1,
    unreadableRepos: [],
    collectedAt: NOW - 2 * MINUTE,
      ...over,
  };
}

// The page as the ci tile's route serves it.
function pageHtml(collected: CiJobs | undefined, now: number): string {
  return livePage(ciJobsPage(collected, now));
}

// The repository cell of each row, in the order the page put them in.
function rowRepos(html: string): string[] {
  return [...html.matchAll(/<td class="repo"[^>]*>.*?<\/span>([^<]*)</g)]
    .map((match) => match[1]);
}

Deno.test("ci jobs page: a job carries its result, duration, and when it ran", () => {
  const html = pageHtml(collection(), NOW);

  assertStringIncludes(html, "<title>CI jobs</title>");
  assertStringIncludes(html, `href="/"`);
  assertStringIncludes(html, "collected 2026-09-22 14:28 UTC · 2m ago");
  assertStringIncludes(html, ">labs<");
  assertStringIncludes(html, ">CI</a>");
  assertStringIncludes(html, ">success<");
  assertStringIncludes(html, ">push<");
  assertStringIncludes(html, ">17m 03s<");
  assertStringIncludes(html, ">2026-09-22 13:30 UTC<");
  assertStringIncludes(html, ">1h ago<");
  assertStringIncludes(
    html,
    `href="https://github.com/commonfabric/labs/actions/runs/1"`,
  );
});

Deno.test("ci jobs page: the summary counts each state of a job", () => {
  const html = pageHtml(
    collection({
      jobs: [
        job(),
        job({ repo: "loom", status: "bad", failing: true, result: "failure" }),
        // A failure old enough to have gone orange is still a failure.
        job({ repo: "amp", status: "warn", failing: true, result: "failure" }),
        job({ repo: "raia", status: "warn", result: "rate limit hit" }),
        job({ repo: "pond", status: "unknown", result: "no completed run" }),
      ],
      repoCount: 5,
      unreadableRepos: ["commonfabric/gvisor"],
    }),
    NOW,
  );

  for (const [term, value] of [
    // The job with no verdict is not one the counts speak for.
    ["jobs", "4"],
    ["repositories", "5"],
    ["passing", "1"],
    ["failing", "2"],
    // The unreadable repository counts beside the job that could not be read,
    // and the orange failure counts with the failures rather than here.
    ["unreadable", "2"],
    ["no verdict", "1"],
  ]) {
    assertStringIncludes(html, `<dt>${term}</dt><dd>${value}</dd>`);
  }
});

Deno.test("ci jobs page: jobs are ordered worst first, then by name", () => {
  const html = pageHtml(
    collection({
      jobs: [
        job({ repo: "zed" }),
        job({ repo: "pond", status: "unknown", result: "no completed run" }),
        job({ repo: "loom", status: "bad", failing: true, result: "failure" }),
        job({ repo: "arc" }),
        job({ repo: "bay", status: "warn", result: "auth failed" }),
        job({ repo: "amp", status: "bad", result: "timed_out" }),
      ],
      repoCount: 6,
    }),
    NOW,
  );

  // The job with no verdict is listed under the table, not through it.
  assertEquals(rowRepos(html), ["amp", "loom", "bay", "arc", "zed", "pond"]);
  assertStringIncludes(html, "Workflows with no verdict · 1");
});

Deno.test("ci jobs page: two jobs in one repository sort by workflow", () => {
  const html = pageHtml(
    collection({
      jobs: [
        job({ workflow: "Nightly" }),
        job({ workflow: "Audit" }),
      ],
    }),
    NOW,
  );

  const workflows = [...html.matchAll(/>([^<]*)<\/a>/g)].map((m) => m[1]);
  assertEquals(workflows.filter((name) => name === "Audit").length, 1);
  assert(
    html.indexOf(">Audit</a>") < html.indexOf(">Nightly</a>"),
    "the earlier name comes first",
  );
});

Deno.test("ci jobs page: a job with no run is listed apart, linked at its workflow", () => {
  const html = pageHtml(
    collection({
      jobs: [
        job(),
        job({
          repo: "pond",
          workflow: "Preview",
          status: "unknown",
          result: "no completed run",
          startedAt: undefined,
          ranMs: undefined,
          href: "https://github.com/commonfabric/labs/actions/workflows/x.yml",
        }),
      ],
    }),
    NOW,
  );

  assertStringIncludes(html, "Workflows with no verdict · 1");
  assertStringIncludes(html, "/actions/workflows/x.yml");
  assertStringIncludes(html, `<dt>no verdict</dt><dd>1</dd>`);
  // It says why it has no verdict, and carries none of the table's measures.
  assertStringIncludes(html, `<td class="measure">no completed run</td></tr>`);
  assertEquals([...html.matchAll(/data-sort="-1"/g)].length, 0);
});

Deno.test("ci jobs page: a job whose workflow changed since it failed says so", () => {
  const html = pageHtml(
    collection({
      jobs: [
        job(),
        job({
          repo: "crm",
          workflow: "Nightly export",
          status: "unknown",
          result: "changed since it failed",
          href: "https://github.com/commonfabric/crm/actions/runs/9",
        }),
      ],
    }),
    NOW,
  );

  // It leaves the table for the section below it, linked at the failure it
  // no longer counts, with the reason beside it.
  assertStringIncludes(html, "Workflows with no verdict · 1");
  assertStringIncludes(
    html,
    `href="https://github.com/commonfabric/crm/actions/runs/9"`,
  );
  assertStringIncludes(
    html,
    `<td class="measure">changed since it failed</td></tr>`,
  );
  assertStringIncludes(html, `<dt>failing</dt><dd>0</dd>`);
});

Deno.test("ci jobs page: a job whose run left no timing shows dashes, not a made-up time", () => {
  const html = pageHtml(
    collection({
      jobs: [job({ startedAt: undefined, ranMs: undefined })],
    }),
    NOW,
  );

  assertEquals([...html.matchAll(/<td class="measure[^>]*>—<\/td>/g)].length, 3);
});

Deno.test("ci jobs page: unreadable repositories get their own section", () => {
  const html = pageHtml(
    collection({ unreadableRepos: ["commonfabric/pond"] }),
    NOW,
  );

  assertStringIncludes(html, "Repositories that could not be read · 1");
  assertStringIncludes(html, `https://github.com/commonfabric/pond/actions`);

  const none = pageHtml(collection(), NOW);
  assert(!none.includes("Repositories that could not be read"));
});

Deno.test("ci jobs page: a repository or workflow name carrying markup is escaped", () => {
  const html = pageHtml(
    collection({
      jobs: [job({ workflow: `<img src=x onerror="alert(1)">` })],
      unreadableRepos: [`commonfabric/<script>`],
    }),
    NOW,
  );

  // The page carries a theme script of its own, so the check is that neither
  // name reached the markup unescaped, not that no script tag is present.
  assert(!html.includes("<img"));
  assert(!html.includes("commonfabric/<script>"));
  assertStringIncludes(html, "&lt;img src=x onerror=&quot;");
  assertStringIncludes(html, "commonfabric/&lt;script&gt;");
});

Deno.test("ci jobs page: a job's status is a shape as well as a color", () => {
  const html = pageHtml(
    collection({
      jobs: [
        job(),
        job({ repo: "loom", status: "bad", failing: true, result: "failure" }),
        job({ repo: "bay", status: "warn", failing: true, result: "failure" }),
      ],
    }),
    NOW,
  );

  // The dashboard's own shapes: a circle passing, a diamond failing, a
  // triangle warning, so the three read apart without their colors.
  assertStringIncludes(html, ".dot.green::before{border-radius:50%");
  assertStringIncludes(html, ".dot.red::before{inset:-1px;clip-path:polygon(");
  assertStringIncludes(html, ".dot.amber::before{clip-path:polygon(");
  for (const shade of ["green", "red", "amber"]) {
    assertStringIncludes(html, `<span class="dot ${shade}"></span>`);
  }
});

Deno.test("ci jobs page: every column carries the value it sorts on", () => {
  const html = pageHtml(
    collection({
      jobs: [job({ event: "schedule", ranMs: 92_000 })],
    }),
    NOW,
  );

  // What the cells show is written to be read, so each carries its own key.
  assertStringIncludes(html, `data-sort="labs"`);
  assertStringIncludes(html, `data-sort="CI"`);
  assertStringIncludes(html, `data-sort="schedule"`);
  // Worst first: the result sorts on how bad it is before what it says.
  assertStringIncludes(html, `data-sort="3 success"`);
  assertStringIncludes(html, `data-sort="92000"`);
  assertStringIncludes(html, `data-sort="${NOW - HOUR}"`);
  assertStringIncludes(html, "<table data-sortable>");
  for (const column of ["repository", "workflow", "trigger", "result", "ran for", "started", "age"]) {
    assertStringIncludes(html, `>${column}</button>`);
  }
  assertEquals(
    [...html.matchAll(/aria-sort="none"/g)].length,
    7,
    "a served page is sorted by nothing in particular",
  );
});

Deno.test("ci jobs page: a job with nothing to measure sorts apart from the measured", () => {
  const html = pageHtml(
    collection({
      jobs: [job({ status: "warn", result: "auth failed", startedAt: undefined, ranMs: undefined, event: undefined })],
    }),
    NOW,
  );

  assertEquals([...html.matchAll(/data-sort="-1"/g)].length, 3);
  assertStringIncludes(html, `data-sort=""`);
});

Deno.test("ci jobs page: every row links to what GitHub has on its job", () => {
  const html = pageHtml(
    collection({
      jobs: [
        job({ href: "https://github.com/commonfabric/labs/actions/runs/1" }),
        job({
          repo: "gvisor",
          workflow: "CodeQL",
          status: "bad",
          failing: true,
          result: "failure",
          href: "https://github.com/commonfabric/gvisor/actions/runs/2",
        }),
        job({
          repo: "pond",
          workflow: "Preview",
          status: "unknown",
          result: "no completed run",
          startedAt: undefined,
          ranMs: undefined,
          href: "https://github.com/commonfabric/pond/actions/workflows/p.yml",
        }),
      ],
      unreadableRepos: ["commonfabric/crm"],
    }),
    NOW,
  );

  // One link per row, whichever table the row is in, and none missing.
  const rows = [
    ...html.matchAll(/<tr(?: data-served="[^"]*")?><td class="repo"[\s\S]*?<\/tr>/g),
  ]
    .map((match) => match[0]);
  assertEquals(rows.length, 4);
  for (const row of rows) {
    assertEquals([...row.matchAll(/<a href="/g)].length, 1, row);
  }
  for (
    const href of [
      "https://github.com/commonfabric/labs/actions/runs/1",
      "https://github.com/commonfabric/gvisor/actions/runs/2",
      "https://github.com/commonfabric/pond/actions/workflows/p.yml",
      "https://github.com/commonfabric/crm/actions",
    ]
  ) {
    assertStringIncludes(html, `href="${href}" target="_blank"`);
  }
  // Drawn as a link, not as the text around it.
  assertStringIncludes(html, "td a{color:var(--accent)");
});

Deno.test("ci jobs page: nothing collected yet says so rather than showing an empty table", () => {
  const html = pageHtml(undefined, NOW);

  assertStringIncludes(html, "has not finished a collection yet");
  assert(!html.includes("<table>"));
});

Deno.test("ci jobs page: the response is the page as HTML", async () => {
  const response = livePageResponse(ciJobsPage(collection(), NOW));

  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("content-type"),
    "text/html; charset=utf-8",
  );
  assertStringIncludes(await response.text(), "<title>CI jobs</title>");
  assertEquals(CI_JOBS_PATH, "/ci");
});

Deno.test("ci jobs page: the page is live, with everything it renders inside main", () => {
  const html = pageHtml(collection(), NOW);
  const main = html.slice(html.indexOf("<main>"), html.indexOf("</main>"));

  assertStringIncludes(html, `id="live-badge"`);
  assertStringIncludes(html, "/events?page=");
  assertStringIncludes(main, "collected 2026-09-22 14:28 UTC · 2m ago");
  assertStringIncludes(main, "<table data-sortable>");
  assertStringIncludes(main, `<tr data-served="3 labs CI">`);
  // The page's own script comes first, so it is listening for updates before
  // the page opens its stream.
  assert(html.indexOf("const sortTable") < html.indexOf("new EventSource"));
});

Deno.test("ci jobs page: each row carries the key it was served in order of", () => {
  // A job's key is its own, whatever the jobs around it are.
  const html = pageHtml(
    collection({
      jobs: [
        job({ repo: "b" }),
        job({ repo: "a" }),
        job({ repo: "c", status: "bad", failing: true, result: "failure" }),
      ],
    }),
    NOW,
  );

  assertEquals(
    [...html.matchAll(/<tr data-served="([^"]*)">/g)].map((match) => match[1]),
    ["0 c CI", "3 a CI", "3 b CI"],
  );
});

// The parts of a table `sortTable()` uses, over plain objects.
// `ci-jobs-page.browser.test.ts` runs the same function against the page's own
// markup in a browser.
class FakeCell {
  constructor(
    readonly textContent: string,
    readonly sortKey?: string,
  ) {}

  getAttribute(name: string): string | null {
    return name === "data-sort" ? this.sortKey ?? null : null;
  }
}

class FakeRow {
  constructor(
    readonly name: string,
    readonly served: string,
    readonly cells: FakeCell[],
  ) {}

  getAttribute(name: string): string | null {
    return name === "data-served" ? this.served : null;
  }
}

class FakeBody {
  rows: FakeRow[] = [];

  appendChild(row: FakeRow): FakeRow {
    this.rows = [...this.rows.filter((other) => other !== row), row];
    return row;
  }
}

class FakeHeading {
  sort = "none";
  readonly parentElement = {
    setAttribute: (name: string, value: string) => {
      if (name === "aria-sort") this.sort = value;
    },
  };

  constructor(readonly column: number) {}

  getAttribute(name: string): string | null {
    return name === "data-column" ? String(this.column) : null;
  }
}

// A table of jobs with a name column that sorts on its text and a duration
// column that sorts on its key, in the order the page served them.
function fakeTable(rows: [string, string][]) {
  const body = new FakeBody();
  body.rows = rows.map(([name, ms], served) =>
    new FakeRow(name, `${served} ${name}`, [
      new FakeCell(` ${name} `),
      new FakeCell("", ms),
    ])
  );
  const headings = [new FakeHeading(0), new FakeHeading(1)];
  const table = {
    tBodies: [body],
    querySelectorAll: (selectors: string) =>
      selectors === "th button[data-column]" ? headings : [],
  };
  return {
    sort: (order: SortOrder) => sortTable(table, order),
    order: () => body.rows.map((row) => row.name),
    marks: () => headings.map((heading) => heading.sort),
  };
}

Deno.test("ci jobs sorting: a column of numbers sorts as numbers, up then down", () => {
  const table = fakeTable([["b", "200"], ["a", "9"], ["c", "40"]]);

  table.sort({ column: 1, descending: false });
  // As text, "200" would come before "40" and "9".
  assertEquals(table.order(), ["a", "c", "b"]);
  assertEquals(table.marks(), ["none", "ascending"]);

  table.sort({ column: 1, descending: true });
  assertEquals(table.order(), ["b", "c", "a"]);
  assertEquals(table.marks(), ["none", "descending"]);
});

Deno.test("ci jobs sorting: a cell with no key sorts on its text", () => {
  const table = fakeTable([["zed", "1"], ["amp", "2"], ["loom", "3"]]);
  table.sort({ column: 0, descending: false });
  assertEquals(table.order(), ["amp", "loom", "zed"]);
});

Deno.test("ci jobs sorting: a new column is marked and clears the last", () => {
  const table = fakeTable([["b", "2"], ["a", "1"]]);

  table.sort({ column: 0, descending: true });
  assertEquals(table.marks(), ["descending", "none"]);
  table.sort({ column: 1, descending: false });
  assertEquals(table.marks(), ["none", "ascending"]);
  assertEquals(table.order(), ["a", "b"]);
});

Deno.test("ci jobs sorting: equal values keep the order the rows were served in", () => {
  const table = fakeTable([["worst", "5"], ["middle", "5"], ["best", "1"]]);

  table.sort({ column: 1, descending: false });
  assertEquals(table.order(), ["best", "worst", "middle"]);
  table.sort({ column: 1, descending: true });
  assertEquals(table.order(), ["worst", "middle", "best"]);
  // Not the order the last sort left them in.
  table.sort({ column: 0, descending: true });
  table.sort({ column: 1, descending: false });
  assertEquals(table.order(), ["best", "worst", "middle"]);
});

Deno.test("ci jobs sorting: a table without a body is refused", () => {
  assertThrows(
    () =>
      sortTable<FakeRow>({
        tBodies: [],
        querySelectorAll: () => [],
      }, { column: 0, descending: false }),
    Error,
    "a sortable table has a body",
  );
});
