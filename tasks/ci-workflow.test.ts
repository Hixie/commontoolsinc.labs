import { assert, assertEquals, assertStringIncludes } from "@std/assert";

function jobBlock(workflow: string, jobId: string): string {
  const jobsStart = workflow.indexOf("jobs:\n");
  assert(jobsStart >= 0, "workflow jobs section not found");

  const header = `  ${jobId}:\n`;
  const start = workflow.indexOf(header, jobsStart);
  assert(start >= 0, `${jobId} job not found`);

  const bodyStart = start + header.length;
  const nextJobOffset = workflow.slice(bodyStart).search(
    /^ {2}[A-Za-z_][A-Za-z0-9_-]*:\n/m,
  );
  const end = nextJobOffset < 0 ? workflow.length : bodyStart + nextJobOffset;
  return workflow.slice(start, end);
}

function jobIds(workflow: string): string[] {
  const jobsStart = workflow.indexOf("jobs:\n");
  assert(jobsStart >= 0, "workflow jobs section not found");
  return [
    ...workflow.slice(jobsStart).matchAll(
      /^ {2}([A-Za-z_][A-Za-z0-9_-]*):\n/gm,
    ),
  ].map((match) => match[1]);
}

function stepBlock(job: string, stepName: string): string {
  const header = `      - name: ${stepName}\n`;
  const start = job.indexOf(header);
  assert(start >= 0, `${stepName} step not found`);

  const bodyStart = start + header.length;
  const nextStepOffset = job.slice(bodyStart).search(/^ {6}- name: /m);
  const end = nextStepOffset < 0 ? job.length : bodyStart + nextStepOffset;
  return job.slice(start, end);
}

function neededJobIds(job: string): string[] {
  const marker = "\n    needs:\n";
  const needsStart = job.indexOf(marker);
  assert(needsStart >= 0, "job needs list not found");

  const needsBody = job.slice(needsStart + marker.length);
  const nextProperty = needsBody.search(/^ {4}[A-Za-z_][A-Za-z0-9_-]*:/m);
  const needs = nextProperty < 0 ? needsBody : needsBody.slice(0, nextProperty);
  return [...needs.matchAll(/^ {6}- ([A-Za-z_][A-Za-z0-9_-]*)$/gm)].map(
    (match) => match[1],
  );
}

async function workflow(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`../.github/workflows/${name}`, import.meta.url),
  );
}

function workflowTriggers(contents: string): string {
  const triggerEnd = contents.indexOf("\npermissions:");
  if (triggerEnd >= 0) return contents.slice(0, triggerEnd);

  const concurrencyStart = contents.indexOf("\nconcurrency:");
  assert(concurrencyStart >= 0, "workflow trigger section not found");
  return contents.slice(0, concurrencyStart);
}

Deno.test("Status waits for every pull request validation job", async () => {
  const contents = await workflow("deno.yml");
  const gate = jobBlock(contents, "status");
  const pushOnlyJobs = new Set([
    "attest-binaries",
    "deploy-toolshed",
    "deploy-rapids",
    "deploy-shell-staging",
  ]);
  const expected = jobIds(contents).filter((jobId) =>
    jobId !== "status" && !pushOnlyJobs.has(jobId)
  ).sort();

  assertEquals(neededJobIds(gate).sort(), expected);
  assertStringIncludes(contents, "name: CI\n");
  assertStringIncludes(gate, 'name: "Status"');
  assertStringIncludes(
    gate,
    "if: ${{ always() && github.event_name == 'pull_request' }}",
  );
  assertStringIncludes(gate, "JOB_RESULTS: ${{ toJSON(needs) }}");
  assertStringIncludes(gate, 'select(.value.result != "success")');
  assertStringIncludes(gate, "permissions: {}");

  // A path filter would leave the required check pending on a pull request
  // that touches none of the listed paths.
  const triggers = workflowTriggers(contents);
  assertStringIncludes(triggers, "  pull_request:\n");
  assertEquals(triggers.includes("\n    paths:"), false);
});

Deno.test("Coverage Comment follows the CI workflow by name", async () => {
  const deno = await workflow("deno.yml");
  const comment = await workflow("coverage-comment.yml");
  const name = deno.match(/^name: (.+)$/m);
  assert(name, "workflow name not found");

  assertStringIncludes(comment, `    workflows: ["${name[1]}"]\n`);
});

