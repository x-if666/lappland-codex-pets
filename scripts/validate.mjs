import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import * as config from "./config.mjs";
import { generatePetQaPreviews } from "./qa-previews.mjs";
import {
  CODEX_RUNTIME_PROFILE,
  serializableRuntimeProfile,
  verifyInstalledCodexRuntime,
} from "./runtime-profile.mjs";
import { ensureDir, isDirectRun, run, writeJson } from "./utils.mjs";

const { CACHE_DIR, OUTPUT_DIR, PETS, ROOT, STATES } = config;
const V2_ATLAS = CODEX_RUNTIME_PROFILE.atlas;
const V1_ROWS = 9;
const EDGE_PADDING = 2;
const STRICT_LOOP_RATIO = Object.freeze({ minimum: 0.75, maximum: 1.35 });
const GROSS_OUTLIER_RATIO = 4;
const STRICT_LOOP_STATES = new Set([
  "idle",
  "running-right",
  "running-left",
  "failed",
  "waiting",
  "review",
]);
const GAZE_ROWS = Object.freeze([
  { id: "look-directions-0-7", row: 9, count: 8, directionStart: 0 },
  { id: "look-directions-8-15", row: 10, count: 8, directionStart: 8 },
]);

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function cellStats(raw, left, top) {
  let nonzeroAlpha = 0;
  let transparentRgb = 0;
  let minX = V2_ATLAS.cellWidth;
  let minY = V2_ATLAS.cellHeight;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < V2_ATLAS.cellHeight; y += 1) {
    for (let x = 0; x < V2_ATLAS.cellWidth; x += 1) {
      const offset = ((top + y) * V2_ATLAS.width + left + x) * 4;
      const alpha = raw[offset + 3];
      if (alpha > 0) {
        nonzeroAlpha += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      } else if (raw[offset] || raw[offset + 1] || raw[offset + 2]) {
        transparentRgb += 1;
      }
    }
  }
  return {
    nonzeroAlpha,
    transparentRgb,
    bounds: nonzeroAlpha
      ? { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 }
      : null,
  };
}

function extractCell(raw, row, column) {
  const output = Buffer.alloc(V2_ATLAS.cellWidth * V2_ATLAS.cellHeight * 4);
  const sourceLeft = column * V2_ATLAS.cellWidth;
  const sourceTop = row * V2_ATLAS.cellHeight;
  const rowBytes = V2_ATLAS.cellWidth * 4;
  for (let y = 0; y < V2_ATLAS.cellHeight; y += 1) {
    const sourceOffset = ((sourceTop + y) * V2_ATLAS.width + sourceLeft) * 4;
    raw.copy(output, y * rowBytes, sourceOffset, sourceOffset + rowBytes);
  }
  return output;
}

