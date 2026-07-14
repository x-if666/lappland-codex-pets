import fs from "node:fs/promises";
import path from "node:path";
import cwebpPath from "cwebp-bin";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
import {
  ASSET_DIR,
  ATLAS,
  CACHE_DIR,
  LOOK_ROWS,
  OUTPUT_DIR,
  PETS,
  RENDER_DIR,
  STATES,
} from "./config.mjs";
import { fetchAssets } from "./fetch-assets.mjs";
import {
  assertRenderedAnimationFrameCounts,
  renderAll,
} from "./render-spine.mjs";
import {
  createSpinePoseRenderer,
  renderGazeDirections,
} from "./render-gaze.mjs";
import { verifyInstalledCodexRuntime } from "./runtime-profile.mjs";
import {
  animationFrames,
  ensureDir,
  isDirectRun,
  run,
  writeJson,
} from "./utils.mjs";

const UPRIGHT_MAX = { width: 176, height: 164 };
const SLEEP_MAX = { width: 176, height: 120 };
const BODY_ANCHOR_TARGET = Object.freeze({ x: 96, y: 202 });
const SLEEP_ANCHOR_TARGET = Object.freeze({ x: 96, y: 192 });

async function sourceDimensions(filename) {
  const metadata = await sharp(filename, { animated: false }).metadata();
  if (!metadata.width || !metadata.height) throw new Error(`Invalid frame dimensions: ${filename}`);
  return { width: metadata.width, height: metadata.height };
}

async function normalizeTransparentRgb(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] === 0) {
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
    }
  }
  return sharp(data, { raw: info }).png().toBuffer();
}

function alphaBounds(data, info) {
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const alpha = data[(y * info.width + x) * info.channels + 3];
      if (!alpha) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) throw new Error("Rendered frame is fully transparent.");
  return {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    maxY,
  };
}

async function sourceBodyAnchor(filename, posture) {
  const { data, info } = await sharp(filename)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bounds = alphaBounds(data, info);
  if (posture === "sleep") {
    return {
      x: bounds.left + bounds.width / 2,
      y: bounds.maxY + 1,
    };
  }

  // Use the alpha-weighted horizontal median of the body core. It is robust to
  // ears, tails, butterflies, and outstretched hands, while the lowest visible
  // pixel provides a deterministic ground contact point.
  const coreTop = Math.round(bounds.top + bounds.height * 0.2);
  const coreBottom = Math.round(bounds.top + bounds.height * 0.82);
  const weights = new Float64Array(info.width);
  let totalWeight = 0;
  for (let y = coreTop; y <= coreBottom; y += 1) {
    for (let x = bounds.left; x < bounds.left + bounds.width; x += 1) {
      const alpha = data[(y * info.width + x) * info.channels + 3];
      weights[x] += alpha;
      totalWeight += alpha;
    }
  }
  let cumulative = 0;
  let medianX = bounds.left + bounds.width / 2;
  for (let x = bounds.left; x < bounds.left + bounds.width; x += 1) {
    cumulative += weights[x];
    if (cumulative >= totalWeight / 2) {
      medianX = x + 0.5;
      break;
    }
  }
  return { x: medianX, y: bounds.maxY + 1 };
}

