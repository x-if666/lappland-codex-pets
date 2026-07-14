import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OUTPUT_DIR, PETS } from "./config.mjs";
import { CODEX_RUNTIME_PROFILE } from "./runtime-profile.mjs";
import { ensureDir, isDirectRun, sha256File, writeJson } from "./utils.mjs";

function safeTimestamp(date) {
  return date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
}

async function pathType(filename) {
  try {
    return await fs.lstat(filename);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function fileManifest(directory, parent = directory, manifest = {}) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    const relative = path.relative(parent, filename).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to back up symbolic link in pet directory: ${filename}`);
    }
    if (entry.isDirectory()) {
      await fileManifest(filename, parent, manifest);
    } else if (entry.isFile()) {
      manifest[relative] = await sha256File(filename);
    } else {
      throw new Error(`Unsupported entry in pet directory: ${filename}`);
    }
  }
  return manifest;
}

function assertSameManifest(source, copy, label) {
  const sourceNames = Object.keys(source).sort();
  const copyNames = Object.keys(copy).sort();
  if (sourceNames.join("\n") !== copyNames.join("\n")) {
    throw new Error(`${label} file list verification failed.`);
  }
  for (const filename of sourceNames) {
    if (source[filename] !== copy[filename]) {
      throw new Error(`${label} SHA-256 verification failed: ${filename}`);
    }
  }
}

async function backupExisting(destination, backup) {
  const stat = await pathType(destination);
  if (!stat) return null;
  if (!stat.isDirectory()) throw new Error(`Pet install destination is not a directory: ${destination}`);
  const before = await fileManifest(destination);
  await ensureDir(path.dirname(backup));
  await fs.cp(destination, backup, { recursive: true, errorOnExist: true, force: false });
  const after = await fileManifest(backup);
  assertSameManifest(before, after, "Backup");
  return { directory: backup, files: after };
}

function safeSpritesheetPath(value, petId) {
  if (typeof value !== "string" || value !== path.basename(value) || value.includes("..")) {
    throw new Error(`${petId} pet.json contains an unsafe spritesheetPath.`);
  }
  return value;
}

async function copyVerified(source, destination) {
  const sourceHash = await sha256File(source);
  await fs.copyFile(source, destination);
  const destinationHash = await sha256File(destination);
  if (sourceHash !== destinationHash) {
    throw new Error(`Install SHA-256 verification failed: ${destination}`);
  }
  return sourceHash;
}

export async function installLocal({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  now = new Date(),
  outputDir = OUTPUT_DIR,
  pets = PETS,
} = {}) {
  const installDate = typeof now === "function" ? now() : now;
  if (!(installDate instanceof Date) || Number.isNaN(installDate.getTime())) {
    throw new Error("installLocal now must be a valid Date or a function returning one.");
  }
  const timestamp = safeTimestamp(installDate);
  const backupRoot = path.join(outputDir, "backups", timestamp);
  const installed = [];
  const records = [];

  for (const pet of pets) {
    const source = path.join(outputDir, pet.id, "final");
    const destination = path.join(codexHome, "pets", pet.id);
    const petJsonSource = path.join(source, "pet.json");
    const petJson = JSON.parse(await fs.readFile(petJsonSource, "utf8"));
    if (petJson.spriteVersionNumber !== CODEX_RUNTIME_PROFILE.spriteVersionNumber) {
      throw new Error(
        `${pet.id} is not a sprite-v${CODEX_RUNTIME_PROFILE.spriteVersionNumber} package; `
        + "run npm run all before installing.",
      );
    }
    const spritesheetName = safeSpritesheetPath(petJson.spritesheetPath, pet.id);
    const sourceFiles = ["pet.json", spritesheetName];
    for (const filename of sourceFiles) await fs.access(path.join(source, filename));

    const backup = await backupExisting(destination, path.join(backupRoot, pet.id));
    await ensureDir(destination);
    const hashes = {};
    for (const filename of sourceFiles) {
      hashes[filename] = await copyVerified(
        path.join(source, filename),
        path.join(destination, filename),
      );
    }

    records.push({
      petId: pet.id,
      source,
      destination,
      backup,
      installedFilesSha256: hashes,
    });
    installed.push(destination);
    console.log(
      `Installed ${pet.displayName} -> ${destination}`
      + (backup ? ` (backup: ${backup.directory})` : ""),
    );
  }

  await writeJson(path.join(backupRoot, "install-manifest.json"), {
    installedAt: installDate.toISOString(),
    spriteVersionNumber: CODEX_RUNTIME_PROFILE.spriteVersionNumber,
    records,
  });
  return installed;
}

if (isDirectRun(import.meta.url)) await installLocal();
