import fs from "node:fs/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import {
  ASSET_DIR,
  EXPECTED_ANIMATION_FRAME_COUNTS,
  PETS,
  RENDER_DIR,
  REQUIRED_ANIMATIONS,
  ROOT,
} from "./config.mjs";
import { animationFrames, ensureDir, isDirectRun, run, writeJson } from "./utils.mjs";
import { patchSpineExporter } from "./patch-spine-exporter.mjs";

function exporterCommand() {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  return path.join(ROOT, "node_modules", ".bin", `spine-export-cli${suffix}`);
}

export async function assertRenderedAnimationFrameCounts(pet, output) {
  const expectedCounts = EXPECTED_ANIMATION_FRAME_COUNTS[pet.key];
  if (!expectedCounts) {
    throw new Error(`${pet.id} does not define locked source animation frame counts.`);
  }

  const counts = {};
  for (const animation of REQUIRED_ANIMATIONS) {
    const frames = await animationFrames(output, animation);
    const actual = frames.length;
    const expected = expectedCounts[animation];
    counts[animation] = actual;
    if (!Number.isInteger(expected)) {
      throw new Error(`${pet.id}/${animation} does not define a locked frame count.`);
    }
    if (actual !== expected) {
      throw new Error(
        `${pet.id}/${animation} source frame count changed: expected ${expected}, got ${actual}. `
        + "Refusing to build from an unverified Spine export.",
      );
    }
  }
  return counts;
}

export async function renderAll() {
  await patchSpineExporter();
  const cli = exporterCommand();
  await fs.access(cli);

  for (const pet of PETS) {
    const output = path.join(RENDER_DIR, pet.key);
    await fs.rm(output, { recursive: true, force: true });
    await ensureDir(output);
    console.log(`Rendering ${pet.displayName}...`);

    run(
      cli,
      [
        "-e",
        "sequence",
        "--pma",
        "--fps",
        "6",
        "-o",
        path.join(output, "{animationName}"),
        path.join(ASSET_DIR, pet.key),
      ],
      {
        cwd: ROOT,
        env: { FFMPEG_PATH: ffmpegPath },
        shell: process.platform === "win32",
      },
    );

    const counts = await assertRenderedAnimationFrameCounts(pet, output);
    await writeJson(path.join(output, "animations.json"), counts);
  }
}

if (isDirectRun(import.meta.url)) await renderAll();
