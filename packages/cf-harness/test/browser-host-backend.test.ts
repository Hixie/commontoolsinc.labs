import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { expect } from "@std/expect";
import { encodeBase64 } from "@std/encoding/base64";
import { normalize } from "@std/path/posix";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type {
  BrowserHostOperation,
  BrowserHostResult,
  HarnessBrowserHost,
} from "../src/contracts/browser-host.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
  mintReferentHandle,
} from "../src/handle-table.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import type {
  BrowserToolInput,
  BrowserToolOutput,
} from "../src/tools/browser.ts";

const signer = await Identity.fromPassphrase("cf-harness browser host");

const PAGE = { url: "https://shop.example/cart", title: "Cart" };

/** The eight-byte signature every PNG opens with, and one byte of body. */
const PNG_BYTES = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
]);

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

/**
 * A host that records each operation it is sent and answers from a script,
 * `ok` on the page above once the script runs out.
 */
class FakeBrowserHost implements HarnessBrowserHost {
  readonly operations: BrowserHostOperation[] = [];
  readonly profileFields = [
    { name: "name.full", label: "Full name" },
    { name: "card.number", label: "Card number" },
  ];

  readonly #answers: unknown[];

  constructor(answers: unknown[] = []) {
    this.#answers = answers;
  }

  perform(operation: BrowserHostOperation): Promise<BrowserHostResult> {
    this.operations.push(operation);
    const next = this.#answers.shift() ?? { status: "ok", page: PAGE };
    // The fake answers whatever the script holds, results or not, so a test
    // can hand the tool something a real host would never send.
    return Promise.resolve(next as BrowserHostResult);
  }
}