async function renderCell(filename, {
  anchor,
  scale,
  mirror = false,
  yOffset = 0,
  posture,
}) {
  const metadata = await sourceDimensions(filename);
  const width = Math.max(1, Math.round(metadata.width * scale));
  const height = Math.max(1, Math.round(metadata.height * scale));
  const { data, info } = await sharp(filename)
    .ensureAlpha()
    .resize(width, height, { kernel: sharp.kernel.lanczos3 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bounds = alphaBounds(data, info);
  const sprite = await sharp(data, { raw: info })
    .extract({
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
    })
    .png()
    .toBuffer();
  const target = posture === "sleep" ? SLEEP_ANCHOR_TARGET : BODY_ANCHOR_TARGET;
  const anchorX = anchor.x * (width / metadata.width);
  const anchorY = anchor.y * (height / metadata.height);
  const left = Math.round(target.x - anchorX + bounds.left);
  const top = Math.round(target.y - anchorY + bounds.top + yOffset);
  if (
    left < 0
    || top < 0
    || left + bounds.width > ATLAS.cellWidth
    || top + bounds.height > ATLAS.cellHeight
  ) {
    throw new Error(
      `Frame does not fit anchored cell: ${filename} `
      + `(${left},${top},${bounds.width},${bounds.height})`,
    );
  }
  let cell = await sharp({
    create: {
      width: ATLAS.cellWidth,
      height: ATLAS.cellHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: sprite, left, top }])
    .png()
    .toBuffer();
  if (mirror) cell = await sharp(cell).flop().png().toBuffer();
  return {
    cell: await normalizeTransparentRgb(cell),
    placement: {
      left: mirror ? ATLAS.cellWidth - left - bounds.width : left,
      top,
      width: bounds.width,
      height: bounds.height,
      anchorX: mirror ? ATLAS.cellWidth - target.x : target.x,
      anchorY: target.y + yOffset,
    },
  };
}

async function makePreview(frameDirectory, output, fps = 6) {
  await ensureDir(path.dirname(output));
  const inputPattern = path.join(frameDirectory, "frame-%02d.png");
  run(ffmpegPath, [
    "-y",
    "-framerate",
    String(fps),
    "-i",
    inputPattern,
    "-filter_complex",
    "split[s0][s1];[s0]palettegen=reserve_transparent=1:transparency_color=ffffff[p];[s1][p]paletteuse=alpha_threshold=128",
    "-loop",
    "0",
    output,
  ]);
}

function checkerboardSvg(width, height, size = 16) {
  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs><pattern id="c" width="${size * 2}" height="${size * 2}" patternUnits="userSpaceOnUse">
        <rect width="${size * 2}" height="${size * 2}" fill="#f5f5f5"/>
        <rect width="${size}" height="${size}" fill="#d8d8d8"/>
        <rect x="${size}" y="${size}" width="${size}" height="${size}" fill="#d8d8d8"/>
      </pattern></defs><rect width="100%" height="100%" fill="url(#c)"/>
    </svg>`);
}

async function makeContactSheet(atlasPng, output) {
  const scale = 0.5;
  const spriteWidth = Math.round(ATLAS.width * scale);
  const spriteHeight = Math.round(ATLAS.height * scale);
  const labelWidth = 220;
  const resized = await sharp(atlasPng).resize(spriteWidth, spriteHeight).png().toBuffer();
  const labels = [...STATES, ...LOOK_ROWS].map((state) => {
    const y = Math.round((state.row * ATLAS.cellHeight + ATLAS.cellHeight / 2) * scale + 6);
    return `<text x="12" y="${y}" font-size="18" font-family="Segoe UI,Arial" fill="#202020">${state.row}  ${state.id}</text>`;
  }).join("");
  const labelSvg = Buffer.from(
    `<svg width="${labelWidth}" height="${spriteHeight}" xmlns="http://www.w3.org/2000/svg">${labels}</svg>`,
  );
  await sharp({
    create: {
      width: labelWidth + spriteWidth,
      height: spriteHeight,
      channels: 4,
      background: { r: 245, g: 245, b: 245, alpha: 1 },
    },
  })
    .composite([
      { input: checkerboardSvg(spriteWidth, spriteHeight), left: labelWidth, top: 0 },
      { input: resized, left: labelWidth, top: 0 },
      { input: labelSvg, left: 0, top: 0 },
    ])
    .png()
    .toFile(output);
}

async function buildOne(pet) {
  const rendered = path.join(RENDER_DIR, pet.key);
  await assertRenderedAnimationFrameCounts(pet, rendered);
  const spine = await createSpinePoseRenderer({
    assetPath: path.join(ASSET_DIR, pet.key),
  });
  const frameLists = {};
  const stateAnchors = {};
  const animationViewports = {};
  for (const state of STATES) {
    const availableFrames = await animationFrames(rendered, state.animation);
    const sourceFrames = state.sourceFrames?.[pet.key];
    if (!sourceFrames || sourceFrames.length !== state.count) {
      throw new Error(
        `${pet.id}/${state.id} must define exactly ${state.count} source frames.`,
      );
    }
    frameLists[state.id] = sourceFrames.map((sourceFrame) => {
      if (!Number.isInteger(sourceFrame) || sourceFrame < 1 || sourceFrame > availableFrames.length) {
        throw new Error(
          `${pet.id}/${state.id} source frame ${sourceFrame} is outside `
          + `${state.animation}'s 1-${availableFrames.length} range.`,
        );
      }
      return availableFrames[sourceFrame - 1];
    });
    const firstFrame = frameLists[state.id][0];
    const bodyAnchor = await sourceBodyAnchor(firstFrame, state.posture);
    const viewport = animationViewports[state.animation]
      ?? spine.getAnimationViewport(state.animation, { fps: 6 });
    animationViewports[state.animation] = viewport;
    const dimensions = await sourceDimensions(firstFrame);
    if (
      dimensions.width !== viewport.canvas.width
      || dimensions.height !== viewport.canvas.height
    ) {
      throw new Error(
        `${pet.id}/${state.animation} viewport ${viewport.canvas.width}x${viewport.canvas.height} `
        + `does not match rendered frame ${dimensions.width}x${dimensions.height}.`,
      );
    }

    // The exact Spine world origin is stable across animation canvases and is
    // therefore used for horizontal placement. Sit intentionally keeps its
    // visible ground contact for Y: its official animation moves artwork up to
    // 97 world units below the skeleton origin, which cannot fit a 208px cell
    // when the literal origin is placed at y=202. All other upright animations
    // use the exact world origin on both axes.
    if (state.posture === "sleep") {
      stateAnchors[state.id] = {
        source: bodyAnchor,
        worldOrigin: viewport.worldOriginPixel,
        target: SLEEP_ANCHOR_TARGET,
        mode: "sleep-visible-bounds",
      };
    } else if (state.animation === "Sit") {
      stateAnchors[state.id] = {
        source: { x: viewport.worldOriginPixel.x, y: bodyAnchor.y },
        worldOrigin: viewport.worldOriginPixel,
        target: BODY_ANCHOR_TARGET,
        mode: "world-x-ground-y",
      };
    } else {
      stateAnchors[state.id] = {
        source: viewport.worldOriginPixel,
        worldOrigin: viewport.worldOriginPixel,
        target: BODY_ANCHOR_TARGET,
        mode: "world-origin",
      };
    }
  }

  const uprightSources = STATES.filter((state) => state.posture !== "sleep")
    .flatMap((state) => frameLists[state.id]);
  const uprightDimensions = await Promise.all(uprightSources.map(sourceDimensions));
  const uprightWidth = Math.max(...uprightDimensions.map((item) => item.width));
  const uprightHeight = Math.max(...uprightDimensions.map((item) => item.height));
  const uprightScale = Math.min(UPRIGHT_MAX.width / uprightWidth, UPRIGHT_MAX.height / uprightHeight);

  const sleepDimensions = await Promise.all(frameLists.failed.map(sourceDimensions));
  const sleepWidth = Math.max(...sleepDimensions.map((item) => item.width));
  const sleepHeight = Math.max(...sleepDimensions.map((item) => item.height));
  const sleepScale = Math.min(
    uprightScale,
    SLEEP_MAX.width / sleepWidth,
    SLEEP_MAX.height / sleepHeight,
  );

  const gaze = await renderGazeDirections({
    assetPath: path.join(ASSET_DIR, pet.key),
    outputDir: path.join(CACHE_DIR, "gaze-rendered", pet.key),
    neutralTimeSeconds: 0.064,
  });

  const root = path.join(OUTPUT_DIR, pet.id);
  const finalDir = path.join(root, "final");
  const qaDir = path.join(root, "qa");
  const qaFrames = path.join(qaDir, "frames");
  const previousSpritesheet = path.join(finalDir, "spritesheet.webp");
  const baselineSpritesheet = path.join(CACHE_DIR, "baselines", `${pet.id}.webp`);
  try {
    await ensureDir(path.dirname(baselineSpritesheet));
    await fs.copyFile(previousSpritesheet, baselineSpritesheet);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.rm(root, { recursive: true, force: true });
  await ensureDir(finalDir);
  await ensureDir(qaFrames);

  const atlasComposites = [];
  const frameManifest = {};
  const framePlacements = {};
  for (const state of STATES) {
    const stateDir = path.join(qaFrames, state.id);
    await ensureDir(stateDir);
    frameManifest[state.id] = [];
    framePlacements[state.id] = [];
    for (let index = 0; index < state.count; index += 1) {
      const renderedCell = await renderCell(frameLists[state.id][index], {
        anchor: stateAnchors[state.id].source,
        scale: state.posture === "sleep" ? sleepScale : uprightScale,
        mirror: Boolean(state.mirror),
        yOffset: state.yOffsets?.[index] ?? 0,
        posture: state.posture,
      });
      const frameName = `frame-${String(index + 1).padStart(2, "0")}.png`;
      const framePath = path.join(stateDir, frameName);
      await fs.writeFile(framePath, renderedCell.cell);
      frameManifest[state.id].push(path.relative(root, framePath).replaceAll("\\", "/"));
      framePlacements[state.id].push(renderedCell.placement);
      atlasComposites.push({
        input: renderedCell.cell,
        left: index * ATLAS.cellWidth,
        top: state.row * ATLAS.cellHeight,
      });
    }
    await makePreview(stateDir, path.join(qaDir, "previews", `${state.id}.gif`));
  }

  const gazeFramesDirectory = path.join(qaFrames, "look-directions");
  await ensureDir(gazeFramesDirectory);
  const gazeManifest = [];
  const gazePlacements = [];
  for (const direction of gaze.metadata.frames) {
    const source = path.join(gaze.outputDir, direction.path);
    const renderedCell = await renderCell(source, {
      anchor: gaze.metadata.geometry.worldOriginPixel,
      scale: uprightScale,
    });
    const frameName = `frame-${String(direction.index + 1).padStart(2, "0")}.png`;
    const framePath = path.join(gazeFramesDirectory, frameName);
    await fs.writeFile(framePath, renderedCell.cell);
    gazeManifest.push(path.relative(root, framePath).replaceAll("\\", "/"));
    gazePlacements.push(renderedCell.placement);
    atlasComposites.push({
      input: renderedCell.cell,
      left: direction.column * ATLAS.cellWidth,
      top: direction.row * ATLAS.cellHeight,
    });
  }
  await makePreview(
    gazeFramesDirectory,
    path.join(qaDir, "previews", "look-directions.gif"),
    10,
  );

  const atlasBuffer = await sharp({
    create: {
      width: ATLAS.width,
      height: ATLAS.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(atlasComposites)
    .png()
    .toBuffer();
  const normalizedAtlas = await normalizeTransparentRgb(atlasBuffer);
  const atlasPng = path.join(finalDir, "spritesheet.png");
  await fs.writeFile(atlasPng, normalizedAtlas);
  run(cwebpPath, [
    "-quiet",
    "-lossless",
    "-exact",
    atlasPng,
    "-o",
    path.join(finalDir, "spritesheet.webp"),
  ]);

  await writeJson(path.join(finalDir, "pet.json"), {
    id: pet.id,
    displayName: pet.displayName,
    description: pet.description,
    spriteVersionNumber: 2,
    spritesheetPath: "spritesheet.webp",
  });
  await writeJson(path.join(qaDir, "frame-manifest.json"), {
    frameRate: 6,
    uprightScale,
    sleepScale,
    anchorTarget: BODY_ANCHOR_TARGET,
    stateAnchors,
    framePlacements,
    animationViewports,
    states: frameManifest,
    lookDirections: gazeManifest,
    lookDirectionPlacements: gazePlacements,
    gaze: {
      neutralTimeSeconds: gaze.metadata.neutralTimeSeconds,
      geometry: gaze.metadata.geometry,
      adjustments: gaze.metadata.adjustments,
      targetBones: gaze.metadata.targetBones,
    },
  });
  await writeJson(path.join(qaDir, "gaze-metadata.json"), gaze.metadata);
  await makeContactSheet(atlasPng, path.join(qaDir, "contact-sheet.png"));
  return root;
}

export async function buildAll({ skipRender = false } = {}) {
  const runtimeVerification = verifyInstalledCodexRuntime();
  if (runtimeVerification.available && !runtimeVerification.matches) {
    throw new Error(
      `Installed Codex ${runtimeVerification.installedVersion} differs from inspected baseline `
      + `${runtimeVerification.expectedVersion}. Reinspect the pet runtime before rebuilding.`,
    );
  }
  if (!runtimeVerification.available) {
    console.warn(
      `Warning: Codex runtime baseline could not be checked: ${runtimeVerification.reason}`,
    );
  }
  await fetchAssets();
  if (!skipRender) {
    await renderAll();
  } else {
    for (const pet of PETS) {
      await assertRenderedAnimationFrameCounts(pet, path.join(RENDER_DIR, pet.key));
    }
  }
  for (const pet of PETS) {
    console.log(`Building ${pet.displayName}...`);
    await buildOne(pet);
  }
}

if (isDirectRun(import.meta.url)) {
  await buildAll({ skipRender: process.argv.includes("--skip-render") });
}