function premultipliedMotionDelta(first, second) {
  let difference = 0;
  for (let offset = 0; offset < first.length; offset += 4) {
    const firstAlpha = first[offset + 3];
    const secondAlpha = second[offset + 3];
    difference += Math.abs(firstAlpha - secondAlpha);
    difference += Math.abs((first[offset] * firstAlpha - second[offset] * secondAlpha) / 255);
    difference += Math.abs((first[offset + 1] * firstAlpha - second[offset + 1] * secondAlpha) / 255);
    difference += Math.abs((first[offset + 2] * firstAlpha - second[offset + 2] * secondAlpha) / 255);
  }
  return difference / (first.length * 255);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function loopMotionMetrics(state, frames) {
  const adjacentDeltas = [];
  for (let index = 0; index < frames.length - 1; index += 1) {
    adjacentDeltas.push(premultipliedMotionDelta(frames[index], frames[index + 1]));
  }
  const closingDelta = premultipliedMotionDelta(frames.at(-1), frames[0]);
  const medianAdjacentDelta = median(adjacentDeltas);
  const closingToMedianRatio = medianAdjacentDelta > 0
    ? closingDelta / medianAdjacentDelta
    : (closingDelta === 0 ? 1 : Infinity);
  const largestTransitionDelta = Math.max(closingDelta, ...adjacentDeltas);
  const largestToMedianRatio = medianAdjacentDelta > 0
    ? largestTransitionDelta / medianAdjacentDelta
    : (largestTransitionDelta === 0 ? 1 : Infinity);
  const policy = STRICT_LOOP_STATES.has(state.id) ? "strict-loop" : "gross-outlier";
  return {
    policy,
    adjacentDeltas,
    closingDelta,
    medianAdjacentDelta,
    closingToMedianRatio,
    largestTransitionDelta,
    largestToMedianRatio,
    thresholds: policy === "strict-loop"
      ? STRICT_LOOP_RATIO
      : { maximum: GROSS_OUTLIER_RATIO },
  };
}

export function runtimeVerificationIssues(verification) {
  if (!verification.available) {
    return {
      errors: [],
      warnings: [
        `Could not detect the installed Codex version; runtime baseline was not checked: `
        + verification.reason,
      ],
    };
  }
  if (!verification.matches) {
    return {
      errors: [
        `Installed Codex ${verification.installedVersion} differs from the inspected runtime baseline `
        + `${verification.expectedVersion}. Reinspect the avatar renderer timing, sprite-v2 rows, `
        + `look-direction mapping, CSS size, and device-pixel ratio before validating this package.`,
      ],
      warnings: [],
    };
  }
  return { errors: [], warnings: [] };
}

function mirroredMismatchPixels(right, left) {
  let mismatches = 0;
  for (let y = 0; y < V2_ATLAS.cellHeight; y += 1) {
    for (let x = 0; x < V2_ATLAS.cellWidth; x += 1) {
      const leftOffset = (y * V2_ATLAS.cellWidth + x) * 4;
      const rightOffset = (y * V2_ATLAS.cellWidth + (V2_ATLAS.cellWidth - x - 1)) * 4;
      if (
        left[leftOffset] !== right[rightOffset]
        || left[leftOffset + 1] !== right[rightOffset + 1]
        || left[leftOffset + 2] !== right[rightOffset + 2]
        || left[leftOffset + 3] !== right[rightOffset + 3]
      ) mismatches += 1;
    }
  }
  return mismatches;
}

function expectedAnchorTarget(state) {
  return state.posture === "sleep" ? { x: 96, y: 192 } : { x: 96, y: 202 };
}

function validatePlacement(state, placement, index, errors) {
  const stateId = state.id;
  for (const key of ["left", "top", "width", "height", "anchorX", "anchorY"]) {
    if (placement[key] != null && !finiteNumber(placement[key])) {
      errors.push(`Anchor metadata ${stateId} frame ${index + 1} has non-numeric ${key}.`);
    }
  }
  if (
    ["left", "top", "width", "height"].every((key) => finiteNumber(placement[key]))
    && (
      placement.left < 0
      || placement.top < 0
      || placement.width <= 0
      || placement.height <= 0
      || placement.left + placement.width > V2_ATLAS.cellWidth
      || placement.top + placement.height > V2_ATLAS.cellHeight
    )
  ) errors.push(`Anchor metadata ${stateId} frame ${index + 1} falls outside its cell.`);
  const target = expectedAnchorTarget(state);
  const expectedAnchorX = target.x;
  const expectedAnchorY = target.y + (state.yOffsets?.[index] ?? 0);
  if (
    finiteNumber(placement.anchorX)
    && finiteNumber(placement.anchorY)
    && (
      Math.abs(placement.anchorX - expectedAnchorX) > 0.5
      || Math.abs(placement.anchorY - expectedAnchorY) > 0.5
    )
  ) {
    errors.push(
      `Anchor metadata ${stateId} frame ${index + 1} places the anchor at `
      + `(${placement.anchorX},${placement.anchorY}); expected `
      + `(${expectedAnchorX},${expectedAnchorY}).`,
    );
  }
}

function validateAnchorMetadata(manifest) {
  const errors = [];
  const warnings = [];
  const anchors = manifest?.anchors ?? manifest?.stateAnchors ?? manifest?.anchorPlacement;
  const topLevelPlacements = manifest?.placements ?? manifest?.framePlacements;
  if (!anchors && !topLevelPlacements) {
    return {
      available: false,
      errors,
      warnings: ["Builder did not expose anchor placement metadata."],
    };
  }

  const states = {};
  for (const state of STATES) {
    const anchor = anchors?.[state.id];
    const placements = anchor?.placements
      ?? anchor?.frames
      ?? topLevelPlacements?.[state.id];
    if (anchors && anchor == null) {
      errors.push(`Anchor metadata is missing state ${state.id}.`);
      continue;
    }
    const source = anchor?.source ?? anchor?.sourceAnchor ?? anchor;
    if (anchor && (!finiteNumber(source?.x) || !finiteNumber(source?.y))) {
      errors.push(`Anchor metadata ${state.id} does not contain a finite source x/y.`);
    }
    const target = anchor?.target ?? anchor?.targetAnchor;
    if (target) {
      const expected = expectedAnchorTarget(state);
      if (!finiteNumber(target.x) || !finiteNumber(target.y)) {
        errors.push(`Anchor metadata ${state.id} has a non-numeric target.`);
      } else if (Math.abs(target.x - expected.x) > 0.5 || Math.abs(target.y - expected.y) > 0.5) {
        errors.push(
          `Anchor metadata ${state.id} targets (${target.x},${target.y}); `
          + `expected (${expected.x},${expected.y}).`,
        );
      }
    }
    if (placements) {
      if (!Array.isArray(placements) || placements.length !== state.count) {
        errors.push(`Anchor metadata ${state.id} must contain ${state.count} frame placements.`);
      } else {
        placements.forEach((placement, index) => validatePlacement(state, placement, index, errors));
      }
    }
    states[state.id] = { source, target: target ?? null, placementCount: placements?.length ?? null };
  }
  const lookDirectionPlacements = manifest?.lookDirectionPlacements;
  if (lookDirectionPlacements) {
    if (!Array.isArray(lookDirectionPlacements) || lookDirectionPlacements.length !== 16) {
      errors.push("Anchor metadata must contain 16 look-direction placements.");
    } else {
      const lookState = { id: "look-directions" };
      lookDirectionPlacements.forEach((placement, index) => {
        validatePlacement(lookState, placement, index, errors);
      });
    }
  }
  return {
    available: true,
    states,
    lookDirectionPlacementCount: lookDirectionPlacements?.length ?? null,
    errors,
    warnings,
  };
}

function validateLookDirectionConfig() {
  const configured = config.LOOK_DIRECTIONS ?? config.LOOK_ROWS;
  if (!configured) return { available: false, errors: [] };
  const directions = Array.isArray(configured)
    ? configured
    : (Array.isArray(configured.directions)
      ? configured.directions
      : (Array.isArray(configured.rows) ? configured.rows : null));
  if (!directions) return { available: true, errors: [] };
  const errors = [];
  if (
    directions.length === 2
    && directions.every((entry) => entry && finiteNumber(entry.row) && finiteNumber(entry.count))
  ) {
    directions.forEach((entry, index) => {
      const expected = GAZE_ROWS[index];
      if (entry.row !== expected.row || entry.count !== expected.count) {
        errors.push(
          `LOOK_DIRECTIONS row ${index} is row ${entry.row} with ${entry.count} frames; `
          + `expected row ${expected.row} with ${expected.count}.`,
        );
      }
    });
    return { available: true, errors };
  }
  if (directions.length !== 16) errors.push(`LOOK_DIRECTIONS defines ${directions.length} entries, expected 16.`);
  directions.forEach((direction, fallbackIndex) => {
    const index = direction?.index ?? direction?.directionIndex ?? fallbackIndex;
    const expectedRow = 9 + Math.floor(index / 8);
    const expectedColumn = index % 8;
    const expectedAngle = index * 22.5;
    if (direction?.row != null && direction.row !== expectedRow) {
      errors.push(`Look direction ${index} uses row ${direction.row}, expected ${expectedRow}.`);
    }
    if (direction?.column != null && direction.column !== expectedColumn) {
      errors.push(`Look direction ${index} uses column ${direction.column}, expected ${expectedColumn}.`);
    }
    const angle = typeof direction === "number"
      ? direction
      : (direction?.angleDegrees ?? direction?.angle);
    if (angle != null && Math.abs(angle - expectedAngle) > 0.001) {
      errors.push(`Look direction ${index} uses angle ${angle}, expected ${expectedAngle}.`);
    }
  });
  return { available: true, errors };
}

export function validateGazeMetadata(metadata, filename) {
  const errors = [];
  if (!metadata) {
    return {
      available: false,
      file: filename,
      errors: ["qa/gaze-metadata.json is missing."],
    };
  }

  const expectedAdjustments = {
    eyeWorldOffsetX: 4,
    eyeWorldOffsetY: 3,
    faceRotationDegrees: 1.5,
    faceVerticalWorldShift: 2,
    clockwiseFromUp: true,
  };
  for (const [key, expected] of Object.entries(expectedAdjustments)) {
    if (metadata.adjustments?.[key] !== expected) {
      errors.push(
        `Gaze adjustment ${key} is ${metadata.adjustments?.[key] ?? "missing"}; expected ${expected}.`,
      );
    }
  }

  const expectedBones = {
    face: "F_Face",
    leftEye: "F_L_Eye",
    rightEye: "F_R_Eye",
    leftEar: "F_L_Ear",
    rightEar: "F_R_Ear",
  };
  for (const [key, expected] of Object.entries(expectedBones)) {
    if (metadata.targetBones?.[key] !== expected) {
      errors.push(
        `Gaze target bone ${key} is ${metadata.targetBones?.[key] ?? "missing"}; expected ${expected}.`,
      );
    }
  }

  const worldOrigin = metadata.geometry?.worldOriginPixel;
  if (!finiteNumber(worldOrigin?.x) || !finiteNumber(worldOrigin?.y)) {
    errors.push("Gaze geometry worldOriginPixel must contain finite x/y values.");
  }
  if (metadata.neutralTimeSeconds !== 0.064) {
    errors.push(
      `Gaze neutralTimeSeconds is ${metadata.neutralTimeSeconds ?? "missing"}; expected 0.064.`,
    );
  }

  const frames = metadata.frames;
  if (!Array.isArray(frames) || frames.length !== 16) {
    errors.push(`Gaze metadata contains ${frames?.length ?? 0} frame entries; expected 16.`);
  } else {
    frames.forEach((frame, index) => {
      const expectedRow = 9 + Math.floor(index / 8);
      const expectedColumn = index % 8;
      const expectedDegrees = index * 22.5;
      if (
        frame.index !== index
        || frame.row !== expectedRow
        || frame.column !== expectedColumn
        || frame.degrees !== expectedDegrees
      ) {
        errors.push(
          `Gaze frame entry ${index} is index/row/column/degrees `
          + `${frame.index}/${frame.row}/${frame.column}/${frame.degrees}; expected `
          + `${index}/${expectedRow}/${expectedColumn}/${expectedDegrees}.`,
        );
      }
    });
  }

  for (const row of GAZE_ROWS) {
    const paths = metadata.rows?.[String(row.row)] ?? metadata.rows?.[row.row];
    if (!Array.isArray(paths) || paths.length !== row.count) {
      errors.push(`Gaze metadata row ${row.row} must list exactly ${row.count} frame paths.`);
    }
  }

  return {
    available: true,
    file: filename,
    schemaVersion: metadata.schemaVersion,
    neutralTimeSeconds: metadata.neutralTimeSeconds,
    adjustments: metadata.adjustments,
    targetBones: metadata.targetBones,
    geometry: {
      canvas: metadata.geometry?.canvas,
      worldOriginPixel: metadata.geometry?.worldOriginPixel,
      paddingWorldUnits: metadata.geometry?.paddingWorldUnits,
      edgeGuardPixels: metadata.geometry?.edgeGuardPixels,
    },
    frameCount: Array.isArray(frames) ? frames.length : 0,
    frameOrder: Array.isArray(frames)
      ? frames.map(({ index, row, column, degrees }) => ({ index, row, column, degrees }))
      : [],
    errors,
  };
}

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, "utf8"));
}

