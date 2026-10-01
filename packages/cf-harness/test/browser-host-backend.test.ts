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
  readonly profileFields: readonly { name: string; label: string }[];

  readonly #answers: unknown[];

  constructor(
    answers: unknown[] = [],
    profileFields = [
      { name: "name.full", label: "Full name" },
      { name: "card.number", label: "Card number" },
    ],
  ) {
    this.#answers = answers;
    this.profileFields = profileFields;
  }

  perform(operation: BrowserHostOperation): Promise<BrowserHostResult> {
    this.operations.push(operation);
    const next = this.#answers.shift() ?? { status: "ok", page: PAGE };
    if (next instanceof Error) {
      return Promise.reject(next);
    }
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
    options: {
      fabric?: () => Promise<{ pieces: PiecesController }>;
      handleValueOrigins?: readonly string[];
    } = {},
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
      ...(options.handleValueOrigins !== undefined
        ? { handleValueOrigins: options.handleValueOrigins }
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

    it("sends each read, wait and key to the host as one operation", async () => {
      const host = new FakeBrowserHost();
      const engine = createEngine(host);

      await invoke(engine, { action: "get", kind: "title" });
      await invoke(engine, { action: "get", kind: "text", target: "body" });
      await invoke(engine, { action: "wait", ref: "@e5" });
      await invoke(engine, { action: "wait", loadState: "load" });
      await invoke(engine, { action: "scroll", direction: "up", ref: "@e6" });
      await invoke(engine, { action: "check", ref: "@e7" });
      await invoke(engine, { action: "press", key: "Enter" });

      expect(host.operations).toEqual([
        { action: "get", kind: "title" },
        { action: "get", kind: "text", target: "body" },
        { action: "wait", ref: "@e5" },
        { action: "wait", loadState: "load" },
        { action: "scroll", direction: "up", ref: "@e6" },
        { action: "check", ref: "@e7" },
        { action: "press", key: "Enter" },
      ]);
    });

    it("refuses each call it cannot send, saying what the call needs, without contacting the host", async () => {
      const refused: [BrowserToolInput, string][] = [
        [{ action: "open", url: "" }, "open requires a url"],
        [
          { action: "open", url: "file:///etc/passwd" },
          "open only allows http(s) URLs",
        ],
        [
          { action: "scroll", direction: "sideways" },
          "scroll requires a direction: up, down, left, right",
        ],
        [
          { action: "scroll", direction: "down", ref: "e6" },
          "scroll requires a ref starting with @, taken from a snapshot",
        ],
        [
          { action: "get", kind: "url", target: "body" },
          "get url does not take a target",
        ],
        [
          { action: "get", kind: "text" },
          "get text requires a target: a CSS selector such as body, or an @ref from a snapshot",
        ],
        [
          { action: "get", kind: "html" },
          "get requires kind title, url, or text",
        ],
        [
          { action: "wait", ref: "@e1", loadState: "load" },
          "wait requires exactly one of ref, loadState, or urlPattern",
        ],
        [
          { action: "wait", ref: "e1" },
          "wait requires a ref starting with @, taken from a snapshot",
        ],
        [
          { action: "wait", loadState: "idle" },
          "wait loadState must be domcontentloaded, load, or networkidle",
        ],
        [
          { action: "wait", urlPattern: "file:///tmp/*" },
          "wait urlPattern requires a non-file pattern",
        ],
        [
          { action: "click", x: 10 },
          "click at a point requires both x and y, each a non-negative number of screenshot pixels",
        ],
        [
          { action: "click", ref: "e1" },
          "click requires a ref starting with @, taken from a snapshot",
        ],
        [
          { action: "check", ref: "e1" },
          "check requires a ref starting with @, taken from a snapshot",
        ],
        [
          { action: "press", key: "Control Alt" },
          "press requires one key of letters, digits, _, +, ., or -",
        ],
        [
          { action: "fill", ref: "e2", value: "blue" },
          "fill requires a ref starting with @, taken from a snapshot",
        ],
        [
          { action: "type", ref: "@e2" },
          "type requires a value, a valueHandle, or a profileField",
        ],
        [
          { action: "type", ref: "@e2", profileField: " " },
          "profileField must name a field of the owner's profile",
        ],
        [
          { action: "handoff", prompt: "   " },
          "handoff requires a prompt telling the owner what to do",
        ],
        [
          { action: "handoff", prompt: "x".repeat(1_001) },
          "handoff prompt must be at most 1000 characters",
        ],
      ];
      const host = new FakeBrowserHost();
      const engine = createEngine(host);

      const messages = [];
      for (const [input] of refused) {
        const output = await invoke(engine, input);
        messages.push(output.status === "error" ? output.message : "sent");
      }

      expect(messages).toEqual(refused.map(([, message]) => message));
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

    it("refuses a profile field when the host offers none", async () => {
      const host = new FakeBrowserHost([], []);
      const engine = createEngine(host);

      const output = await invoke(engine, {
        action: "fill",
        ref: "@e4",
        profileField: "name.full",
      });

      expect(output).toMatchObject({
        status: "error",
        code: "invalid_input",
        message: "the owner's profile offers no fields to this run",
      });
      expect(host.operations).toEqual([]);
    });

    it("refuses to open a returned string that is not a web address", async () => {
      const host = new FakeBrowserHost();
      const engine = createEngine(host);
      const { table, token } = await mintReferentHandle(
        createHarnessHandleTable(engine.getRunState().runId),
        {
          kind: "return",
          source: "delegate_task:child",
          label: {},
          labelSource: "child",
          value: "javascript:alert(1)",
        },
      );
      await engine.recordHandleTable(table);

      const output = await invoke(engine, { action: "open", urlHandle: token });

      expect(output).toMatchObject({
        status: "error",
        code: "invalid_input",
        message: "open only allows http(s) URLs",
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

    it("refuses a returned value that is not a string", async () => {
      const host = new FakeBrowserHost();
      const engine = createEngine(host);
      const { table, token } = await mintReferentHandle(
        createHarnessHandleTable(engine.getRunState().runId),
        {
          kind: "return",
          source: "delegate_task:child",
          label: {},
          labelSource: "child",
          value: 7,
        },
      );
      await engine.recordHandleTable(table);

      const output = await invoke(engine, {
        action: "fill",
        ref: "@e1",
        valueHandle: token,
      });

      expect(output).toMatchObject({
        status: "error",
        code: "invalid_input",
        message:
          "browser valueHandle must name a string value; the referent holds a value of type number",
      });
      expect(host.operations).toEqual([]);
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

      /** A handle to `value`, held in the owner's space, recorded on `engine`. */
      const spaceHandle = async (
        engine: CfHarnessEngine,
        name: string,
        value: string,
      ): Promise<string> => {
        const space = pieces.getSpace();
        const cell = runtime.getCell(space, name, {} as const);
        const { error } = await runtime.editWithRetry((tx) => {
          cell.withTx(tx).set(value);
        });
        expect(error).toBeUndefined();
        await runtime.idle();
        const minted = await mintAddressHandle(
          engine.getRunState().handleTable ??
            createHarnessHandleTable(engine.getRunState().runId),
          createLLMFriendlyLink(cell.getAsNormalizedFullLink(), space),
        );
        await engine.recordHandleTable(minted.table);
        return minted.token;
      };

      const fabric = () => Promise.resolve({ pieces });

      it("enters a value from the owner's space on a page the operator allows, and answers with its handle wherever the page shows it", async () => {
        const host = new FakeBrowserHost([
          { status: "ok", page: PAGE },
          {
            status: "ok",
            page: PAGE,
            text: 'textbox "Address" value="1 Main St"',
          },
          {
            status: "ok",
            page: { url: PAGE.url, title: "Deliver to 1 Main St" },
          },
        ]);
        const engine = createEngine(host, {
          fabric,
          handleValueOrigins: ["https://shop.example"],
        });
        const token = await spaceHandle(engine, "address", "1 Main St");

        const filled = await invoke(engine, {
          action: "fill",
          ref: "@e1",
          valueHandle: token,
        });
        const reloaded = await invoke(engine, { action: "reload" });

        expect(host.operations).toEqual([
          { action: "get", kind: "url" },
          {
            action: "fill",
            ref: "@e1",
            value: {
              kind: "handle-value",
              text: "1 Main St",
              description: "a value from your space",
            },
          },
          { action: "reload" },
        ]);
        expect(filled).toMatchObject({
          status: "ok",
          output: `textbox "Address" value="${token}"`,
        });
        expect(reloaded).toMatchObject({
          status: "ok",
          page: { title: `Deliver to ${token}` },
        });
      });

      it("refuses a value from the owner's space when the run allows no destination, or the page is elsewhere", async () => {
        const closed = new FakeBrowserHost();
        const elsewhere = new FakeBrowserHost([
          {
            status: "ok",
            page: { url: "https://elsewhere.example/", title: "" },
          },
        ]);
        const closedEngine = createEngine(closed, { fabric });
        const elsewhereEngine = createEngine(elsewhere, {
          fabric,
          handleValueOrigins: ["https://shop.example"],
        });

        const refusedClosed = await invoke(closedEngine, {
          action: "fill",
          ref: "@e1",
          valueHandle: await spaceHandle(closedEngine, "a", "1 Main St"),
        });
        const refusedElsewhere = await invoke(elsewhereEngine, {
          action: "fill",
          ref: "@e1",
          valueHandle: await spaceHandle(elsewhereEngine, "b", "1 Main St"),
        });

        expect(refusedClosed).toMatchObject({
          status: "error",
          code: "destination_not_allowed",
          message:
            "this run allows no destination for a handle's value; an operator allows one with --handle-value-origin <origin>",
        });
        expect(closed.operations).toEqual([]);
        expect(refusedElsewhere).toMatchObject({
          status: "error",
          code: "destination_not_allowed",
          message:
            "https://elsewhere.example is not an allowlisted destination for a handle's value; an operator allows one with --handle-value-origin <origin>",
        });
        expect(elsewhere.operations).toEqual([{ action: "get", kind: "url" }]);
      });

      it("opens an address from the owner's space only at an origin the operator allows, and answers with its handle as the page's address", async () => {
        const secret = "https://shop.example/reset?token=s3cret";
        const host = new FakeBrowserHost([
          { status: "ok", page: { url: secret, title: "Reset" } },
        ]);
        const engine = createEngine(host, {
          fabric,
          handleValueOrigins: ["https://shop.example"],
        });
        const allowed = await spaceHandle(engine, "reset", secret);
        const refused = await spaceHandle(
          engine,
          "elsewhere",
          "https://elsewhere.example/reset?token=s3cret",
        );

        const opened = await invoke(engine, {
          action: "open",
          urlHandle: allowed,
        });
        const notOpened = await invoke(engine, {
          action: "open",
          urlHandle: refused,
        });

        expect(host.operations).toEqual([{ action: "open", url: secret }]);
        expect(opened).toMatchObject({
          status: "ok",
          page: { url: allowed, title: "Reset" },
        });
        expect(notOpened).toMatchObject({
          status: "error",
          code: "destination_not_allowed",
        });
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
      const host = new FakeBrowserHost([
        { status: "ok" },
        "ok",
        { status: "ok", page: { url: "https://shop.example/", title: 7 } },
      ]);
      const engine = createEngine(host);

      const outputs = [];
      for (let index = 0; index < 3; index++) {
        outputs.push(await invoke(engine, { action: "reload" }));
      }

      for (const output of outputs) {
        expect(output).toMatchObject({
          status: "error",
          code: "host_unavailable",
          message:
            "the browser host answered with something that is not a result",
        });
      }
    });

    it("returns host_unavailable, with the reason, for a host that cannot be reached", async () => {
      const host = new FakeBrowserHost([new Error("the stream closed")]);
      const engine = createEngine(host);

      const output = await invoke(engine, { action: "reload" });

      expect(output).toMatchObject({
        status: "error",
        code: "host_unavailable",
        message: "the browser host could not be reached: the stream closed",
      });
    });

    it("returns a page's text cut to 20,000 characters, saying how much was left out", async () => {
      const host = new FakeBrowserHost([
        { status: "ok", page: PAGE, text: "a".repeat(20_005) },
      ]);
      const engine = createEngine(host);

      const output = await invoke(engine, { action: "snapshot" });

      expect(output).toMatchObject({
        status: "ok",
        output: `${
          "a".repeat(20_000)
        }\n[cf-harness truncated output: 5 chars omitted]`,
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

    it("refuses a screenshot that is empty, or longer than an attachment may be, before decoding it", async () => {
      const host = new FakeBrowserHost([
        {
          status: "ok",
          page: PAGE,
          image: { mediaType: "image/png", base64: "" },
        },
        {
          status: "ok",
          page: PAGE,
          image: {
            mediaType: "image/png",
            base64: "A".repeat(Math.ceil(20 * 1024 * 1024 / 3) * 4 + 4),
          },
        },
      ]);
      const engine = createEngine(host);

      const empty = await invoke(engine, { action: "screenshot" });
      const large = await invoke(engine, { action: "screenshot" });

      expect(empty).toMatchObject({
        status: "error",
        code: "command_failed",
        message: "the screenshot could not be kept: the image is empty",
      });
      expect(large).toMatchObject({
        status: "error",
        code: "command_failed",
        message:
          "the screenshot could not be kept: the image is too large (max 20971520 bytes)",
      });
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
