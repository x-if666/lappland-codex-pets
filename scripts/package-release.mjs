import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import archiver from "archiver";
import sharp from "sharp";
import { ATLAS, OUTPUT_DIR, PETS, ROOT } from "./config.mjs";
import { ensureDir, isDirectRun, sha256File, writeJson } from "./utils.mjs";

const FIXED_ARCHIVE_DATE = new Date("2000-01-01T00:00:00.000Z");
const WINDOWS_INSTALLER = path.join(ROOT, "scripts", "install-release-windows.cmd");
const MACOS_INSTALLER = path.join(ROOT, "scripts", "install-release-macos.command");

function releaseVersion(argv = process.argv.slice(2)) {
  const index = argv.indexOf("--version");
  const value = index >= 0 ? argv[index + 1] : null;
  if (!value || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("Usage: npm run package:release -- --version <semver>, for example 1.0.0");
  }
  return value;
}

function releaseRoot(version, platform) {
  return `lappland-codex-pets-v${version}-${platform}`;
}

function installHtml(platform, version) {
  const isWindows = platform === "windows";
  const installer = isWindows ? "双击安装宠物-Windows.cmd" : "双击安装宠物-macOS.command";
  const manualPath = isWindows ? "%USERPROFILE%\\.codex\\pets\\" : "~/.codex/pets/";
  const security = isWindows
    ? "如果 Windows 发出安全提示，请先确认文件来自本项目的 GitHub Release；不需要关闭安全软件。"
    : "如果 macOS 阻止首次运行，请在 Finder 中右键安装文件并选择“打开”；不要关闭 Gatekeeper。";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>荒芜拉普兰德 Codex 宠物安装说明</title>
  <style>
    body { max-width: 760px; margin: 40px auto; padding: 0 20px; font: 17px/1.65 system-ui, sans-serif; color: #202124; }
    h1, h2 { line-height: 1.25; } code { background: #f2f3f5; padding: 2px 6px; border-radius: 5px; }
    .box { border: 1px solid #d7dbe0; border-radius: 12px; padding: 16px 20px; background: #fafafa; }
  </style>
</head>
<body>
  <h1>荒芜拉普兰德 Codex 宠物 v${version}</h1>
  <div class="box">
    <ol>
      <li>先把 ZIP 完整解压，不要直接在压缩包预览窗口里运行。</li>
      <li>双击 <strong>${installer}</strong>。</li>
      <li>看到“安装成功”后，彻底退出并重新打开 Codex。</li>
      <li>进入“设置 → 外观 → 宠物”，选择拉普兰德。</li>
    </ol>
  </div>
  <p>${security}</p>
  <h2>手动安装备用方式</h2>
  <p>把本目录 <code>pets</code> 中的两个 <code>lappland-...</code> 文件夹复制到
  <code>${manualPath}</code>。最终路径必须是 <code>.../pets/&lt;pet-id&gt;/pet.json</code>，不能多套一层 pets。</p>
  <h2>仍然看不到宠物？</h2>
  <p>请更新 Codex Desktop，检查目录层级，然后彻底退出并重新打开应用。本宠物使用 sprite v2。</p>
  <p>这是免费、非商业、非官方的爱好者项目。游戏角色和美术版权归其权利人所有。</p>
</body>
</html>
`;
}

async function validatePetPayload(pet) {
  const finalDir = path.join(OUTPUT_DIR, pet.id, "final");
  const petJsonPath = path.join(finalDir, "pet.json");
  const spritesheetPath = path.join(finalDir, "spritesheet.webp");
  const petJson = JSON.parse(await fsp.readFile(petJsonPath, "utf8"));
  if (petJson.id !== pet.id) throw new Error(`${pet.id}: pet.json id mismatch.`);
  if (petJson.spriteVersionNumber !== 2) {
    throw new Error(`${pet.id}: Release requires spriteVersionNumber 2.`);
  }
  if (petJson.spritesheetPath !== "spritesheet.webp") {
    throw new Error(`${pet.id}: spritesheetPath must be spritesheet.webp.`);
  }
  const metadata = await sharp(spritesheetPath).metadata();
  if (metadata.width !== ATLAS.width || metadata.height !== ATLAS.height || !metadata.hasAlpha) {
    throw new Error(
      `${pet.id}: expected ${ATLAS.width}x${ATLAS.height} alpha WebP, got `
      + `${metadata.width}x${metadata.height}, alpha=${metadata.hasAlpha}.`,
    );
  }
  return [
    { source: petJsonPath, relative: `pets/${pet.id}/pet.json`, mode: 0o644 },
    { source: spritesheetPath, relative: `pets/${pet.id}/spritesheet.webp`, mode: 0o644 },
  ];
}

async function zipArchive(filename, root, entries) {
  await ensureDir(path.dirname(filename));
  const output = fs.createWriteStream(filename);
  const archive = archiver("zip", { zlib: { level: 9 } });
  const completed = new Promise((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.on("warning", (error) => {
      if (error.code === "ENOENT") console.warn(error.message);
      else reject(error);
    });
  });
  archive.pipe(output);
  for (const entry of entries) {
    const options = {
      name: `${root}/${entry.relative}`,
      date: FIXED_ARCHIVE_DATE,
      mode: entry.mode ?? 0o644,
    };
    if (entry.source) archive.file(entry.source, options);
    else archive.append(entry.content, options);
  }
  await archive.finalize();
  await completed;
}

export async function packageRelease({ version = releaseVersion() } = {}) {
  const releaseDir = path.join(OUTPUT_DIR, "releases", `v${version}`);
  const resolvedReleaseDir = path.resolve(releaseDir);
  const resolvedOutputDir = path.resolve(OUTPUT_DIR);
  if (!resolvedReleaseDir.startsWith(`${resolvedOutputDir}${path.sep}`)) {
    throw new Error(`Unsafe release output path: ${resolvedReleaseDir}`);
  }
  await fsp.rm(releaseDir, { recursive: true, force: true });
  await ensureDir(releaseDir);

  const payload = [];
  for (const pet of PETS) payload.push(...await validatePetPayload(pet));
  await Promise.all([fsp.access(WINDOWS_INSTALLER), fsp.access(MACOS_INSTALLER)]);

  const payloadChecksums = [];
  for (const entry of payload) {
    payloadChecksums.push(`${await sha256File(entry.source)}  ${entry.relative}`);
  }
  const checksumsContent = `${payloadChecksums.join("\n")}\n`;
  const notices = await fsp.readFile(path.join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8");

  const platforms = [
    {
      id: "windows",
      installer: WINDOWS_INSTALLER,
      installerName: "双击安装宠物-Windows.cmd",
      installerMode: 0o644,
    },
    {
      id: "macos",
      installer: MACOS_INSTALLER,
      installerName: "双击安装宠物-macOS.command",
      installerMode: 0o755,
    },
  ];
  const packages = [];
  for (const platform of platforms) {
    const basename = `lappland-codex-pets-v${version}-${platform.id}.zip`;
    const filename = path.join(releaseDir, basename);
    const entries = [
      ...payload,
      {
        source: platform.installer,
        relative: platform.installerName,
        mode: platform.installerMode,
      },
      { content: Buffer.from(checksumsContent), relative: "checksums.txt", mode: 0o644 },
      {
        content: Buffer.from(installHtml(platform.id, version)),
        relative: "安装说明.html",
        mode: 0o644,
      },
      {
        content: Buffer.from(notices),
        relative: "THIRD_PARTY_NOTICES.txt",
        mode: 0o644,
      },
    ];
    await zipArchive(filename, releaseRoot(version, platform.id), entries);
    packages.push({ platform: platform.id, filename, basename, sha256: await sha256File(filename) });
  }

  const sums = `${packages.map((item) => `${item.sha256}  ${item.basename}`).join("\n")}\n`;
  await fsp.writeFile(path.join(releaseDir, "SHA256SUMS.txt"), sums, "utf8");
  await writeJson(path.join(releaseDir, "release-manifest.json"), {
    schemaVersion: 1,
    version,
    spriteVersionNumber: 2,
    pets: PETS.map(({ id, displayName }) => ({ id, displayName })),
    payload: payloadChecksums.map((line) => {
      const [sha256, relative] = line.split("  ");
      return { relative, sha256 };
    }),
    packages: packages.map(({ platform, basename, sha256 }) => ({ platform, basename, sha256 })),
  });
  for (const item of packages) console.log(`Created ${item.filename}`);
  console.log(`Created ${path.join(releaseDir, "SHA256SUMS.txt")}`);
  return { releaseDir, packages };
}

if (isDirectRun(import.meta.url)) await packageRelease();
