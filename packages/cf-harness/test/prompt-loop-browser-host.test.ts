import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { describe, it } from "@std/testing/bdd";

import type {
  BrowserHostOperation,
  BrowserHostResult,
  HarnessBrowserHost,
} from "../src/contracts/browser-host.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import {
  chatViewOfRequest,
  responsesBodyFromChatFixture,
} from "./support/responses-fixture.ts";

class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }
  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  }
  isPathWithinWorkspace(path: string): boolean {
    return path === "/workspace" || path.startsWith("/workspace/");
  }
  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path);
  }
  defaultWorkingDirectory(): string {
    return "/workspace";
  }
  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

class RecordingBrowserHost implements HarnessBrowserHost {
  readonly operations: BrowserHostOperation[] = [];
  readonly profileFields = [{ name: "name.full", label: "Full name" }];

  perform(operation: BrowserHostOperation): Promise<BrowserHostResult> {
    this.operations.push(operation);
    return Promise.resolve({
      status: "ok",
      page: { url: "https://shop.example/", title: "Shop" },
    });
  }
}

const scriptedFetch = (
  payloads: readonly unknown[],
  requestBodies: unknown[],
): typeof fetch =>
(_input, init) => {
  requestBodies.push(JSON.parse(String(init?.body)));
  const payload = payloads[requestBodies.length - 1];
  if (payload === undefined) {
    throw new Error("scripted fetch ran out of payloads");
  }
  return Promise.resolve(
    new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
      status: 200,
    }),
  );
};

const toolCallTurn = (id: string, name: string, input: unknown) => ({
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(input) },
      }],
    },
  }],
});

const finalTurn = (content: string) => ({
  choices: [{ index: 0, message: { role: "assistant", content } }],
});

describe("prompt-loop with a browser host", () => {
  it("briefs the parent and a browser child, drives the host, and accepts a text answer to a task done on the web", async () => {
    const host = new RecordingBrowserHost();
    const requestBodies: unknown[] = [];
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-browser-host",
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
        browserHost: host,
      }),
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["browser"],
      requirePieceOutput: true,
      fetchFn: scriptedFetch([
        toolCallTurn("call-find", "delegate_task", {
          profile: "browser",
          goal: "Find the item's page.",
          returnSchema: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
            additionalProperties: false,
          },
        }),
        toolCallTurn("call-open", "browser", {
          action: "open",
          url: "https://shop.example/",
        }),
        finalTurn(JSON.stringify({ url: "https://shop.example/item/7" })),
        finalTurn("Found the **item**."),
      ], requestBodies),
    });

    const result = await loop.runPrompt({ prompt: "Find me the item." });

    const parentFirst = JSON.stringify(
      chatViewOfRequest(requestBodies[0]).messages,
    );
    const child = chatViewOfRequest(requestBodies[1]);
    const childSystem = JSON.stringify(child.messages[0]);
    const delegated = JSON.parse(
      result.transcript.findLast((message) =>
        message.role === "tool" && message.toolName === "delegate_task"
      )?.content ?? "{}",
    );
    expect(parentFirst).toContain("this run has a browser the owner watches");
    expect(parentFirst).toContain("name.full (Full name)");
    expect(child.tools).toEqual(["browser"]);
    expect(childSystem).toContain("shown to the owner as you work");
    expect(childSystem).toContain("name.full (Full name)");
    expect(childSystem).not.toContain("Browser Access lease");
    expect(host.operations).toEqual([
      { action: "open", url: "https://shop.example/" },
    ]);
    expect(delegated.subagent.structuredReturn.value.url).toMatch(/^cfh:v:/);
    expect(JSON.stringify(result.transcript)).not.toContain(
      "https://shop.example/item/7",
    );
    expect(result.finalAssistantText).toBe("Found the **item**.");
  });

  it("accepts a text answer after a browser child that did not return what was asked, since the owner may have declined", async () => {
    const requestBodies: unknown[] = [];
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-browser-host-declined",
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
        browserHost: new RecordingBrowserHost(),
      }),
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["browser"],
      requirePieceOutput: true,
      fetchFn: scriptedFetch([
        toolCallTurn("call-buy", "delegate_task", {
          profile: "browser",
          goal: "Buy the item.",
          returnSchema: {
            type: "object",
            properties: { orderNumber: { type: "string" } },
            required: ["orderNumber"],
            additionalProperties: false,
          },
        }),
        finalTurn("The owner declined the purchase."),
        finalTurn("You declined the purchase, so nothing was bought."),
      ], requestBodies),
    });

    const result = await loop.runPrompt({ prompt: "Buy me the item." });

    const delegated = JSON.parse(
      result.transcript.findLast((message) =>
        message.role === "tool" && message.toolName === "delegate_task"
      )?.content ?? "{}",
    );
    expect(delegated.subagent.status).toBe("failed");
    expect(requestBodies).toHaveLength(3);
    expect(result.finalAssistantText).toBe(
      "You declined the purchase, so nothing was bought.",
    );
  });
});
