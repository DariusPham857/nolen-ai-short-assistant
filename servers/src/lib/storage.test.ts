import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StorageAdapter } from "./storage.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("StorageAdapter.checkWritable (CS-AT-01)", () => {
  it("writes, syncs, and cleans up temp probe inside a writable storage root", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "nolen-storage-ok-"));
    tempRoots.push(root);
    const adapter = new StorageAdapter(root);

    await expect(adapter.checkWritable()).resolves.toBeUndefined();
    expect(readdirSync(path.join(root, "temp"))).toEqual([]);
  });

  it("rejects when storage root is a file or unwritable path", async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "nolen-storage-bad-"));
    tempRoots.push(parent);
    const fileAsRoot = path.join(parent, "not-a-dir");
    writeFileSync(fileAsRoot, "lock");
    const adapter = new StorageAdapter(fileAsRoot);

    await expect(adapter.checkWritable()).rejects.toThrow();
  });
});