Deno.test("Dashboard publishes only from main, never from a pull request", async () => {
  const deno = await workflow("deno.yml");
  const dashboard = await workflow("dashboard-image.yml");

  assertEquals(deno.includes("dashboard-image.yml"), false);
  assertEquals(jobIds(deno).includes("dashboard"), false);

  assertStringIncludes(dashboard, "name: Dashboard\n");
  const triggers = workflowTriggers(dashboard);
  assertStringIncludes(
    triggers,
    "  push:\n    branches: [main]\n    paths:\n",
  );
  assertEquals(triggers.includes("  workflow_dispatch:"), false);
  assertEquals(triggers.includes("  pull_request:"), false);
  assertEquals(triggers.includes("  workflow_call:"), false);
  assertStringIncludes(
    dashboard,
    "\npermissions:\n  contents: read\n\nconcurrency:\n",
  );
  assertStringIncludes(dashboard, "group: dashboard-${{ github.ref }}");
  assertEquals(jobIds(dashboard).sort(), ["publish", "tests"]);

  // The tests job checks the event and ref before the publish job it gates gets
  // a credential.
  const tests = jobBlock(dashboard, "tests");
  assertEquals(tests.includes("id-token: write"), false);
  const guard = stepBlock(tests, "Verify the run is a main push");
  assertStringIncludes(
    guard,
    "if: ${{ github.event_name != 'push' || github.ref != 'refs/heads/main' }}",
  );
  assertStringIncludes(guard, "\n          exit 1\n");

  const publish = jobBlock(dashboard, "publish");
  assertStringIncludes(publish, "needs: [tests]");
  assertEquals(publish.includes("\n    if:"), false);
  assertStringIncludes(
    publish,
    "permissions:\n" +
      "      attestations: write\n" +
      "      contents: read\n" +
      "      id-token: write",
  );
  assertStringIncludes(
    publish,
    "uses: useblacksmith/setup-docker-builder@" +
      "6ff44f8e5255f9d8aa31ef22f7e57a2d926b7da0 # v1",
  );

  const build = stepBlock(publish, "Build and push dashboard image");
  assertStringIncludes(
    build,
    "uses: useblacksmith/build-push-action@" +
      "fb9e3e6a9299c78462bfadd0d93352c316adc9b8 # v2",
  );
  assertStringIncludes(build, "\n          push: true\n");
  assertStringIncludes(
    build,
    "\n          build-args: |\n" +
      "            DASHBOARD_GIT_COMMIT=${{ github.sha }}\n",
  );
  assertStringIncludes(
    build,
    "\n          tags: ${{ env.IMAGE }}:${{ github.sha }}\n",
  );
  assertEquals(build.includes(":latest"), false);
  assertEquals(build.includes("\n        if:"), false);

  const provenanceLabels = [
    "org.opencontainers.image.source=https://github.com/${{ github.repository }}",
    "org.opencontainers.image.revision=${{ github.sha }}",
    "org.opencontainers.image.version=${{ github.sha }}",
    "dev.commontools.provenance.repository=${{ github.repository }}",
    "dev.commontools.provenance.ref=${{ github.ref }}",
    "dev.commontools.provenance.event=${{ github.event_name }}",
    "dev.commontools.provenance.workflow-ref=${{ github.workflow_ref }}",
    "dev.commontools.provenance.run-id=${{ github.run_id }}",
    "dev.commontools.provenance.run-attempt=${{ github.run_attempt }}",
  ];
  for (const label of provenanceLabels) {
    assertStringIncludes(build, `            ${label}\n`);
  }

  assertEquals(
    publish.includes("- name: Resolve existing immutable image"),
    false,
  );
  assertEquals(publish.includes("- name: Promote existing image"), false);

  const result = stepBlock(publish, "Resolve published digest");
  assertStringIncludes(
    result,
    "          DIGEST: ${{ steps.build.outputs.digest }}\n",
  );
  assertStringIncludes(
    result,
    '          [[ "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]\n',
  );

  const attestation = stepBlock(publish, "Attest published image");
  assertStringIncludes(
    attestation,
    "uses: actions/attest-build-provenance@" +
      "977bb373ede98d70efdf65b84cb5f73e068dcc2a # v3",
  );
  assertStringIncludes(
    attestation,
    "\n          subject-name: ${{ env.IMAGE }}\n",
  );
  assertStringIncludes(
    attestation,
    "          subject-digest: ${{ steps.result.outputs.digest }}\n",
  );
  assert(
    publish.indexOf("- name: Resolve published digest") <
      publish.indexOf("- name: Attest published image"),
  );
});
