import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const windowsInstaller = path.join(scriptsDir, "install-release-windows.cmd");
const macosInstaller = path.join(scriptsDir, "install-release-macos.command");
const petIds = [
  "lappland-decadenza",
  "lappland-decadenza-unruly-humbleness",
];

async function writeFixture(releaseRoot, petId, suffix = "new") {
  const petDir = path.join(releaseRoot, "pets", petId);
  await fs.mkdir(petDir, { recursive: true });
  await fs.writeFile(
    path.join(petDir, "pet.json"),
    `${JSON.stringify({ id: petId, spritesheetPath: "spritesheet.webp" })}\n`,
  );
  await fs.writeFile(path.join(petDir, "spritesheet.webp"), `webp-${petId}-${suffix}`);
}

async function assertInstallerContract() {
  const windowsText = await fs.readFile(windowsInstaller, "utf8");
  const macosText = await fs.readFile(macosInstaller, "utf8");
  for (const [label, text] of [["Windows", windowsText], ["macOS", macosText]]) {
    assert.match(text, /CODEX_HOME/, `${label} installer must honor CODEX_HOME`);
    assert.match(text, /pet-backups/, `${label} installer must back up prior pets`);
    assert.match(text, /lappland-decadenza-unruly-humbleness/);
    assert.match(text, /pet\.json/);
    assert.match(text, /spritesheet\.webp/);
  }
  assert.match(macosText, /^#!\/bin\/sh\r?\n/);
  assert.doesNotMatch(windowsText, /Start-Process\s+.*-Verb\s+RunAs/i);
  assert.doesNotMatch(macosText, /\bsudo\b/);
}

async function testWindowsInstaller() {
  if (process.platform !== "win32") return;

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lappland-installer-"));
  try {
    const releaseRoot = path.join(tempRoot, "发布包 with spaces");
    const codexHome = path.join(tempRoot, "用户目录 with spaces", ".codex");
    await fs.mkdir(releaseRoot, { recursive: true });
    await fs.copyFile(windowsInstaller, path.join(releaseRoot, "install.cmd"));
    for (const petId of petIds) await writeFixture(releaseRoot, petId);

    const existing = path.join(codexHome, "pets", petIds[0]);
    await fs.mkdir(existing, { recursive: true });
    await fs.writeFile(path.join(existing, "old-only.txt"), "must be backed up");
    await fs.writeFile(path.join(existing, "pet.json"), "old pet json");

    const env = {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_PET_INSTALLER_NO_PAUSE: "1",
    };
    const output = execFileSync("cmd.exe", ["/d", "/c", path.join(releaseRoot, "install.cmd")], {
      cwd: releaseRoot,
      env,
      encoding: "utf8",
    });
    assert.match(output, /Success/);

    for (const petId of petIds) {
      assert.equal(
        await fs.readFile(path.join(codexHome, "pets", petId, "spritesheet.webp"), "utf8"),
        `webp-${petId}-new`,
      );
      await fs.access(path.join(codexHome, "pets", petId, "pet.json"));
    }
    await assert.rejects(fs.access(path.join(existing, "old-only.txt")));

    const backupRoots = await fs.readdir(path.join(codexHome, "pet-backups"));
    assert.equal(backupRoots.length, 1);
    assert.equal(
      await fs.readFile(
        path.join(codexHome, "pet-backups", backupRoots[0], petIds[0], "old-only.txt"),
        "utf8",
      ),
      "must be backed up",
    );

    // Both packages are preflighted, so a broken ZIP must not alter either installed pet.
    const brokenRoot = path.join(tempRoot, "broken-release");
    const untouchedHome = path.join(tempRoot, "untouched-home");
    await fs.mkdir(brokenRoot, { recursive: true });
    await fs.copyFile(windowsInstaller, path.join(brokenRoot, "install.cmd"));
    await writeFixture(brokenRoot, petIds[0]);
    const untouchedPet = path.join(untouchedHome, "pets", petIds[0]);
    await fs.mkdir(untouchedPet, { recursive: true });
    await fs.writeFile(path.join(untouchedPet, "sentinel.txt"), "untouched");
    const failed = spawnSync("cmd.exe", ["/d", "/c", path.join(brokenRoot, "install.cmd")], {
      cwd: brokenRoot,
      env: { ...env, CODEX_HOME: untouchedHome },
      encoding: "utf8",
    });
    assert.notEqual(failed.status, 0);
    assert.equal(await fs.readFile(path.join(untouchedPet, "sentinel.txt"), "utf8"), "untouched");
    await assert.rejects(fs.access(path.join(untouchedHome, "pet-backups")));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

await assertInstallerContract();
await testWindowsInstaller();
console.log("Release installer tests passed.");
