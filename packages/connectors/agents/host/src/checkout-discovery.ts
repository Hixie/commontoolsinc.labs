import { isAbsolute, join, resolve } from "@std/path";

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const info = await Deno.lstat(path);
    return info.isFile && !info.isSymlink;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function hasGitMarker(path: string): Promise<boolean> {
  const marker = join(path, ".git");
  try {
    const info = await Deno.lstat(marker);
    if (info.isSymlink) return false;
    if (info.isDirectory) return await isRegularFile(join(marker, "HEAD"));
    if (!info.isFile) return false;

    using file = await Deno.open(marker, { read: true });
    const buffer = new Uint8Array(4097);
    let count = 0;
    while (count < buffer.length) {
      const read = await file.read(buffer.subarray(count));
      if (read === null) break;
      count += read;
    }
    if (count === 0 || count === buffer.length) return false;
    const match = new TextDecoder().decode(buffer.subarray(0, count)).match(
      /^gitdir:\s*(.+?)\s*$/,
    );
    if (!match) return false;
    const gitDirectory = isAbsolute(match[1])
      ? resolve(match[1])
      : resolve(path, match[1]);
    const gitDirectoryInfo = await Deno.lstat(gitDirectory);
    return gitDirectoryInfo.isDirectory && !gitDirectoryInfo.isSymlink &&
      await isRegularFile(join(gitDirectory, "HEAD"));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export type ValidateGitCheckout = (
  directory: string,
  signal?: AbortSignal,
) => Promise<boolean>;

/** Find every Git checkout below explicitly configured search roots. */
export async function* streamGitCheckoutDirectories(
  roots: string[],
  signal: AbortSignal | undefined,
  validateCheckout: ValidateGitCheckout,
): AsyncGenerator<string> {
  async function* visit(directory: string): AsyncGenerator<string> {
    signal?.throwIfAborted();
    if (
      await hasGitMarker(directory) &&
      await validateCheckout(directory, signal)
    ) {
      yield directory;
      return;
    }
    for await (const entry of Deno.readDir(directory)) {
      if (
        entry.name === ".git" || !entry.isDirectory || entry.isSymlink
      ) continue;
      yield* visit(join(directory, entry.name));
    }
  }
  for (const configured of roots) {
    const root = resolve(configured);
    const info = await Deno.lstat(root);
    if (info.isSymlink || !info.isDirectory) {
      throw new Error(`checkout search root is not a directory: ${root}`);
    }
    yield* visit(root);
  }
}

/** Returns a sorted checkout list for callers that need an in-memory inventory. */
export async function discoverGitCheckoutDirectories(
  roots: string[],
  signal: AbortSignal | undefined,
  validateCheckout: ValidateGitCheckout,
): Promise<string[]> {
  const checkouts = new Set<string>();
  for await (
    const directory of streamGitCheckoutDirectories(
      roots,
      signal,
      validateCheckout,
    )
  ) checkouts.add(directory);
  return [...checkouts].sort();
}
