import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileReplayStore, InMemoryReplayStore } from "../src/infra/replay-store.js";

const artifact = {
  playlist: "#EXTM3U\n#EXTINF:1,\nreplay/segment-00000.ts\n#EXT-X-ENDLIST\n",
  files: [{
    path: "segment-00000.ts",
    contentType: "video/mp2t",
    body: Buffer.from([1, 2, 3]),
  }],
};

test("file replay store writes media before advertising its playlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "polybot-replays-"));
  try {
    const store = new FileReplayStore(root);
    await store.put("race-1", "racer-1", artifact);
    assert.equal(await store.playlist("race-1", "racer-1"), artifact.playlist);
    assert.deepEqual(
      await readFile(join(root, "race-1", "racer-1", "segment-00000.ts")),
      artifact.files[0].body,
    );
    assert.deepEqual(
      await store.file("race-1", "racer-1", "segment-00000.ts"),
      artifact.files[0],
    );
    await store.removeRace("race-1");
    assert.equal(await store.playlist("race-1", "racer-1"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("in-memory replay store returns copies of media bytes", async () => {
  const store = new InMemoryReplayStore();
  await store.put("race-1", "racer-1", artifact);
  const file = await store.file("race-1", "racer-1", "segment-00000.ts");
  assert.ok(file);
  file.body[0] = 99;
  assert.equal((await store.file("race-1", "racer-1", "segment-00000.ts"))?.body[0], 1);
});
