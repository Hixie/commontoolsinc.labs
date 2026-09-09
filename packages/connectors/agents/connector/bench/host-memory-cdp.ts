/** Event-driven Chrome measurements for the private browser benchmark. */

type Target = { targetId: string; type: string; url: string };
type Reply = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
  method?: string;
  params?: { sessionId: string; targetInfo: Target };
};

export class ProfileCdp implements Disposable {
  readonly #socket: WebSocket;
  readonly #pending = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<Record<string, unknown>>>
  >();
  #next = 1;
  readonly #workers = new Map<string, { target: Target; sessionId: string }>();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as Reply;
      if (message.method === "Target.attachedToTarget") {
        const { targetInfo: target, sessionId } = message.params!;
        if (target.type === "worker") {
          this.#workers.set(target.targetId, { target, sessionId });
        }
      }
      if (message.method === "Target.detachedFromTarget") {
        for (const [id, worker] of this.#workers) {
          if (worker.sessionId === message.params!.sessionId) {
            this.#workers.delete(id);
          }
        }
      }
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message));
      else pending?.resolve(message.result ?? {});
    };
    const failed = () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("Chrome measurement connection closed"));
      }
      this.#pending.clear();
    };
    socket.onclose = failed;
    socket.onerror = failed;
  }

  static async connect(url: string): Promise<ProfileCdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () =>
        reject(new Error("Chrome measurement connection failed"));
    });
    const cdp = new ProfileCdp(socket);
    await cdp.send("Target.setDiscoverTargets", {
      discover: true,
      filter: [{}],
    });
    return cdp;
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const id = this.#next++;
    const pending = Promise.withResolvers<Record<string, unknown>>();
    this.#pending.set(id, pending);
    this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    return await pending.promise;
  }

  async attach(targetId: string): Promise<string> {
    return (await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })).sessionId as string;
  }

  async targets(): Promise<Target[]> {
    return (await this.send("Target.getTargets", { filter: [{}] }))
      .targetInfos as Target[];
  }

  async observeWorkers(targetId: string): Promise<void> {
    const sessionId = await this.attach(targetId);
    await this.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    }, sessionId);
  }

  async sample(collect = true) {
    const heaps = [];
    const sampled = new Set<string>();
    for (const { target, sessionId } of this.#workers.values()) {
      const before = await this.send("Runtime.getHeapUsage", {}, sessionId);
      if (collect) {
        await this.send("HeapProfiler.collectGarbage", {}, sessionId);
      }
      const after = collect
        ? await this.send("Runtime.getHeapUsage", {}, sessionId)
        : undefined;
      heaps.push({ target, before, after });
      sampled.add(target.targetId);
    }
    for (const target of await this.targets()) {
      if (!["page", "worker"].includes(target.type)) continue;
      if (sampled.has(target.targetId)) continue;
      const sessionId = await this.attach(target.targetId);
      try {
        const before = await this.send("Runtime.getHeapUsage", {}, sessionId);
        if (collect) {
          await this.send("HeapProfiler.collectGarbage", {}, sessionId);
        }
        const after = collect
          ? await this.send("Runtime.getHeapUsage", {}, sessionId)
          : undefined;
        heaps.push({ target, before, after });
      } finally {
        await this.send("Target.detachFromTarget", { sessionId });
      }
    }
    const processes = (await this.send("SystemInfo.getProcessInfo"))
      .processInfo as { id: number; type: string }[];
    const output = await new Deno.Command("ps", {
      args: [
        "-o",
        "pid=,rss=",
        "-p",
        processes.map((process) => process.id).join(","),
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!output.success) throw new Error("Chrome RSS measurement failed");
    const rss = new Map(
      new TextDecoder().decode(output.stdout).trim().split("\n").map((line) => {
        const [pid, kib] = line.trim().split(/\s+/).map(Number);
        return [pid, kib * 1024];
      }),
    );
    return {
      heaps,
      processes: processes.map((process) => ({
        ...process,
        rss: rss.get(process.id),
      })),
    };
  }

  [Symbol.dispose](): void {
    this.#socket.close();
  }
}
