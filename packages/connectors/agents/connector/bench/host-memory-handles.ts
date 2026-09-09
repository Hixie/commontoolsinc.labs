/** Counts private data handles retained by the current benchmark process. */

export async function profileDataHandles(directory: string): Promise<{
  nativeHandles: number;
  scratchHandles: number;
  archiveHandles: number;
}> {
  const root = await Deno.realPath(directory);
  const paths: string[] = [];
  if (Deno.build.os === "linux") {
    for await (const entry of Deno.readDir("/proc/self/fd")) {
      try {
        paths.push(await Deno.readLink(`/proc/self/fd/${entry.name}`));
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  } else {
    const output = await new Deno.Command("lsof", {
      args: ["-n", "-P", "-a", "-p", String(Deno.pid), "-F", "n"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!output.success) {
      throw new Error("Open data handle measurement failed");
    }
    for (const line of new TextDecoder().decode(output.stdout).split("\n")) {
      if (line.startsWith("n/")) paths.push(line.slice(1));
    }
  }
  const count = (kind: string) =>
    paths.filter((path) =>
      path === `${root}/${kind}` || path.startsWith(`${root}/${kind}/`)
    ).length;
  return {
    nativeHandles: count("native"),
    scratchHandles: count("scratch"),
    archiveHandles: count("archive"),
  };
}

/** Fails shutdown verification while a private data handle remains open. */
export async function assertProfileDataHandlesClosed(directory: string) {
  const handles = await profileDataHandles(directory);
  if (Object.values(handles).some((count) => count !== 0)) {
    throw new Error("Benchmark process retained private data handles");
  }
  return handles;
}
