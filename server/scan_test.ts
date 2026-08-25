import { assertEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { scan } from "./scan.ts";

async function makeFixture(): Promise<string> {
  const root = await Deno.makeTempDir();

  // cameraA: thumb-only, video-only and complete events, plus stray filenames
  // that must not be indexed.
  await Deno.mkdir(join(root, "cameraA", "thumbs"), { recursive: true });
  await Deno.mkdir(join(root, "cameraA", "videos"), { recursive: true });
  await Deno.writeTextFile(join(root, "cameraA", "thumbs", "1000000000-1000000060.jpg"), "");
  await Deno.writeTextFile(join(root, "cameraA", "videos", "1000001000-1000001060.mp4"), "");
  await Deno.writeTextFile(join(root, "cameraA", "thumbs", "1000002000-1000002060.jpg"), "");
  await Deno.writeTextFile(join(root, "cameraA", "videos", "1000002000-1000002060.mp4"), "");
  await Deno.writeTextFile(join(root, "cameraA", "thumbs", "foo.jpg"), "");
  await Deno.writeTextFile(join(root, "cameraA", "thumbs", "123-456.jpg"), "");
  await Deno.writeTextFile(join(root, "cameraA", "thumbs", ".hidden"), "");

  // cameraB: no thumbs/ directory at all.
  await Deno.mkdir(join(root, "cameraB", "videos"), { recursive: true });
  await Deno.writeTextFile(join(root, "cameraB", "videos", "1000003000-1000003060.mp4"), "");

  // cameraC: no videos/ directory at all.
  await Deno.mkdir(join(root, "cameraC", "thumbs"), { recursive: true });
  await Deno.writeTextFile(join(root, "cameraC", "thumbs", "1000004000-1000004060.jpg"), "");

  return root;
}

Deno.test("scan: thumb-only, video-only and complete events each survive as one event", async () => {
  const root = await makeFixture();
  try {
    const index = await scan(root);
    const cameraA = index.events.filter((e) => e.camera === "cameraA");
    assertEquals(cameraA.length, 3);

    const thumbOnly = cameraA.find((e) => e.key === "1000000000-1000000060")!;
    assertEquals(thumbOnly.hasThumb, true);
    assertEquals(thumbOnly.hasVideo, false);

    const videoOnly = cameraA.find((e) => e.key === "1000001000-1000001060")!;
    assertEquals(videoOnly.hasThumb, false);
    assertEquals(videoOnly.hasVideo, true);

    const complete = cameraA.find((e) => e.key === "1000002000-1000002060")!;
    assertEquals(complete.hasThumb, true);
    assertEquals(complete.hasVideo, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scan: the -3600s correction is applied exactly once", async () => {
  const root = await makeFixture();
  try {
    const index = await scan(root);
    const event = index.events.find(
      (e) => e.camera === "cameraA" && e.key === "1000000000-1000000060",
    )!;
    assertEquals(event.start, 1000000000 - 3600);
    assertEquals(event.end, 1000000060 - 3600);
    assertEquals(event.duration, 60);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scan: a camera missing thumbs/ or videos/ still yields its events", async () => {
  const root = await makeFixture();
  try {
    const index = await scan(root);

    const cameraB = index.events.filter((e) => e.camera === "cameraB");
    assertEquals(cameraB.length, 1);
    assertEquals(cameraB[0].hasVideo, true);
    assertEquals(cameraB[0].hasThumb, false);

    const cameraC = index.events.filter((e) => e.camera === "cameraC");
    assertEquals(cameraC.length, 1);
    assertEquals(cameraC[0].hasThumb, true);
    assertEquals(cameraC[0].hasVideo, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scan: stray filenames are ignored", async () => {
  const root = await makeFixture();
  try {
    const index = await scan(root);
    const cameraA = index.cameras.find((c) => c.id === "cameraA")!;
    // foo.jpg, 123-456.jpg (not two 10-digit epochs) and .hidden must not count.
    assertEquals(cameraA.eventCount, 3);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
