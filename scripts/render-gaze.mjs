import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const EXPECTED_SPINE_EXPORTER_VERSION = "0.8.0";
const TARGET_BONES = Object.freeze({
  face: "F_Face",
  leftEye: "F_L_Eye",
  rightEye: "F_R_Eye",
  leftEar: "F_L_Ear",
  rightEar: "F_R_Ear",
});

function directionLabel(degrees) {
  return Number.isInteger(degrees)
    ? String(degrees).padStart(3, "0")
    : String(degrees).replace(".", "-").padStart(5, "0");
}

export const GAZE_DIRECTIONS = Object.freeze(
  Array.from({ length: 16 }, (_, index) => {
    const degrees = index * 22.5;
    const radians = (degrees * Math.PI) / 180;
    return Object.freeze({
      index,
      degrees,
      label: directionLabel(degrees),
      row: 9 + Math.floor(index / 8),
      column: index % 8,
      unitX: Math.sin(radians),
      unitY: Math.cos(radians),
    });
  }),
);

let runtimeAdapterPromise;

async function loadRuntimeAdapter() {
  runtimeAdapterPromise ??= (async () => {
    const packagePath = require.resolve("spine-exporter/package.json");
    const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
    if (packageJson.version !== EXPECTED_SPINE_EXPORTER_VERSION) {
      throw new Error(
        `Unsupported spine-exporter version ${packageJson.version}; expected ${EXPECTED_SPINE_EXPORTER_VERSION}. ` +
          "The gaze renderer uses a guarded adapter for SpineRenderer's private SceneRenderer.",
      );
    }

    const rendererUrl = pathToFileURL(path.join(path.dirname(packagePath), "dist", "renderer.js")).href;
    const [rendererModule, coreModule, webglModule, canvasModule] = await Promise.all([
      import(rendererUrl),
      import("@node-spine-runtimes/core-3.8.99"),
      import("@node-spine-runtimes/webgl-3.8.99"),
      import("node-canvas-webgl"),
    ]);

    const { AssetPath, SpineRenderer } = rendererModule;
    const { MixBlend, MixDirection, Vector2 } = coreModule;
    const { ResizeMode } = webglModule;
    const { createCanvas } = canvasModule;
    if (
      typeof AssetPath?.fromFilepath !== "function" ||
      typeof SpineRenderer !== "function" ||
      MixBlend?.setup == null ||
      MixDirection?.mixIn == null ||
      typeof Vector2 !== "function" ||
      ResizeMode?.Expand == null ||
      typeof createCanvas !== "function"
    ) {
      throw new Error("The installed Spine 3.8 runtime does not expose the interfaces required by render-gaze.");
    }

    return {
      AssetPath,
      MixBlend,
      MixDirection,
      ResizeMode,
      SpineRenderer,
      Vector2,
      createCanvas,
      versions: {
        spineExporter: packageJson.version,
        spineRuntime: "3.8.99",
      },
    };
  })();
  return runtimeAdapterPromise;
}

async function resolveAssetBase(inputPath) {
  if (!inputPath) throw new TypeError("renderGazeDirections requires assetPath or inputDir.");
  const absolute = path.resolve(inputPath);
  const stats = await fs.stat(absolute);
  if (!stats.isDirectory()) return absolute.replace(/\.(?:atlas|json|png|skel)$/i, "");

  const entries = await fs.readdir(absolute, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && /\.(?:skel|json)$/i.test(entry.name))
    .map((entry) => path.join(absolute, entry.name.replace(/\.(?:skel|json)$/i, "")))
    .filter((base, index, all) => all.indexOf(base) === index);
  const complete = [];
  for (const base of candidates) {
    try {
      await fs.access(`${base}.atlas`);
      complete.push(base);
    } catch {
      // Ignore incomplete skeleton/atlas pairs.
    }
  }
  if (complete.length !== 1) {
    throw new Error(`Expected exactly one Spine skeleton/atlas pair in ${absolute}; found ${complete.length}.`);
  }
  return complete[0];
}

function requireBone(skeleton, name) {
  const bone = skeleton.findBone(name);
  if (bone == null) throw new Error(`Required Spine bone is missing: ${name}`);
  if (typeof bone.updateWorldTransform !== "function" || bone.parent == null) {
    throw new Error(`Spine bone ${name} is incompatible with the gaze adapter.`);
  }
  return bone;
}

