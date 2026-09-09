/** Resource ceilings for explicitly requested, opt-in stress measurements. */

const GiB = 1024 ** 3;
export const PROFILE_CEILINGS = {
  files: 10000,
  sourceBytes: 12 * GiB,
  archiveBytes: 16 * GiB,
  diskBytes: 32 * GiB,
  processRss: 3 * GiB,
  aggregateRss: 5 * GiB,
} as const;

/** Stops the process tree when a safety limit is observed. */
export class ProfileSafety implements Disposable {
  readonly #rootPid: number;
  readonly #done = Promise.withResolvers<void>();
  readonly #directory: string;
  readonly #timer: ReturnType<typeof setInterval>;
  #sampling = false;
  #failed?: Error;
  #lastProcesses: Array<{ pid: number; parent: number; rss: number }> = [];
  readonly #limits: typeof PROFILE_CEILINGS;

  constructor(
    directory: string,
    limits = PROFILE_CEILINGS,
    rootPid = Deno.pid,
  ) {
    this.#directory = directory;
    this.#limits = limits;
    this.#rootPid = rootPid;
    // This interval enforces safety ceilings; it is not a completion condition.
    this.#timer = setInterval(() => {
      void this.sample();
    }, 1000);
  }

  get finished(): Promise<void> {
    return this.#done.promise;
  }
  check(): void {
    if (this.#failed) throw this.#failed;
  }

  async sample(): Promise<void> {
    if (this.#sampling || this.#failed) return;
    this.#sampling = true;
    let descendants: Array<{ pid: number; parent: number; rss: number }> = [];
    try {
      const output = await new Deno.Command("ps", {
        args: ["-axo", "pid=,ppid=,rss="],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!output.success) throw new Error("RSS safety measurement failed");
      const processes = new TextDecoder().decode(output.stdout).trim().split(
        "\n",
      ).map((line) => {
        const [pid, parent, kib] = line.trim().split(/\s+/).map(Number);
        return { pid, parent, rss: kib * 1024 };
      });
      if (!processes.some((process) => process.pid === this.#rootPid)) {
        this[Symbol.dispose]();
        return;
      }
      const selected = new Set([this.#rootPid, Deno.pid]);
      for (let changed = true; changed;) {
        changed = false;
        for (const process of processes) {
          if (selected.has(process.parent) && !selected.has(process.pid)) {
            selected.add(process.pid);
            changed = true;
          }
        }
      }
      descendants = processes.filter((process) => selected.has(process.pid));
      this.#lastProcesses = descendants;
      const aggregate = descendants.reduce(
        (sum, process) => sum + process.rss,
        0,
      );
      if (aggregate >= this.#limits.aggregateRss) {
        throw new Error("Benchmark aggregate RSS reached 5 GiB");
      }
      if (
        descendants.some((process) => process.rss >= this.#limits.processRss)
      ) throw new Error("Benchmark process RSS reached 3 GiB");
      let diskBytes = 0;
      let archiveBytes = 0;
      const measure = async (path: string): Promise<void> => {
        for await (const entry of Deno.readDir(path)) {
          try {
            const child = `${path}/${entry.name}`;
            const info = await Deno.lstat(child);
            if (info.isDirectory) await measure(child);
            else {
              diskBytes += info.size;
              if (child.startsWith(`${this.#directory}/archive/`)) {
                archiveBytes += info.size;
              }
              if (archiveBytes >= this.#limits.archiveBytes) {
                throw new Error("Benchmark archive reached its disk ceiling");
              }
            }
            if (diskBytes >= this.#limits.diskBytes) {
              throw new Error("Benchmark directory reached its disk ceiling");
            }
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
        }
      };
      await measure(this.#directory);
      await Deno.writeTextFile(
        `${this.#directory}/safety-samples.jsonl`,
        JSON.stringify({
          at: Date.now(),
          processes: descendants,
          diskBytes,
          archiveBytes,
        }) +
          "\n",
        { append: true },
      );
    } catch (error) {
      this.#failed = error instanceof Error ? error : new Error(String(error));
      try {
        await Deno.writeTextFile(
          `${this.#directory}/safety-stop.json`,
          JSON.stringify({
            message: this.#failed.message,
            ceilings: this.#limits,
            processes: descendants,
          }),
        );
      } catch (recordError) {
        console.error(recordError);
      }
      for (
        const process
          of (descendants.length ? descendants : this.#lastProcesses)
            .toReversed()
      ) {
        if (process.pid === Deno.pid) continue;
        try {
          Deno.kill(process.pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) console.error(error);
        }
      }
      this[Symbol.dispose]();
    } finally {
      this.#sampling = false;
    }
  }

  [Symbol.dispose](): void {
    clearInterval(this.#timer);
    this.#done.resolve();
  }
}
