import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { OUTPUT_DIR, PETS } from "./config.mjs";
import { packageRelease } from "./package-release.mjs";
import { ensureDir, sha256File } from "./utils.mjs";

const VERSION = "0.0.0-test";
const scratch = path.join(OUTPUT_DIR, ".release-package-test");
const releaseDir = path.join(OUTPUT_DIR, "releases", `v${VERSION}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}).\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function expectedFiles(platform) {
  const root = `lappland-codex-pets-v${VERSION}-${platform}`;
  const installer = platform === "windows"
    ? "双击安装宠物-Windows.cmd"
    : "双击安装宠物-macOS.command";
  return [
    ...PETS.flatMap((pet) => [
      `${root}/pets/${pet.id}/pet.json`,
      `${root}/pets/${pet.id}/spritesheet.webp`,
    ]),
    `${root}/${installer}`,
    `${root}/checksums.txt`,
    `${root}/安装说明.html`,
    `${root}/THIRD_PARTY_NOTICES.txt`,
  ].sort();
}

async function assertPayloadInstalled(codexHome, extractedRoot) {
  for (const pet of PETS) {
    for (const filename of ["pet.json", "spritesheet.webp"]) {
      assert.equal(
        await sha256File(path.join(codexHome, "pets", pet.id, filename)),
        await sha256File(path.join(extractedRoot, "pets", pet.id, filename)),
        `${pet.id}/${filename} did not install byte-for-byte.`,
      );
    }
  }
}

async function testPackage() {
  await fs.rm(scratch, { recursive: true, force: true });
  await packageRelease({ version: VERSION });
  const manifest = JSON.parse(await fs.readFile(path.join(releaseDir, "release-manifest.json"), "utf8"));
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.packages.length, 2);

  for (const platform of ["windows", "macos"]) {
    const zip = path.join(releaseDir, `lappland-codex-pets-v${VERSION}-${platform}.zip`);
    const listing = run("tar", ["-tf", zip]).split(/\r?\n/).filter(Boolean).sort();
    assert.deepEqual(listing, expectedFiles(platform));
    assert.equal(listing.some((name) => /\.(?:skel|atlas|png|gif)$/i.test(name)), false);

    const extraction = path.join(scratch, platform);
    await ensureDir(extraction);
    run("tar", ["-xf", zip, "-C", extraction]);
    const root = path.join(extraction, `lappland-codex-pets-v${VERSION}-${platform}`);
    const checksums = await fs.readFile(path.join(root, "checksums.txt"), "utf8");
    for (const line of checksums.trim().split(/\r?\n/)) {
      const [expected, relative] = line.split("  ");
      assert.equal(await sha256File(path.join(root, ...relative.split("/"))), expected);
    }
  }

  const macZip = path.join(releaseDir, `lappland-codex-pets-v${VERSION}-macos.zip`);
  const verbose = run("tar", ["-tvf", macZip]);
  const commandLine = verbose.split(/\r?\n/).find((line) => line.includes("双击安装宠物-macOS.command"));
  assert.ok(commandLine, "macOS installer is missing from verbose ZIP listing.");
  assert.match(commandLine, /^-[r-][w-]x[r-]-x[r-]-x/, "macOS installer must be archived as executable.");
  const macScript = await fs.readFile(path.join(scratch, "macos", `lappland-codex-pets-v${VERSION}-macos`, "双击安装宠物-macOS.command"));
  assert.equal(macScript.includes(Buffer.from("\r\n")), false, "macOS installer must use LF line endings.");
  assert.equal(macScript.subarray(0, 9).toString(), "#!/bin/sh");

  const windowsRoot = path.join(scratch, "windows", `lappland-codex-pets-v${VERSION}-windows`);
  const codexHome = path.join(scratch, "codex home with spaces");
  for (const pet of PETS) {
    const old = path.join(codexHome, "pets", pet.id);
    await ensureDir(old);
    await fs.writeFile(path.join(old, "pet.json"), "old pet metadata\n");
    await fs.writeFile(path.join(old, "spritesheet.webp"), "old spritesheet\n");
    await fs.writeFile(path.join(old, "keep.txt"), "backup sentinel\n");
  }
  run(
    process.env.ComSpec || "cmd.exe",
    ["/d", "/c", path.join(windowsRoot, "双击安装宠物-Windows.cmd")],
    { env: { CODEX_HOME: codexHome, CODEX_PET_INSTALLER_NO_PAUSE: "1" } },
  );
  await assertPayloadInstalled(codexHome, windowsRoot);
  const backupRoot = path.join(codexHome, "pet-backups");
  const backups = await fs.readdir(backupRoot, { withFileTypes: true });
  assert.equal(backups.filter((entry) => entry.isDirectory()).length, 1);
  const backup = path.join(backupRoot, backups[0].name);
  for (const pet of PETS) {
    assert.equal(
      await fs.readFile(path.join(backup, pet.id, "keep.txt"), "utf8"),
      "backup sentinel\n",
    );
  }

  const sums = await fs.readFile(path.join(releaseDir, "SHA256SUMS.txt"), "utf8");
  for (const line of sums.trim().split(/\r?\n/)) {
    const [expected, basename] = line.split("  ");
    assert.equal(await sha256File(path.join(releaseDir, basename)), expected);
  }
  console.log("Release package and Windows installer smoke tests passed.");
}

try {
  await testPackage();
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
  await fs.rm(releaseDir, { recursive: true, force: true });
}