async function optionalJson(filename) {
  try {
    return await readJson(filename);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function findOfficialV1Validator() {
  const candidates = [
    path.join(CACHE_DIR, "skill-install", "hatch-pet", "scripts", "validate_atlas.py"),
    path.join(os.homedir(), ".codex", "skills", "hatch-pet", "scripts", "validate_atlas.py"),
    path.join(
      os.homedir(),
      ".codex",
      "vendor_imports",
      "skills",
      "skills",
      ".curated",
      "hatch-pet",
      "scripts",
      "validate_atlas.py",
    ),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error(
    "Cached official hatch-pet v1 validator was not found. "
    + `Expected ${path.relative(ROOT, candidates[0])}.`,
  );
}

async function runOfficialV1Validation(root, spritesheet, finalDir) {
  const compatibilityDirectory = path.join(root, "qa", "compat-v1");
  const compatibilityAtlas = path.join(compatibilityDirectory, "spritesheet-first-9-rows.png");
  const officialReport = path.join(finalDir, "validation-hatch-pet.json");
  await ensureDir(compatibilityDirectory);
  await sharp(spritesheet)
    .extract({
      left: 0,
      top: 0,
      width: V2_ATLAS.width,
      height: V1_ROWS * V2_ATLAS.cellHeight,
    })
    .png()
    .toFile(compatibilityAtlas);
  const validator = await findOfficialV1Validator();
  run(process.env.PYTHON || "python", [
    validator,
    compatibilityAtlas,
    "--json-out",
    officialReport,
  ]);
  const report = await readJson(officialReport);
  if (!report.ok) throw new Error("Official hatch-pet v1 compatibility validation failed.");
  return {
    validator,
    compatibilityAtlas,
    report: officialReport,
  };
}

async function existingBaseline(pet) {
  const filename = path.join(CACHE_DIR, "baselines", `${pet.id}.webp`);
  try {
    await fs.access(filename);
    const metadata = await sharp(filename).metadata();
    if (
      metadata.width !== V2_ATLAS.width
      || !metadata.height
      || metadata.height < V1_ROWS * V2_ATLAS.cellHeight
    ) return null;
    return filename;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function validateOne(pet, {
  generatePreviews = true,
  runtimeVerification = verifyInstalledCodexRuntime(),
} = {}) {
  const root = path.join(OUTPUT_DIR, pet.id);
  const finalDir = path.join(root, "final");
  const spritesheet = path.join(finalDir, "spritesheet.webp");
  const petJsonPath = path.join(finalDir, "pet.json");
  const gazeMetadataPath = path.join(root, "qa", "gaze-metadata.json");
  const errors = [];
  const warnings = [];
  const runtimeIssues = runtimeVerificationIssues(runtimeVerification);
  errors.push(...runtimeIssues.errors);
  warnings.push(...runtimeIssues.warnings);
  const [metadata, petJson, frameManifest, rawGazeMetadata] = await Promise.all([
    sharp(spritesheet).metadata(),
    readJson(petJsonPath),
    optionalJson(path.join(root, "qa", "frame-manifest.json")),
    optionalJson(gazeMetadataPath),
  ]);

  if (metadata.width !== V2_ATLAS.width || metadata.height !== V2_ATLAS.height) {
    errors.push(`Expected ${V2_ATLAS.width}x${V2_ATLAS.height}, got ${metadata.width}x${metadata.height}.`);
  }
  if (!metadata.hasAlpha) errors.push("Spritesheet does not have an alpha channel.");
  if (petJson.spriteVersionNumber !== CODEX_RUNTIME_PROFILE.spriteVersionNumber) {
    errors.push(
      `pet.json spriteVersionNumber must be ${CODEX_RUNTIME_PROFILE.spriteVersionNumber}; `
      + `got ${petJson.spriteVersionNumber ?? "missing"}.`,
    );
  }
  if (petJson.spritesheetPath !== "spritesheet.webp") {
    errors.push(`pet.json spritesheetPath must be spritesheet.webp; got ${petJson.spritesheetPath}.`);
  }

  const atlasConfig = config.ATLAS;
  for (const key of ["columns", "rows", "cellWidth", "cellHeight", "width", "height"]) {
    if (atlasConfig?.[key] !== V2_ATLAS[key]) {
      errors.push(`Build ATLAS.${key} is ${atlasConfig?.[key]}, expected ${V2_ATLAS[key]} for sprite v2.`);
    }
  }

  const { data, info } = await sharp(spritesheet)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const decodedDimensionsOk = info.width === V2_ATLAS.width
    && info.height === V2_ATLAS.height
    && info.channels === 4;
  if (!decodedDimensionsOk) errors.push("Decoded spritesheet is not RGBA at the v2 dimensions.");

  const states = {};
  const loopMotion = {};
  const gaze = {};
  const mirror = { frames: [], ok: true };
  if (decodedDimensionsOk) {
    for (const state of STATES) {
      states[state.id] = [];
      const frames = [];
      for (let column = 0; column < V2_ATLAS.columns; column += 1) {
        const stats = cellStats(
          data,
          column * V2_ATLAS.cellWidth,
          state.row * V2_ATLAS.cellHeight,
        );
        states[state.id].push(stats);
        if (column < state.count) {
          frames.push(extractCell(data, state.row, column));
          if (!stats.nonzeroAlpha) errors.push(`${state.id} frame ${column + 1} is empty.`);
          if (
            stats.bounds
            && (
              stats.bounds.minX < EDGE_PADDING
              || stats.bounds.minY < EDGE_PADDING
              || stats.bounds.maxX >= V2_ATLAS.cellWidth - EDGE_PADDING
              || stats.bounds.maxY >= V2_ATLAS.cellHeight - EDGE_PADDING
            )
          ) errors.push(`${state.id} frame ${column + 1} is too close to a cell edge.`);
        } else if (stats.nonzeroAlpha) {
          errors.push(`${state.id} unused frame ${column + 1} is not transparent.`);
        }
        if (stats.transparentRgb) {
          errors.push(`${state.id} frame ${column + 1} retains RGB in fully transparent pixels.`);
        }
      }
      const motion = loopMotionMetrics(state, frames);
      loopMotion[state.id] = motion;
      if (
        motion.policy === "strict-loop"
        && (
          motion.closingToMedianRatio < STRICT_LOOP_RATIO.minimum
          || motion.closingToMedianRatio > STRICT_LOOP_RATIO.maximum
        )
      ) {
        errors.push(
          `${state.id} loop seam ratio ${motion.closingToMedianRatio.toFixed(3)} is outside `
          + `${STRICT_LOOP_RATIO.minimum}-${STRICT_LOOP_RATIO.maximum}.`,
        );
      } else if (
        motion.policy === "gross-outlier"
        && motion.largestToMedianRatio > GROSS_OUTLIER_RATIO
      ) {
        errors.push(
          `${state.id} has a gross motion outlier ratio of ${motion.largestToMedianRatio.toFixed(3)} `
          + `(maximum ${GROSS_OUTLIER_RATIO}).`,
        );
      }
    }

    for (const row of GAZE_ROWS) {
      gaze[row.id] = [];
      for (let column = 0; column < V2_ATLAS.columns; column += 1) {
        const directionIndex = row.directionStart + column;
        const stats = cellStats(
          data,
          column * V2_ATLAS.cellWidth,
          row.row * V2_ATLAS.cellHeight,
        );
        const result = {
          ...stats,
          directionIndex,
          angleDegrees: directionIndex * CODEX_RUNTIME_PROFILE.gaze.angleStepDegrees,
        };
        gaze[row.id].push(result);
        if (!stats.nonzeroAlpha) errors.push(`look direction ${directionIndex} is empty.`);
        if (stats.transparentRgb) {
          errors.push(`look direction ${directionIndex} retains RGB in fully transparent pixels.`);
        }
        if (
          stats.bounds
          && (
            stats.bounds.minX < EDGE_PADDING
            || stats.bounds.minY < EDGE_PADDING
            || stats.bounds.maxX >= V2_ATLAS.cellWidth - EDGE_PADDING
            || stats.bounds.maxY >= V2_ATLAS.cellHeight - EDGE_PADDING
          )
        ) errors.push(`look direction ${directionIndex} is too close to a cell edge.`);
      }
    }

    for (let column = 0; column < V2_ATLAS.columns; column += 1) {
      const right = extractCell(data, 1, column);
      const left = extractCell(data, 2, column);
      const mismatchPixels = mirroredMismatchPixels(right, left);
      mirror.frames.push({ frame: column + 1, mismatchPixels });
      if (mismatchPixels) {
        mirror.ok = false;
        errors.push(
          `running-left frame ${column + 1} is not an exact mirror of running-right `
          + `(${mismatchPixels} mismatched pixels).`,
        );
      }
    }
  }

  const anchorPlacement = validateAnchorMetadata(frameManifest);
  errors.push(...anchorPlacement.errors);
  warnings.push(...anchorPlacement.warnings);
  const lookDirectionConfig = validateLookDirectionConfig();
  errors.push(...lookDirectionConfig.errors);
  const gazeMetadata = validateGazeMetadata(rawGazeMetadata, gazeMetadataPath);
  errors.push(...gazeMetadata.errors);

  const report = {
    ok: errors.length === 0,
    petId: pet.id,
    spritesheet,
    petJson: petJsonPath,
    metadata: {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      hasAlpha: metadata.hasAlpha,
      spriteVersionNumber: petJson.spriteVersionNumber,
    },
    runtimeProfile: serializableRuntimeProfile(),
    runtimeVerification,
    expectedFrameCounts: Object.fromEntries(STATES.map((state) => [state.id, state.count])),
    states,
    gaze,
    mirror,
    loopMotion,
    anchorPlacement,
    lookDirectionConfig,
    gazeMetadata,
    errors,
    warnings,
  };
  await writeJson(path.join(finalDir, "validation-local.json"), report);
  if (errors.length) throw new Error(`${pet.id} local validation failed:\n- ${errors.join("\n- ")}`);

  report.officialV1 = await runOfficialV1Validation(root, spritesheet, finalDir);
  const baselineSpritesheet = await existingBaseline(pet);
  if (generatePreviews) {
    report.runtimePreviews = await generatePetQaPreviews(pet, { baselineSpritesheet });
  }
  report.baselineSpritesheet = baselineSpritesheet;
  await writeJson(path.join(finalDir, "validation-local.json"), report);
  return report;
}

export async function validateAll({ generatePreviews = true } = {}) {
  const reports = [];
  const runtimeVerification = verifyInstalledCodexRuntime();
  for (const pet of PETS) {
    reports.push(await validateOne(pet, { generatePreviews, runtimeVerification }));
  }
  console.log(`Validated ${reports.length} Codex sprite-v2 pet atlases.`);
  return reports;
}

if (isDirectRun(import.meta.url)) {
  await validateAll({ generatePreviews: !process.argv.includes("--skip-previews") });
}
