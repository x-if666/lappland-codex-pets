import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { OUTPUT_DIR } from "./config.mjs";
import { installLocal } from "./install-local.mjs";
import {
  buildRuntimeSequence,
  CODEX_RUNTIME_PROFILE,
  detectInstalledCodexRuntime,
  verifyInstalledCodexRuntime,
} from "./runtime-profile.mjs";
import { runtimeVerificationIssues, validateGazeMetadata } from "./validate.mjs";
import { ensureDir, sha256File } from "./utils.mjs";

const scratch = path.resolve(OUTPUT_DIR, ".qa-packaging-test");
if (!scratch.startsWith(`${path.resolve(OUTPUT_DIR)}${path.sep}`)) {
  throw new Error(`Unsafe test scratch path: ${scratch}`);
}

async function write(filename, value) {
  await ensureDir(path.dirname(filename));
  await fs.writeFile(filename, value);
}

async function testRuntimeSequence() {
  const stateFrames = Array.from({ length: 4 }, (_, index) => `wave-${index}`);
  const idleFrames = Array.from({ length: 6 }, (_, index) => `idle-${index}`);
  const sequence = buildRuntimeSequence("waving", { stateFrames, idleFrames });
  assert.equal(sequence.length, 4 * 3 + 6);
  assert.deepEqual(
    sequence.map((item) => item.durationMs),
    [
      140, 140, 140, 280,
      140, 140, 140, 280,
      140, 140, 140, 280,
      ...CODEX_RUNTIME_PROFILE.idle.durationsMs,
    ],
  );
  assert.equal(sequence.at(-1).phase, "idle-tail");

  const mismatch = runtimeVerificationIssues({
    available: true,
    installedVersion: "26.999.1.0",
    expectedVersion: CODEX_RUNTIME_PROFILE.codexVersion,
    matches: false,
  });
  assert.equal(mismatch.errors.length, 1);
  assert.match(mismatch.errors[0], /Reinspect the avatar renderer/);
  const unavailable = runtimeVerificationIssues({
    available: false,
    reason: "detector unavailable",
    matches: null,
  });
  assert.equal(unavailable.errors.length, 0);
  assert.equal(unavailable.warnings.length, 1);

  const detected = detectInstalledCodexRuntime({
    platform: "win32",
    runCommand: () => ({ status: 0, stdout: "26.707.8479.0\r\n", stderr: "" }),
  });
  assert.equal(detected.available, true);
  assert.equal(detected.installedVersion, CODEX_RUNTIME_PROFILE.codexVersion);
  const verified = verifyInstalledCodexRuntime({
    platform: "win32",
    runCommand: () => ({ status: 0, stdout: "26.999.1.0\n", stderr: "" }),
  });
  assert.equal(verified.matches, false);

  const gazeMetadata = {
    schemaVersion: 1,
    neutralTimeSeconds: 0.064,
    adjustments: {
      eyeWorldOffsetX: 4,
      eyeWorldOffsetY: 3,
      faceRotationDegrees: 1.5,
      faceVerticalWorldShift: 2,
      clockwiseFromUp: true,
    },
    targetBones: {
      face: "F_Face",
      leftEye: "F_L_Eye",
      rightEye: "F_R_Eye",
      leftEar: "F_L_Ear",
      rightEar: "F_R_Ear",
    },
    geometry: { worldOriginPixel: { x: 100, y: 200 } },
    rows: { 9: Array(8).fill("row-09/frame.png"), 10: Array(8).fill("row-10/frame.png") },
    frames: Array.from({ length: 16 }, (_, index) => ({
      index,
      row: 9 + Math.floor(index / 8),
      column: index % 8,
      degrees: index * 22.5,
    })),
  };
  assert.equal(validateGazeMetadata(gazeMetadata, "fixture.json").errors.length, 0);
  gazeMetadata.frames[3].degrees = 999;
  assert.equal(validateGazeMetadata(gazeMetadata, "fixture.json").errors.length, 1);
}

async function testVerifiedInstallAndBackup() {
  const outputDir = path.join(scratch, "output");
  const codexHome = path.join(scratch, "codex-home");
  const pet = { id: "fixture-pet", displayName: "Fixture Pet" };
  const source = path.join(outputDir, pet.id, "final");
  const destination = path.join(codexHome, "pets", pet.id);
  await write(path.join(source, "pet.json"), `${JSON.stringify({
    id: pet.id,
    displayName: pet.displayName,
    spriteVersionNumber: 2,
    spritesheetPath: "spritesheet.webp",
  }, null, 2)}\n`);
  await write(path.join(source, "spritesheet.webp"), Buffer.from("new-spritesheet"));
  await write(path.join(destination, "pet.json"), "old metadata\n");
  await write(path.join(destination, "spritesheet.webp"), Buffer.from("old-spritesheet"));
  await write(path.join(destination, "keep.txt"), "old extra file\n");

  const now = new Date("2026-07-14T01:02:03.456Z");
  const [installed] = await installLocal({ codexHome, now, outputDir, pets: [pet] });
  assert.equal(installed, destination);
  assert.equal(
    await sha256File(path.join(destination, "spritesheet.webp")),
    await sha256File(path.join(source, "spritesheet.webp")),
  );

  const timestamp = "20260714T010203456Z";
  const backup = path.join(outputDir, "backups", timestamp, pet.id);
  assert.equal(await fs.readFile(path.join(backup, "pet.json"), "utf8"), "old metadata\n");
  assert.equal(await fs.readFile(path.join(backup, "keep.txt"), "utf8"), "old extra file\n");
  const manifest = JSON.parse(await fs.readFile(
    path.join(outputDir, "backups", timestamp, "install-manifest.json"),
    "utf8",
  ));
  assert.equal(manifest.records[0].backup.directory, backup);
  assert.equal(manifest.spriteVersionNumber, 2);
}

try {
  await fs.rm(scratch, { recursive: true, force: true });
  await testRuntimeSequence();
  await testVerifiedInstallAndBackup();
  console.log("QA/packaging smoke tests passed.");
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
