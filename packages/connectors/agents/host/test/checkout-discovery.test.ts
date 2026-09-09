import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { stub } from "@std/testing/mock";
import { discoverGitCheckoutDirectories } from "../src/checkout-discovery.ts";

describe("discoverGitCheckoutDirectories", () => {
  it("finds worktrees and does not descend into a checkout", async () => {
    const directory = await Deno.makeTempDir();
    try {
      const repository = join(directory, "repository");
      const linkedWorktree = join(directory, "nested", "linked-worktree");
      const linkedGitDirectory = join(
        directory,
        "gitdirs",
        "linked-worktree",
      );
      const stale = join(directory, "stale");
      const nestedCheckout = join(directory, "stale", "nested-checkout");
      await Deno.mkdir(join(repository, ".git"), { recursive: true });
      await Deno.writeTextFile(
        join(repository, ".git", "HEAD"),
        "ref: main",
      );
      await Deno.mkdir(linkedWorktree, { recursive: true });
      await Deno.mkdir(linkedGitDirectory, { recursive: true });
      await Deno.writeTextFile(join(linkedGitDirectory, "HEAD"), "ref: main");
      await Deno.writeTextFile(
        join(linkedWorktree, ".git"),
        "gitdir: ../../gitdirs/linked-worktree",
      );
      await Deno.mkdir(join(repository, "ignored", ".git"), {
        recursive: true,
      });
      await Deno.mkdir(join(stale, ".git"), { recursive: true });
      await Deno.writeTextFile(join(stale, ".git", "HEAD"), "invalid");
      await Deno.mkdir(join(nestedCheckout, ".git"), { recursive: true });
      await Deno.writeTextFile(
        join(nestedCheckout, ".git", "HEAD"),
        "ref: main",
      );

      expect(
        await discoverGitCheckoutDirectories(
          [directory],
          undefined,
          (candidate) => Promise.resolve(candidate !== stale),
        ),
      ).toEqual([linkedWorktree, repository, nestedCheckout]);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("rejects a search root that is not a directory", async () => {
    const directory = await Deno.makeTempDir();
    const file = join(directory, "file");
    try {
      await Deno.writeTextFile(file, "not a directory");
      await expect(
        discoverGitCheckoutDirectories(
          [file],
          undefined,
          () => Promise.resolve(true),
        ),
      ).rejects.toThrow(
        `checkout search root is not a directory: ${file}`,
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("reads a linked-worktree marker through short file reads", async () => {
    const directory = await Deno.makeTempDir();
    try {
      const checkout = join(directory, "checkout");
      const gitDirectory = join(directory, "git-directory");
      await Deno.mkdir(checkout);
      await Deno.mkdir(gitDirectory);
      await Deno.writeTextFile(join(gitDirectory, "HEAD"), "ref: main\n");
      const marker = join(checkout, ".git");
      await Deno.writeTextFile(marker, "gitdir: ../git-directory\n");
      const original = Deno.open;
      using shortReads = stub(Deno, "open", async (...args) => {
        const file = await original(...args);
        if (args[0] !== marker) return file;
        const read = file.read.bind(file);
        file.read = (buffer) => read(buffer.subarray(0, 2));
        return file;
      });
      expect(
        await discoverGitCheckoutDirectories(
          [checkout],
          undefined,
          () => Promise.resolve(true),
        ),
      ).toEqual([checkout]);
      expect(shortReads.calls.length).toBe(1);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
});
