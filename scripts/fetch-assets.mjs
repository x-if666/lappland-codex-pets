import fs from "node:fs/promises";
import path from "node:path";
import {
  ASSET_DIR,
  LOCK_FILE,
  PETS,
  assetFiles,
  githubRawUrl,
} from "./config.mjs";
import { ensureDir, isDirectRun, sha256File, writeJson } from "./utils.mjs";

async function readLock() {
  try {
    return JSON.parse(await fs.readFile(LOCK_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function download(url, destination) {
  const response = await fetch(url, {
    headers: { "user-agent": "lappland-codex-pets/1.0" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const temporary = `${destination}.part`;
  await fs.writeFile(temporary, Buffer.from(await response.arrayBuffer()));
  await fs.rename(temporary, destination);
}

export async function fetchAssets({ updateLock = false } = {}) {
  const existingLock = await readLock();
  if (!existingLock && !updateLock) {
    throw new Error("sources.lock.json is missing. Run npm run fetch:update-lock once.");
  }

  const nextLock = {
    schemaVersion: 1,
    source: {
      repository: "https://github.com/isHarryh/Ark-Models",
      branch: "main",
      usage: "personal-local-noncommercial",
    },
    assets: {},
  };

  for (const pet of PETS) {
    const destinationDir = path.join(ASSET_DIR, pet.key);
    await ensureDir(destinationDir);
    nextLock.assets[pet.key] = {
      repoPath: pet.repoPath,
      assetBase: pet.assetBase,
      files: {},
    };

    for (const filename of assetFiles(pet)) {
      const destination = path.join(destinationDir, filename);
      const url = githubRawUrl(pet, filename);
      const expected = existingLock?.assets?.[pet.key]?.files?.[filename]?.sha256;
      let current = null;
      try {
        current = await sha256File(destination);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }

      if (!current || (!updateLock && expected && current !== expected)) {
        console.log(`Downloading ${pet.key}/${filename}`);
        await download(url, destination);
        current = await sha256File(destination);
      }

      if (!updateLock && current !== expected) {
        throw new Error(
          `Source hash mismatch for ${pet.key}/${filename}. Expected ${expected}, got ${current}. ` +
            "Review the upstream change before running fetch:update-lock.",
        );
      }

      nextLock.assets[pet.key].files[filename] = { url, sha256: current };
    }
  }

  if (updateLock) {
    await writeJson(LOCK_FILE, nextLock);
    console.log(`Updated ${LOCK_FILE}`);
  }
  return nextLock;
}

if (isDirectRun(import.meta.url)) {
  await fetchAssets({ updateLock: process.argv.includes("--update-lock") });
}