describe("browser-host-backend", () => {
  let artifactRoot: string;

  beforeEach(async () => {
    artifactRoot = await Deno.makeTempDir({ prefix: "cf-harness-host-" });
  });

  afterEach(async () => {
    await Deno.remove(artifactRoot, { recursive: true });
  });

  const createEngine = (
    host: HarnessBrowserHost,
    options: { fabric?: () => Promise<{ pieces: PiecesController }> } = {},
  ) =>
    new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `browser-host-test-${crypto.randomUUID()}`,
      workspaceHostPath: "/tmp/cf-harness-workspace",
      artifactRoot,
      browserHost: host,
      ...(options.fabric !== undefined
        ? { fabricSessionFactory: options.fabric }
        : {}),
    });

  const invoke = async (
    engine: CfHarnessEngine,
    input: BrowserToolInput,
  ): Promise<BrowserToolOutput> =>
    (await engine.invokeBuiltinTool("browser", input)).output;

  describe("operations", () => {
    it("sends each action to the host as one operation", async () => {
      const host = new FakeBrowserHost();
      const engine = createEngine(host);

      await invoke(engine, { action: "open", url: "https://shop.example/" });
      await invoke(engine, { action: "back" });
      await invoke(engine, { action: "scroll", direction: "down" });
      await invoke(engine, { action: "snapshot", interactive: true });
      await invoke(engine, { action: "click", x: 120, y: 48.5 });
      await invoke(engine, { action: "click", ref: "@e3" });
      await invoke(engine, { action: "wait", urlPattern: "**/checkout" });
      await invoke(engine, { action: "fill", ref: "@e2", value: "blue" });

      expect(host.operations).toEqual([
        { action: "open", url: "https://shop.example/" },
        { action: "back" },
        { action: "scroll", direction: "down" },
        { action: "snapshot", interactive: true },
        { action: "click", x: 120, y: 48.5 },
        { action: "click", ref: "@e3" },
        { action: "wait", urlPattern: "**/checkout" },
        {
          action: "fill",
          ref: "@e2",
          value: { kind: "text", text: "blue" },
        },
      ]);
    });

    it("returns the host's text with the page the host committed", async () => {
      const host = new FakeBrowserHost([
        { status: "ok", page: PAGE, text: '- button "Buy" [@e3]' },
      ]);
      const engine = createEngine(host);

      const output = await invoke(engine, { action: "snapshot" });

      expect(output).toMatchObject({
        status: "ok",
        output: '- button "Buy" [@e3]',
        page: PAGE,
      });
    });

    it("returns how the owner ended a hand-off", async () => {
      const host = new FakeBrowserHost([
        { status: "ok", page: PAGE, handoff: "declined" },
      ]);
      const engine = createEngine(host);

      const output = await invoke(engine, {
        action: "handoff",
        prompt: "Please sign in to your account.",
      });

      expect(host.operations).toEqual([{
        action: "handoff",
        prompt: "Please sign in to your account.",
      }]);
      expect(output).toMatchObject({ status: "ok", handoff: "declined" });
    });

    it("refuses a time-based wait and a timeout without contacting the host", async () => {
      const host = new FakeBrowserHost();
      const engine = createEngine(host);

      const wait = await invoke(engine, { action: "wait", ms: 500 });
      const timeout = await invoke(engine, {
        action: "snapshot",
        timeoutMs: 5_000,
      });

      expect(wait).toMatchObject({ status: "error", code: "invalid_input" });
      expect(timeout).toMatchObject({ status: "error", code: "invalid_input" });
      expect(host.operations).toEqual([]);
    });

    it("refuses a click given both a ref and a point", async () => {
      const host = new FakeBrowserHost();
      const engine = createEngine(host);

      const output = await invoke(engine, {
        action: "click",
        ref: "@e1",
        x: 1,
        y: 2,
      });

      expect(output).toMatchObject({
        status: "error",
        code: "invalid_input",
        message: "click takes a ref or a point (x and y), never both",
      });
      expect(host.operations).toEqual([]);
    });
  });

  describe("values", () => {
    it("names a profile field the host offered, and never a value", async () => {
      const host = new FakeBrowserHost();
      const engine = createEngine(host);

      await invoke(engine, {
        action: "fill",
        ref: "@e4",
        profileField: "card.number",
      });

      expect(host.operations).toEqual([{
        action: "fill",
        ref: "@e4",
        value: { kind: "profile-field", field: "card.number" },
      }]);
    });

    it("refuses a profile field the host did not offer, listing those it did", async () => {
      const host = new FakeBrowserHost();
      const engine = createEngine(host);

      const output = await invoke(engine, {
        action: "type",
        ref: "@e4",
        profileField: "passport.number",
      });

      expect(output).toMatchObject({
        status: "error",
        code: "invalid_input",
        message:
          "the owner's profile offers no field named passport.number; it offers name.full, card.number",
      });
      expect(host.operations).toEqual([]);
    });

    it("enters a child's returned string as a handle value, and opens a returned URL", async () => {
      const host = new FakeBrowserHost();
      const engine = createEngine(host);
      let table = createHarnessHandleTable(engine.getRunState().runId);
      const child = {
        kind: "return" as const,
        source: "delegate_task:child",
        label: {},
        labelSource: "child" as const,
      };
      const url = await mintReferentHandle(table, {
        ...child,
        value: "https://shop.example/item/7",
      });
      table = url.table;
      const size = await mintReferentHandle(table, { ...child, value: "XL" });
      await engine.recordHandleTable(size.table);

      await invoke(engine, { action: "open", urlHandle: url.token });
      await invoke(engine, {
        action: "select",
        ref: "@e9",
        valueHandle: size.token,
      });

      expect(host.operations).toEqual([
        { action: "open", url: "https://shop.example/item/7" },
        {
          action: "select",
          ref: "@e9",
          value: {
            kind: "handle-value",
            text: "XL",
            description: "a value an agent found",
          },
        },
      ]);
    });

    it("refuses a referent token the run does not hold", async () => {
      const host = new FakeBrowserHost();
      const engine = createEngine(host);

      const output = await invoke(engine, {
        action: "open",
        urlHandle: "cfh:v:zzzzz",
      });

      expect(output).toMatchObject({ status: "error", code: "invalid_input" });
      expect(host.operations).toEqual([]);
    });

    describe("from the owner's space", () => {
      let storageManager: ReturnType<typeof StorageManager.emulate>;
      let runtime: Runtime;
      let pieces: PiecesController;

      beforeEach(async () => {
        storageManager = StorageManager.emulate({ as: signer });
        runtime = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager,
        });
        pieces = new PiecesController(
          await createSession({
            identity: signer,
            spaceDid: (await Identity.generate()).did(),
          }),
          runtime,
        );
        await pieces.synced();
      });

      afterEach(async () => {
        await runtime?.dispose();
        await storageManager?.close();
      });

      it("enters a value from the owner's space as a handle value", async () => {
        const space = pieces.getSpace();
        const cell = runtime.getCell(space, "address", {} as const);
        const { error } = await runtime.editWithRetry((tx) => {
          cell.withTx(tx).set("1 Main St");
        });
        expect(error).toBeUndefined();
        await runtime.idle();
        const ref = createLLMFriendlyLink(
          cell.getAsNormalizedFullLink(),
          space,
        );
        const host = new FakeBrowserHost();
        const engine = createEngine(host, {
          fabric: () => Promise.resolve({ pieces }),
        });
        const minted = await mintAddressHandle(
          createHarnessHandleTable(engine.getRunState().runId),
          ref,
        );
        await engine.recordHandleTable(minted.table);

        await invoke(engine, {
          action: "fill",
          ref: "@e1",
          valueHandle: minted.token,
        });

        expect(host.operations).toEqual([{
          action: "fill",
          ref: "@e1",
          value: {
            kind: "handle-value",
            text: "1 Main St",
            description: "a value from your space",
          },
        }]);
      });
    });
  });

  describe("results", () => {
    it("returns a long page title cut to 200 characters, never inside one", async () => {
      // A family emoji is one character written as seven code points.
      const character =
        "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
      const long = character.repeat(250);
      const host = new FakeBrowserHost([
        { status: "ok", page: { url: "https://shop.example/", title: long } },
        { status: "ok", page: { url: "https://shop.example/", title: "Shop" } },
      ]);
      const engine = createEngine(host);

      const cut = await invoke(engine, { action: "reload" });
      const kept = await invoke(engine, { action: "reload" });

      expect(cut).toMatchObject({
        status: "ok",
        page: { title: `${character.repeat(200)}…` },
      });
      expect(kept).toMatchObject({ status: "ok", page: { title: "Shop" } });
    });

    it("reports each host refusal under its own code", async () => {
      const host = new FakeBrowserHost([
        { status: "stale-ref", message: "the page changed" },
        { status: "owner-only-field", message: "a password field" },
        { status: "session-ended", message: "the owner closed it" },
        { status: "failed", message: "navigation failed" },
      ]);
      const engine = createEngine(host);

      const codes = [];
      for (let index = 0; index < 4; index++) {
        const output = await invoke(engine, { action: "click", ref: "@e1" });
        codes.push(output.status === "error" ? output.code : output.status);
      }

      expect(codes).toEqual([
        "stale_ref",
        "owner_only_field",
        "session_ended",
        "command_failed",
      ]);
    });

    it("returns host_unavailable for an answer that is not a result", async () => {
      const host = new FakeBrowserHost([{ status: "ok" }]);
      const engine = createEngine(host);

      const output = await invoke(engine, { action: "reload" });

      expect(output).toMatchObject({
        status: "error",
        code: "host_unavailable",
        message:
          "the browser host answered with something that is not a result",
      });
    });

    it("keeps a screenshot as an attachment of the run", async () => {
      const host = new FakeBrowserHost([{
        status: "ok",
        page: PAGE,
        image: { mediaType: "image/png", base64: encodeBase64(PNG_BYTES) },
      }]);
      const engine = createEngine(host);

      const output = await invoke(engine, { action: "screenshot" });

      if (output.status !== "ok" || output.imageAttachment === undefined) {
        throw new Error("expected a screenshot attachment");
      }
      expect(output.imageAttachment.mediaType).toBe("image/png");
      expect(await Deno.readFile(output.imageAttachment.hostPath)).toEqual(
        PNG_BYTES,
      );
    });

    it("refuses a screenshot whose bytes are not the image it claims", async () => {
      const host = new FakeBrowserHost([{
        status: "ok",
        page: PAGE,
        image: {
          mediaType: "image/png",
          base64: encodeBase64(new Uint8Array([1])),
        },
      }]);
      const engine = createEngine(host);

      const output = await invoke(engine, { action: "screenshot" });

      expect(output).toMatchObject({ status: "error", code: "command_failed" });
    });
  });
});
