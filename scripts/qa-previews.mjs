import fs from "node:fs/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
import { CACHE_DIR, OUTPUT_DIR, PETS, STATES } from "./config.mjs";
import { buildRuntimeSequence, CODEX_RUNTIME_PROFILE } from "./runtime-profile.mjs";
import { ensureDir, isDirectRun, run, writeJson } from "./utils.mjs";

function ffmpegPathValue(value) {
  if (!value) throw new Error("ffmpeg-static did not provide an executable path.");
  return value;
}

function concatEscape(filename) {
  return filename.replaceAll("'", "'\\''").replaceAll("\\", "/");
}

async function materializeFrames(sequence, directory, prefix) {
  await ensureDir(directory);
  const materialized = [];
  for (let index = 0; index < sequence.length; index += 1) {
    const item = sequence[index];
    if (typeof item.frame === "string") {
      materialized.push({ ...item, filename: path.resolve(item.frame) });
      continue;
    }
    if (!Buffer.isBuffer(item.frame) && !(item.frame instanceof Uint8Array)) {
      throw new Error(`Preview frame ${index + 1} must be a path or image buffer.`);
    }
    const filename = path.join(directory, `${prefix}-${String(index + 1).padStart(3, "0")}.png`);
    await sharp(item.frame).png().toFile(filename);
    materialized.push({ ...item, filename });
  }
  return materialized;
}

async function comparisonFrames(current, previous, directory) {
  if (current.length !== previous.length) {
    throw new Error(`Old/new preview sequence length differs (${previous.length} vs ${current.length}).`);
  }
  await ensureDir(directory);
  const output = [];
  for (let index = 0; index < current.length; index += 1) {
    const currentImage = sharp(current[index].filename).ensureAlpha();
    const previousImage = sharp(previous[index].filename).ensureAlpha();
    const [currentMeta, previousMeta] = await Promise.all([
      currentImage.metadata(),
      previousImage.metadata(),
    ]);
    const width = Math.max(currentMeta.width ?? 0, previousMeta.width ?? 0);
    const height = Math.max(currentMeta.height ?? 0, previousMeta.height ?? 0);
    if (!width || !height) throw new Error("Unable to read preview frame dimensions.");
    const gap = 16;
    const labelHeight = 24;
    const label = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width * 2 + gap}" height="${labelHeight}">`
      + `<rect width="100%" height="100%" fill="#202124"/>`
      + `<text x="8" y="17" fill="white" font-family="Segoe UI,Arial" font-size="14">OLD</text>`
      + `<text x="${width + gap + 8}" y="17" fill="white" font-family="Segoe UI,Arial" font-size="14">NEW</text>`
      + `</svg>`,
    );
    const filename = path.join(directory, `compare-${String(index + 1).padStart(3, "0")}.png`);
    await sharp({
      create: {
        width: width * 2 + gap,
        height: height + labelHeight,
        channels: 4,
        background: { r: 240, g: 240, b: 240, alpha: 1 },
      },
    })
      .composite([
        { input: label, left: 0, top: 0 },
        { input: await previousImage.png().toBuffer(), left: 0, top: labelHeight },
        { input: await currentImage.png().toBuffer(), left: width + gap, top: labelHeight },
      ])
      .png()
      .toFile(filename);
    output.push({ ...current[index], filename });
  }
  return output;
}

async function renderTimedGif(sequence, output, temporaryDirectory) {
  await ensureDir(path.dirname(output));
  const concatFile = path.join(temporaryDirectory, `${path.basename(output)}.concat.txt`);
  const lines = [];
  for (const item of sequence) {
    lines.push(`file '${concatEscape(item.filename)}'`);
    // PNG's default 25 fps time base would round 110/150 ms holds to 40 ms
    // boundaries. A 100 fps input time base maps exactly to GIF centiseconds.
    lines.push("option framerate 100");
    lines.push(`duration ${(item.durationMs / 1000).toFixed(3)}`);
  }
  await fs.writeFile(concatFile, `${lines.join("\n")}\n`, "utf8");
  run(ffmpegPathValue(ffmpegPath), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFile,
    "-filter_complex",
    "split[s0][s1];[s0]palettegen=reserve_transparent=1:transparency_color=ffffff[p];[s1][p]paletteuse=alpha_threshold=128",
    "-loop",
    "0",
    "-final_delay",
    String(Math.round(sequence.at(-1).durationMs / 10)),
    output,
  ]);
}

