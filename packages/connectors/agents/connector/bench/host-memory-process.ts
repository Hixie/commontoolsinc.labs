/** Process control for private, opt-in integration benchmarks. */

import { TextLineStream } from "@std/streams/text-line-stream";

type Pending = ReturnType<typeof Promise.withResolvers<unknown>>;

async function processes(): Promise<{ pid: number; parent: number }[]> {
  const output = await new Deno.Command("ps", {
    args: ["-axo", "pid=,ppid="],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) throw new Error("Process cleanup measurement failed");
  return new TextDecoder().decode(output.stdout).trim().split("\n").map(
    (line) => {
      const [pid, parent] = line.trim().split(/\s+/).map(Number);
      return { pid, parent };
    },
  );
}
export class ProfileProcess {
  readonly child: Deno.ChildProcess;
  readonly ready: Promise<unknown>;
  readonly #pending = new Map<string, Pending>();
  readonly #output: Promise<void>;
  readonly #errors: Promise<void>;
  readonly #replies: Promise<void>;
  readonly #input: WritableStreamDefaultWriter<Uint8Array>;
  readonly #encoder = new TextEncoder();
  #closing?: Promise<void>;
  #exited = false;
  #failure?: Error;

  constructor(
    script: string,
    readonly name: string,
    readonly directory: string,
    configPath = `${directory}/profile.json`,
  ) {
    const entry = new URL(script, import.meta.url).pathname;
    const command = Deno.build.os === "darwin"
      ? "/usr/bin/time"
      : Deno.execPath();
    const time = Deno.build.os === "darwin"
      ? ["-l", "-o", `${directory}/${name}.rss`, Deno.execPath()]
      : [];
    const socket = `${directory}/${name}.socket`;
    const listener = Deno.listen({ transport: "unix", path: socket });
    let listening = true;
    const closeListener = () => {
      if (!listening) return;
      listening = false;
      listener.close();
    };
    this.child = new Deno.Command(command, {
      args: [
        ...time,
        "run",
        "-A",
        "--v8-flags=--expose-gc,--trace-gc-nvp",
        entry,
        configPath,
        name,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env: { XDG_STATE_HOME: `${directory}/state`, HEADLESS: "1" },
    }).spawn();
    const child = this.child;
    void child.status.then(() => {
      this.#exited = true;
      closeListener();
    });
    this.#input = child.stdin.getWriter();
    const ready = Promise.withResolvers<unknown>();
    this.ready = ready.promise;
    this.#pending.set("ready", ready);
    this.#output = (async () => {
      using file = await Deno.open(`${directory}/${name}.stdout`, {
        createNew: true,
        write: true,
      });
      for await (
        const line of child.stdout.pipeThrough(new TextDecoderStream())
          .pipeThrough(new TextLineStream())
      ) {
        const bytes = this.#encoder.encode(line + "\n");
        let offset = 0;
        while (offset < bytes.length) {
          offset += await file.write(bytes.subarray(offset));
        }
      }
    })();
    this.#replies = (async () => {
      using connection = await listener.accept();
      closeListener();
      for await (
        const line of connection.readable.pipeThrough(new TextDecoderStream())
          .pipeThrough(new TextLineStream())
      ) {
        const { id, value } = JSON.parse(line);
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        if (value?.error) {
          pending?.reject(
            new Error(`${name}: ${value.error}\n${value.stack ?? ""}`),
          );
        } else pending?.resolve(value);
      }
    })().catch((error) => {
      this.#failure = error instanceof Error ? error : new Error(String(error));
      for (const pending of this.#pending.values()) {
        pending.reject(this.#failure);
      }
      this.#pending.clear();
      if (!this.#exited) child.kill("SIGTERM");
    }).finally(async () => {
      const status = await child.status;
      this.#failure ??= new Error(
        `${name} exited with ${status.code}; inspect ${directory}/${name}.stderr`,
      );
      for (const pending of this.#pending.values()) {
        pending.reject(this.#failure);
      }
      this.#pending.clear();
      await Deno.remove(socket).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    });
    this.#errors = (async () => {
      using file = await Deno.open(`${directory}/${name}.stderr`, {
        createNew: true,
        write: true,
      });
      for await (const chunk of child.stderr) {
        let offset = 0;
        while (offset < chunk.length) {
          offset += await file.write(chunk.subarray(offset));
        }
      }
    })();
  }
  async call(op: string, details: Record<string, unknown> = {}) {
    if (this.#failure) throw this.#failure;
    if (this.#exited) throw new Error(`${this.name} has exited`);
    const id = crypto.randomUUID();
    const pending = Promise.withResolvers<unknown>();
    this.#pending.set(id, pending);
    try {
      await this.#input.write(
        this.#encoder.encode(JSON.stringify({ id, op, ...details }) + "\n"),
      );
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    return await pending.promise;
  }
  close(): Promise<void> {
    return this.#closing ??= this.#close();
  }
  async #close() {
    const failures: unknown[] = [];
    const owned = new Set([this.child.pid]);
    const before = await processes();
    for (let changed = true; changed;) {
      changed = false;
      for (const process of before) {
        if (owned.has(process.parent) && !owned.has(process.pid)) {
          owned.add(process.pid);
          changed = true;
        }
      }
    }
    try {
      if (!this.#exited) await this.call("stop");
    } catch (error) {
      failures.push(error);
    } finally {
      await this.#input.close().catch(() => {});
    }
    for (
      const result of await Promise.allSettled([
        this.#output,
        this.#errors,
        this.#replies,
      ])
    ) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    const status = await this.child.status;
    if (!status.success) {
      failures.push(new Error(`${this.name} failed with ${status.code}`));
    }
    const remaining = (await processes()).filter((process) =>
      owned.has(process.pid)
    );
    if (remaining.length) {
      failures.push(new Error(`${this.name} left child processes running`));
    }
    await Deno.writeTextFile(
      `${this.directory}/${this.name}-closed.json`,
      JSON.stringify({
        processes: [...owned],
        remaining,
        processExitCode: status.code,
      }),
    );
    if (failures.length) {
      throw new AggregateError(failures, `${this.name} did not close cleanly`);
    }
  }
}
