import { expect } from "@std/expect";
import type { AgentArchiveCatalog } from "@commonfabric/agents-connector/archive";
import type {
  ArchiveReadCommand,
  ArchiveResult,
} from "@commonfabric/memory/v2/archive";
import type { CFAgentArchive } from "./index.ts";
import "./index.ts";

type ArchiveCell = NonNullable<CFAgentArchive["value"]>;

class Reader implements ArchiveCell {
  readonly commands: ArchiveReadCommand[] = [];
  readonly readStarted = Promise.withResolvers<void>();
  legacy: NonNullable<ArchiveResult["legacy"]> = {
    status: "available",
    wire:
      '{"value":{"/":{"link@1":{"id":"of:opaque-linked-document","path":[]}}}}',
  };
  holdRead = false;
  failPin = false;
  readAborted = false;
  subscribed = false;
  #callback?: Parameters<ArchiveCell["subscribe"]>[0];

  publish(generation: string | undefined): void {
    this.#callback?.(
      generation
        ? {
          schema: "commonfabric.agent-connector.catalog.v2",
          archive: "archive",
          generation,
          ownerDid: "owner",
          generatedAt: "2026-09-08T00:00:00.000Z",
          sessionCount: 10000,
          checkoutCount: 0,
          sources: [],
        } satisfies AgentArchiveCatalog
        : undefined,
    );
  }

  subscribe(callback: Parameters<ArchiveCell["subscribe"]>[0]): () => void {
    this.subscribed = true;
    this.#callback = callback;
    this.publish("first");
    return () => {
      this.subscribed = false;
      this.#callback = undefined;
    };
  }

  archive(
    command: Extract<ArchiveReadCommand, { op: "read" }>,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  archive(
    command: Exclude<ArchiveReadCommand, { op: "read" }>,
    signal?: AbortSignal,
  ): Promise<ArchiveResult>;
  async archive(
    command: ArchiveReadCommand,
    signal?: AbortSignal,
  ): Promise<ArchiveResult | Uint8Array> {
    this.commands.push(command);
    switch (command.op) {
      case "pin":
        if (this.failPin) throw new Error("pin response lost");
        return { pin: command.pin, generation: command.generation };
      case "release":
        return {};
      case "legacy-read":
        return { legacy: this.legacy };
      case "list":
        return {
          records: Array.from({ length: 16 }, (_, index) => {
            const key = `session-${(command.after ? 16 : 0) + index}`;
            return {
              key,
              source: "test",
              record: key,
              partial: false,
              metadata: JSON.stringify({ summary: { title: key } }),
            };
          }),
        };
      case "pages":
        return {
          pages: [0, 1].map((index) => ({
            index,
            hash: `hash-${index}`,
            bytes: 10,
            metadata: "{}",
          })),
        };
      case "read": {
        this.readStarted.resolve();
        if (this.holdRead) {
          await new Promise<void>((_resolve, reject) => {
            const abort = () => {
              this.readAborted = true;
              reject(signal!.reason);
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          });
        }
        return new TextEncoder().encode(`native page ${command.index}`);
      }
      default:
        throw new Error(`Unexpected operation ${command.op}`);
    }
  }
}

async function idle(element: CFAgentArchive): Promise<void> {
  await element.accessForTestingOnly.idle;
  await element.updateComplete;
}

function button(element: CFAgentArchive, label: string): HTMLButtonElement {
  const result = [...element.shadowRoot!.querySelectorAll("button")].find((
    button,
  ) => button.textContent?.trim() === label);
  if (!result) throw new Error(`Button is absent: ${label}`);
  return result;
}

async function mount(reader: Reader): Promise<CFAgentArchive> {
  const element = document.createElement("cf-agent-archive");
  element.value = reader;
  document.body.append(element);
  await idle(element);
  return element;
}

Deno.test("catalog and native page navigation replace visible data and release the pin on removal", async () => {
  const reader = new Reader();
  const element = await mount(reader);
  try {
    expect(element.shadowRoot!.querySelectorAll("tbody tr").length).toBe(16);
    button(element, "Next").click();
    await idle(element);
    expect(element.shadowRoot!.querySelectorAll("tbody tr").length).toBe(16);
    expect(element.shadowRoot!.textContent).not.toContain("session-0");
    expect(element.shadowRoot!.textContent).toContain("session-16");
    button(element, "Inspect").click();
    await idle(element);
    button(element, "Page 1 · 10 bytes").click();
    await idle(element);
    const firstDownload = element.shadowRoot!.querySelector("a")!.href;
    expect(element.shadowRoot!.textContent).toContain("native page 0");
    button(element, "Page 2 · 10 bytes").click();
    await idle(element);
    expect(element.shadowRoot!.textContent).not.toContain("native page 0");
    expect(element.shadowRoot!.textContent).toContain("native page 1");
    expect(element.shadowRoot!.querySelectorAll("a").length).toBe(1);
    expect(element.shadowRoot!.querySelector("a")!.href).not.toBe(
      firstDownload,
    );
    await expect(fetch(firstDownload)).rejects.toThrow();
  } finally {
    element.remove();
    await idle(element);
  }
  expect(reader.subscribed).toBe(false);
  expect(reader.commands.at(-1)).toEqual({
    op: "release",
    archive: "archive",
    pin: reader.commands.find((command) => command.op === "pin")!.pin,
  });
});

Deno.test("a new generation cancels a pending native read and replaces its pin before listing", async () => {
  const reader = new Reader();
  reader.holdRead = true;
  const element = await mount(reader);
  try {
    button(element, "Inspect").click();
    await idle(element);
    button(element, "Page 1 · 10 bytes").click();
    await reader.readStarted.promise;
    reader.publish("second");
    await idle(element);
    expect(reader.readAborted).toBe(true);
    expect(element.shadowRoot!.textContent).not.toContain("native page");
    expect(reader.commands.slice(-3).map((command) => command.op)).toEqual([
      "release",
      "pin",
      "list",
    ]);
    expect(reader.commands.at(-1)).toMatchObject({
      generation: "second",
      pin: reader.commands.findLast((command) => command.op === "pin")!.pin,
    });
    reader.publish(undefined);
    await idle(element);
    expect(element.shadowRoot!.querySelectorAll("tbody tr").length).toBe(0);
    expect(reader.commands.at(-1)).toEqual({
      op: "release",
      archive: "archive",
      pin: reader.commands.findLast((command) => command.op === "pin")!.pin,
    });
  } finally {
    element.remove();
    await idle(element);
  }
});

Deno.test("legacy inspection renders bounded wire text without opening linked cells and releases the prior download", async () => {
  const reader = new Reader();
  const element = await mount(reader);
  try {
    button(element, "Inspect").click();
    await idle(element);
    button(element, "Page 1 · 10 bytes").click();
    await idle(element);
    const previousDownload = element.shadowRoot!.querySelector("a")!.href;
    const input = element.shadowRoot!.querySelector<HTMLInputElement>(
      "details input",
    )!;
    input.value = "of:legacy-document";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    button(element, "Inspect legacy document").click();
    await idle(element);
    expect(reader.commands.at(-1)).toEqual({
      op: "legacy-read",
      archive: "archive",
      id: "of:legacy-document",
    });
    expect(element.shadowRoot!.textContent).toContain(
      "of:opaque-linked-document",
    );
    expect(element.shadowRoot!.querySelectorAll("cf-cell-link, a").length).toBe(
      0,
    );
    await expect(fetch(previousDownload)).rejects.toThrow();
    reader.legacy = {
      status: "refused",
      message: "Legacy document cannot be inspected.",
    };
    button(element, "Inspect legacy document").click();
    await idle(element);
    expect(element.shadowRoot!.textContent).toContain(reader.legacy.message);
    expect(element.shadowRoot!.textContent).not.toContain(
      "of:opaque-linked-document",
    );
  } finally {
    element.remove();
    await idle(element);
  }
});

Deno.test("an owner is installed before a pin response can fail and is released on removal", async () => {
  const reader = new Reader();
  reader.failPin = true;
  const element = await mount(reader);
  expect(element.shadowRoot!.textContent).toContain("pin response lost");
  const request = reader.commands.find((command) => command.op === "pin")!;
  expect(request.pin).toBeDefined();
  element.remove();
  await idle(element);
  expect(reader.commands.at(-1)).toEqual({
    op: "release",
    archive: request.archive,
    pin: request.pin,
  });
});