function snapshotBone(bone) {
  return {
    localX: bone.x,
    localY: bone.y,
    localRotation: bone.rotation,
    worldX: bone.worldX,
    worldY: bone.worldY,
    worldRotation: bone.getWorldRotationX(),
  };
}

function localDeltaForWorldDelta(parent, worldX, worldY) {
  const determinant = parent.a * parent.d - parent.b * parent.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) {
    throw new Error(`Cannot invert parent transform for bone ${parent.data.name}.`);
  }
  return {
    x: (parent.d * worldX - parent.b * worldY) / determinant,
    y: (-parent.c * worldX + parent.a * worldY) / determinant,
  };
}

function addWorldTranslation(bone, worldX, worldY) {
  const local = localDeltaForWorldDelta(bone.parent, worldX, worldY);
  bone.x += local.x;
  bone.y += local.y;
}

function normalizedAngleDelta(value, reference) {
  let delta = (value - reference) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

function assertNear(actual, expected, label, tolerance = 1e-3) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label} was ${actual}; expected ${expected} ± ${tolerance}.`);
  }
}

function skeletonBounds(skeleton, Vector2) {
  const offset = new Vector2();
  const size = new Vector2();
  skeleton.getBounds(offset, size);
  if (![offset.x, offset.y, size.x, size.y].every(Number.isFinite) || size.x <= 0 || size.y <= 0) {
    throw new Error("The adjusted skeleton produced invalid bounds.");
  }
  return {
    minX: offset.x,
    minY: offset.y,
    maxX: offset.x + size.x,
    maxY: offset.y + size.y,
    width: size.x,
    height: size.y,
  };
}

function evenCeiling(value) {
  const rounded = Math.ceil(value);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function roundedEven(value) {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

async function normalizeTransparentRgb(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] === 0) {
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
    }
  }
  return sharp(data, { raw: info }).png({ compressionLevel: 9 }).toBuffer();
}

async function inspectPng(png, edgeGuardPixels) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  let nontransparentPixels = 0;
  let transparentRgbResiduePixels = 0;
  let guardedEdgePixels = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * 4;
      const alpha = data[offset + 3];
      if (alpha === 0) {
        if (data[offset] !== 0 || data[offset + 1] !== 0 || data[offset + 2] !== 0) {
          transparentRgbResiduePixels += 1;
        }
        continue;
      }
      nontransparentPixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (
        x < edgeGuardPixels ||
        y < edgeGuardPixels ||
        x >= info.width - edgeGuardPixels ||
        y >= info.height - edgeGuardPixels
      ) {
        guardedEdgePixels += 1;
      }
    }
  }
  if (nontransparentPixels === 0) throw new Error("A gaze frame rendered fully transparent.");
  if (transparentRgbResiduePixels !== 0) {
    throw new Error(`A gaze frame retained RGB data under ${transparentRgbResiduePixels} transparent pixels.`);
  }
  if (guardedEdgePixels !== 0) {
    throw new Error(`A gaze frame touches the ${edgeGuardPixels}px clipping guard (${guardedEdgePixels} pixels).`);
  }
  return {
    width: info.width,
    height: info.height,
    nontransparentPixels,
    transparentRgbResiduePixels,
    guardedEdgePixels,
    alphaBounds: { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
}

function assertSceneRendererAdapter(renderer) {
  const scene = renderer.renderer;
  if (
    scene == null ||
    typeof scene.resize !== "function" ||
    typeof scene.begin !== "function" ||
    typeof scene.drawSkeleton !== "function" ||
    typeof scene.end !== "function" ||
    scene.camera == null ||
    renderer.gl == null ||
    typeof renderer.canvas?.toBuffer !== "function"
  ) {
    throw new Error(
      "spine-exporter 0.8.0 no longer has the SceneRenderer shape expected by the guarded gaze adapter.",
    );
  }
  return scene;
}

/**
 * Load one Spine asset and expose the guarded low-level pose renderer used by gaze generation.
 * This is also the shared anchoring API for standard rows rendered by spine-exporter.
 */
export async function createSpinePoseRenderer(options = {}) {
  const { assetPath, inputDir, preMultipliedAlpha = true } = options;
  const runtime = await loadRuntimeAdapter();
  const assetBase = await resolveAssetBase(assetPath ?? inputDir);
  const renderer = new runtime.SpineRenderer(runtime.createCanvas(32, 32));
  const { skeleton, state } = await renderer.load(
    runtime.AssetPath.fromFilepath(assetBase),
    1,
    preMultipliedAlpha,
  );
  const scene = assertSceneRendererAdapter(renderer);

  const applyAnimationPose = (animationName, timeSeconds = 0) => {
    const animation = skeleton.data.findAnimation(animationName);
    if (animation == null) throw new Error(`Spine animation is missing: ${animationName}`);
    if (!Number.isFinite(timeSeconds) || timeSeconds < 0 || timeSeconds > animation.duration) {
      throw new Error(
        `Animation time ${timeSeconds} is outside ${animationName}'s 0-${animation.duration}s range.`,
      );
    }
    skeleton.setToSetupPose();
    animation.apply(
      skeleton,
      timeSeconds,
      timeSeconds,
      false,
      [],
      1,
      runtime.MixBlend.setup,
      runtime.MixDirection.mixIn,
    );
    skeleton.updateWorldTransform();
    return animation;
  };

  const getBounds = () => skeletonBounds(skeleton, runtime.Vector2);

  // Deliberately mirrors spine-exporter 0.8.0 calculateAnimationViewport exactly.
  // In particular, steps is not rounded and the sampled times begin at zero.
  const getAnimationViewport = (animationName, { fps = 6 } = {}) => {
    if (!Number.isFinite(fps) || fps <= 0) throw new TypeError("fps must be a positive finite number.");
    const animation = skeleton.data.findAnimation(animationName);
    if (animation == null) throw new Error(`Spine animation is missing: ${animationName}`);
    skeleton.setToSetupPose();
    const steps = animation.duration ? fps * animation.duration : 1;
    const stepTime = animation.duration ? animation.duration / steps : 0;
    let time = 0;
    let minX = 100000000;
    let maxX = -100000000;
    let minY = 100000000;
    let maxY = -100000000;
    const offset = new runtime.Vector2();
    const size = new runtime.Vector2();
    for (let index = 0; index < steps; index += 1, time += stepTime) {
      animation.apply(
        skeleton,
        time,
        time,
        false,
        [],
        1,
        runtime.MixBlend.setup,
        runtime.MixDirection.mixIn,
      );
      skeleton.updateWorldTransform();
      skeleton.getBounds(offset, size);
      if (![offset.x, offset.y, size.x, size.y].every(Number.isFinite)) {
        throw new Error(`Animation bounds are invalid: ${animationName}`);
      }
      minX = Math.min(offset.x, minX);
      maxX = Math.max(offset.x + size.x, maxX);
      minY = Math.min(offset.y, minY);
      maxY = Math.max(offset.y + size.y, maxY);
    }
    const viewport = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    const canvas = {
      width: roundedEven(viewport.width),
      height: roundedEven(viewport.height),
      centerX: viewport.x + viewport.width / 2,
      centerY: viewport.y + viewport.height / 2,
    };
    return {
      animationName,
      fps,
      durationSeconds: animation.duration,
      sampledFrameCount: Math.ceil(steps),
      viewport,
      canvas,
      worldOriginPixel: {
        x: canvas.width / 2 - canvas.centerX,
        y: canvas.height / 2 + canvas.centerY,
      },
      worldToPixel: {
        scale: 1,
        pixelX: "originX + worldX",
        pixelY: "originY - worldY",
        worldYAxis: "up",
        pixelYAxis: "down",
      },
    };
  };

  const renderCurrentPose = async ({ width, height, centerX, centerY }) => {
    for (const [label, value] of Object.entries({ width, height, centerX, centerY })) {
      if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite.`);
    }
    if (width <= 0 || height <= 0) throw new TypeError("width and height must be positive.");
    renderer.canvas.width = Math.round(width);
    renderer.canvas.height = Math.round(height);
    scene.resize(runtime.ResizeMode.Expand);
    scene.camera.position.x = centerX;
    scene.camera.position.y = centerY;
    renderer.gl.clearColor(0, 0, 0, 0);
    renderer.gl.clear(renderer.gl.COLOR_BUFFER_BIT);
    scene.begin();
    scene.drawSkeleton(skeleton, preMultipliedAlpha);
    scene.end();
    return normalizeTransparentRgb(renderer.canvas.toBuffer("image/png", { compressionLevel: 1 }));
  };

  return {
    assetBase,
    versions: runtime.versions,
    runtime,
    renderer,
    scene,
    skeleton,
    state,
    applyAnimationPose,
    getAnimationViewport,
    getBounds,
    renderCurrentPose,
  };
}

/** Convenience wrapper when only cached-sequence anchoring metadata is needed. */
export async function getAnimationViewport(assetPath, animationName, options = {}) {
  const poseRenderer = await createSpinePoseRenderer({
    assetPath,
    preMultipliedAlpha: options.preMultipliedAlpha ?? true,
  });
  return poseRenderer.getAnimationViewport(animationName, { fps: options.fps ?? 6 });
}

/**
 * Render the Codex v2 16-direction gaze rows from a Spine 3.8 skeleton.
 *
 * @param {object} options
 * @param {string} [options.assetPath] Spine basename, .skel/.json path, or directory containing one skeleton.
 * @param {string} [options.inputDir] Alias for assetPath.
 * @param {string} options.outputDir Destination containing row-09, row-10, and gaze-metadata.json.
 * @param {string} [options.animationName="Relax"] Animation used for the neutral pose.
 * @param {number} [options.neutralTimeSeconds=0.064] Time sampled from the neutral animation. The default
 * matches spine-exporter 0.8.0's first rendered frame because TimeKeeper clamps a 6 FPS delta to 64ms.
 * @param {number} [options.eyeWorldOffsetX=4] Maximum eye-bone horizontal world offset.
 * @param {number} [options.eyeWorldOffsetY=3] Maximum eye-bone vertical world offset.
 * @param {number} [options.faceRotationDegrees=1.5] Maximum face rotation.
 * @param {number} [options.faceVerticalWorldShift=2] Maximum face vertical world shift.
 * @param {number} [options.paddingWorldUnits=10] Shared transparent padding around the union of all poses.
 * @param {number} [options.edgeGuardPixels=2] Required transparent guard on every output edge.
 * @param {boolean} [options.preMultipliedAlpha=true] Texture/runtime PMA setting used by the source assets.
 */
export async function renderGazeDirections(options = {}) {
  const {
    assetPath,
    inputDir,
    outputDir,
    animationName = "Relax",
    neutralTimeSeconds = 0.064,
    eyeWorldOffsetX = 4,
    eyeWorldOffsetY = 3,
    faceRotationDegrees = 1.5,
    faceVerticalWorldShift = 2,
    paddingWorldUnits = 10,
    edgeGuardPixels = 2,
    preMultipliedAlpha = true,
  } = options;
  if (!outputDir) throw new TypeError("renderGazeDirections requires outputDir.");
  for (const [label, value] of Object.entries({
    neutralTimeSeconds,
    eyeWorldOffsetX,
    eyeWorldOffsetY,
    faceRotationDegrees,
    faceVerticalWorldShift,
    paddingWorldUnits,
    edgeGuardPixels,
  })) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a non-negative finite number.`);
  }

  const runtime = await loadRuntimeAdapter();
  const assetBase = await resolveAssetBase(assetPath ?? inputDir);
  const destination = path.resolve(outputDir);
  const renderer = new runtime.SpineRenderer(runtime.createCanvas(32, 32));
  const loaded = await renderer.load(runtime.AssetPath.fromFilepath(assetBase), 1, preMultipliedAlpha);
  const { skeleton } = loaded;
  const animation = skeleton.data.findAnimation(animationName);
  if (animation == null) throw new Error(`Spine animation is missing: ${animationName}`);
  if (neutralTimeSeconds > animation.duration) {
    throw new Error(
      `neutralTimeSeconds ${neutralTimeSeconds} exceeds ${animationName} duration ${animation.duration}.`,
    );
  }

  const bones = {
    face: requireBone(skeleton, TARGET_BONES.face),
    leftEye: requireBone(skeleton, TARGET_BONES.leftEye),
    rightEye: requireBone(skeleton, TARGET_BONES.rightEye),
    leftEar: requireBone(skeleton, TARGET_BONES.leftEar),
    rightEar: requireBone(skeleton, TARGET_BONES.rightEar),
  };
  const applyNeutral = () => {
    skeleton.setToSetupPose();
    animation.apply(
      skeleton,
      neutralTimeSeconds,
      neutralTimeSeconds,
      false,
      [],
      1,
      runtime.MixBlend.setup,
      runtime.MixDirection.mixIn,
    );
    skeleton.updateWorldTransform();
  };

  applyNeutral();
  const neutral = Object.fromEntries(Object.entries(bones).map(([key, bone]) => [key, snapshotBone(bone)]));

  const applyDirection = (direction) => {
    applyNeutral();
    const faceBefore = snapshotBone(bones.face);
    const targetFaceShiftY = faceVerticalWorldShift * direction.unitY;
    const targetFaceRotation = -faceRotationDegrees * direction.unitX;
    addWorldTranslation(bones.face, 0, targetFaceShiftY);
    bones.face.rotation += targetFaceRotation;
    skeleton.updateWorldTransform();

    const eyesBefore = {
      leftEye: snapshotBone(bones.leftEye),
      rightEye: snapshotBone(bones.rightEye),
    };
    const targetEyeX = eyeWorldOffsetX * direction.unitX;
    const targetEyeY = eyeWorldOffsetY * direction.unitY;
    addWorldTranslation(bones.leftEye, targetEyeX, targetEyeY);
    addWorldTranslation(bones.rightEye, targetEyeX, targetEyeY);
    skeleton.updateWorldTransform();

    const faceAfter = snapshotBone(bones.face);
    const leftEyeAfter = snapshotBone(bones.leftEye);
    const rightEyeAfter = snapshotBone(bones.rightEye);
    const actual = {
      faceWorldX: faceAfter.worldX - faceBefore.worldX,
      faceWorldY: faceAfter.worldY - faceBefore.worldY,
      faceWorldRotation: normalizedAngleDelta(faceAfter.worldRotation, faceBefore.worldRotation),
      leftEyeWorldX: leftEyeAfter.worldX - eyesBefore.leftEye.worldX,
      leftEyeWorldY: leftEyeAfter.worldY - eyesBefore.leftEye.worldY,
      rightEyeWorldX: rightEyeAfter.worldX - eyesBefore.rightEye.worldX,
      rightEyeWorldY: rightEyeAfter.worldY - eyesBefore.rightEye.worldY,
    };
    assertNear(actual.faceWorldX, 0, `${direction.label} face world X`);
    assertNear(actual.faceWorldY, targetFaceShiftY, `${direction.label} face world Y`);
    assertNear(actual.faceWorldRotation, targetFaceRotation, `${direction.label} face rotation`);
    assertNear(actual.leftEyeWorldX, targetEyeX, `${direction.label} left eye world X`);
    assertNear(actual.leftEyeWorldY, targetEyeY, `${direction.label} left eye world Y`);
    assertNear(actual.rightEyeWorldX, targetEyeX, `${direction.label} right eye world X`);
    assertNear(actual.rightEyeWorldY, targetEyeY, `${direction.label} right eye world Y`);

    return {
      targets: {
        eyeWorldX: targetEyeX,
        eyeWorldY: targetEyeY,
        faceWorldY: targetFaceShiftY,
        faceWorldRotation: targetFaceRotation,
      },
      actual,
      bones: {
        face: faceAfter,
        leftEye: leftEyeAfter,
        rightEye: rightEyeAfter,
        leftEar: snapshotBone(bones.leftEar),
        rightEar: snapshotBone(bones.rightEar),
      },
    };
  };

  const preflight = GAZE_DIRECTIONS.map((direction) => {
    const pose = applyDirection(direction);
    return { direction, pose, bounds: skeletonBounds(skeleton, runtime.Vector2) };
  });
  const unionBounds = preflight.reduce(
    (union, frame) => ({
      minX: Math.min(union.minX, frame.bounds.minX),
      minY: Math.min(union.minY, frame.bounds.minY),
      maxX: Math.max(union.maxX, frame.bounds.maxX),
      maxY: Math.max(union.maxY, frame.bounds.maxY),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
  const canvas = {
    width: evenCeiling(unionBounds.maxX - unionBounds.minX + paddingWorldUnits * 2),
    height: evenCeiling(unionBounds.maxY - unionBounds.minY + paddingWorldUnits * 2),
    centerX: (unionBounds.minX + unionBounds.maxX) / 2,
    centerY: (unionBounds.minY + unionBounds.maxY) / 2,
  };
  const worldOriginPixel = {
    x: canvas.width / 2 - canvas.centerX,
    y: canvas.height / 2 + canvas.centerY,
  };

  renderer.canvas.width = canvas.width;
  renderer.canvas.height = canvas.height;
  const scene = assertSceneRendererAdapter(renderer);
  await fs.mkdir(destination, { recursive: true });
  await Promise.all(
    ["row-09", "row-10"].map((row) => fs.rm(path.join(destination, row), { recursive: true, force: true })),
  );
  await fs.mkdir(path.join(destination, "row-09"), { recursive: true });
  await fs.mkdir(path.join(destination, "row-10"), { recursive: true });

  const frames = [];
  for (const item of preflight) {
    const { direction } = item;
    const pose = applyDirection(direction);
    scene.resize(runtime.ResizeMode.Expand);
    scene.camera.position.x = canvas.centerX;
    scene.camera.position.y = canvas.centerY;
    renderer.gl.clearColor(0, 0, 0, 0);
    renderer.gl.clear(renderer.gl.COLOR_BUFFER_BIT);
    scene.begin();
    scene.drawSkeleton(skeleton, preMultipliedAlpha);
    scene.end();

    const rendered = renderer.canvas.toBuffer("image/png", { compressionLevel: 1 });
    const png = await normalizeTransparentRgb(rendered);
    const rowDirectory = `row-${String(direction.row).padStart(2, "0")}`;
    const filename = `frame-${String(direction.column + 1).padStart(2, "0")}.png`;
    const relativePath = path.join(rowDirectory, filename);
    const absolutePath = path.join(destination, relativePath);
    await fs.writeFile(absolutePath, png);
    const inspection = await inspectPng(png, edgeGuardPixels);
    frames.push({
      index: direction.index,
      degrees: direction.degrees,
      label: direction.label,
      row: direction.row,
      column: direction.column,
      path: relativePath.replaceAll("\\", "/"),
      targets: pose.targets,
      actual: pose.actual,
      bounds: skeletonBounds(skeleton, runtime.Vector2),
      bones: pose.bones,
      image: inspection,
    });
  }

  const metadata = {
    schemaVersion: 1,
    assetBase,
    animationName,
    neutralTimeSeconds,
    versions: runtime.versions,
    geometry: {
      canvas,
      unionBounds,
      worldOriginPixel,
      worldToPixel: {
        scale: 1,
        pixelX: "originX + worldX",
        pixelY: "originY - worldY",
        worldYAxis: "up",
        pixelYAxis: "down",
      },
      paddingWorldUnits,
      edgeGuardPixels,
    },
    adjustments: {
      eyeWorldOffsetX,
      eyeWorldOffsetY,
      faceRotationDegrees,
      faceVerticalWorldShift,
      clockwiseFromUp: true,
    },
    targetBones: TARGET_BONES,
    neutralBones: neutral,
    rows: {
      9: frames.filter((frame) => frame.row === 9).map((frame) => frame.path),
      10: frames.filter((frame) => frame.row === 10).map((frame) => frame.path),
    },
    frames,
  };
  const metadataPath = path.join(destination, "gaze-metadata.json");
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return {
    outputDir: destination,
    metadataPath,
    rows: {
      9: metadata.rows[9].map((frame) => path.join(destination, frame)),
      10: metadata.rows[10].map((frame) => path.join(destination, frame)),
    },
    frames,
    metadata,
  };
}

function parseCliArguments(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const [flag, inline] = value.split("=", 2);
    const next = inline ?? argv[++index];
    switch (flag) {
      case "--input":
        options.assetPath = next;
        break;
      case "--output":
        options.outputDir = next;
        break;
      case "--neutral-time":
        options.neutralTimeSeconds = Number(next);
        break;
      case "--padding":
        options.paddingWorldUnits = Number(next);
        break;
      default:
        throw new Error(`Unknown render-gaze option: ${flag}`);
    }
  }
  options.assetPath ??= positional[0];
  options.outputDir ??= positional[1];
  return options;
}

function isDirectRun() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  const options = parseCliArguments(process.argv.slice(2));
  if (!options.assetPath || !options.outputDir) {
    throw new Error(
      "Usage: node scripts/render-gaze.mjs --input <spine-dir-or-base> --output <directory> " +
        "[--neutral-time 0.064] [--padding 10]",
    );
  }
  const result = await renderGazeDirections(options);
  console.log(`Rendered 16 gaze frames -> ${result.outputDir}`);
  console.log(`Metadata -> ${result.metadataPath}`);
}