export async function makeTrueTimingPreview({
  stateId,
  stateFrames,
  idleFrames = stateId === "idle" ? stateFrames : undefined,
  output,
  previousStateFrames,
  previousIdleFrames,
  comparisonOutput,
}) {
  if (!output) throw new Error("A true-timing preview output path is required.");
  const temporaryDirectory = `${output}.tmp`;
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
  await ensureDir(temporaryDirectory);
  try {
    const currentSequence = buildRuntimeSequence(stateId, { stateFrames, idleFrames });
    const current = await materializeFrames(currentSequence, temporaryDirectory, "new");
    await renderTimedGif(current, output, temporaryDirectory);

    let comparison = null;
    if (previousStateFrames && comparisonOutput) {
      const oldSequence = buildRuntimeSequence(stateId, {
        stateFrames: previousStateFrames,
        idleFrames: stateId === "idle" ? previousStateFrames : previousIdleFrames,
      });
      const old = await materializeFrames(oldSequence, temporaryDirectory, "old");
      const paired = await comparisonFrames(current, old, path.join(temporaryDirectory, "compare"));
      await renderTimedGif(paired, comparisonOutput, temporaryDirectory);
      comparison = comparisonOutput;
    }

    return {
      stateId,
      output,
      comparison,
      totalDurationMs: current.reduce((sum, item) => sum + item.durationMs, 0),
      frameEntries: current.length,
    };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function atlasStateFrames(spritesheet, row, count) {
  return Promise.all(Array.from({ length: count }, (_, column) => sharp(spritesheet)
    .extract({
      left: column * CODEX_RUNTIME_PROFILE.atlas.cellWidth,
      top: row * CODEX_RUNTIME_PROFILE.atlas.cellHeight,
      width: CODEX_RUNTIME_PROFILE.atlas.cellWidth,
      height: CODEX_RUNTIME_PROFILE.atlas.cellHeight,
    })
    .png()
    .toBuffer()));
}

export async function generatePetQaPreviews(pet, { baselineSpritesheet } = {}) {
  const root = path.join(OUTPUT_DIR, pet.id);
  const spritesheet = path.join(root, "final", "spritesheet.webp");
  const outputDirectory = path.join(root, "qa", "previews-runtime");
  const comparisonDirectory = path.join(root, "qa", "comparisons");
  const idleState = STATES.find((state) => state.id === "idle");
  if (!idleState) throw new Error("The build config does not define the idle state.");
  const idleFrames = await atlasStateFrames(spritesheet, idleState.row, idleState.count);
  const previousIdleFrames = baselineSpritesheet
    ? await atlasStateFrames(baselineSpritesheet, idleState.row, idleState.count)
    : undefined;
  const previews = [];

  for (const state of STATES) {
    const stateFrames = state.id === "idle"
      ? idleFrames
      : await atlasStateFrames(spritesheet, state.row, state.count);
    const previousStateFrames = baselineSpritesheet
      ? (state.id === "idle"
        ? previousIdleFrames
        : await atlasStateFrames(baselineSpritesheet, state.row, state.count))
      : undefined;
    previews.push(await makeTrueTimingPreview({
      stateId: state.id,
      stateFrames,
      idleFrames,
      output: path.join(outputDirectory, `${state.id}.gif`),
      previousStateFrames,
      previousIdleFrames,
      comparisonOutput: baselineSpritesheet
        ? path.join(comparisonDirectory, `${state.id}.gif`)
        : undefined,
    }));
  }
  await writeJson(path.join(root, "qa", "runtime-preview-manifest.json"), {
    runtimeProfile: CODEX_RUNTIME_PROFILE.codexVersion,
    baselineSpritesheet: baselineSpritesheet ?? null,
    previews,
  });
  return previews;
}

export async function generateAllQaPreviews() {
  const results = [];
  for (const pet of PETS) {
    const baseline = path.join(CACHE_DIR, "baselines", `${pet.id}.webp`);
    let baselineSpritesheet;
    try {
      await fs.access(baseline);
      baselineSpritesheet = baseline;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    results.push(await generatePetQaPreviews(pet, { baselineSpritesheet }));
  }
  return results;
}

if (isDirectRun(import.meta.url)) await generateAllQaPreviews();
