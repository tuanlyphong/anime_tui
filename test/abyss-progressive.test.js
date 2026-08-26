import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-java.js", import.meta.url),
);

test("T1 fake Java fixture implements downloader command shape", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "anime-fixture-"));
  const java = path.join(directory, "java");
  const output = path.join(directory, "episode.mp4");
  await chmod(fixture, 0o755);
  await symlink(fixture, java);

  const { spawn } = await import("node:child_process");
  const child = spawn(java, ["-jar", "fixture.jar", "episode-id", "h", "-o", output]);
  const code = await new Promise((resolve) => child.once("close", resolve));

  assert.equal(code, 0);
  assert.equal((await readFile(output)).length, 2 * 1024 * 1024 + 4);
});
