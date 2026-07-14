import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function ensureDir(directory) {
  await fs.mkdir(directory, { recursive: true });
}

export async function sha256File(filename) {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(filename));
  return hash.digest("hex");
}

export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function animationFrames(directory, animation) {
  const matcher = new RegExp(`^${escapeRegex(animation)}_(\\d+)\\.png$`, "i");
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && matcher.test(entry.name))
    .map((entry) => {
      const match = entry.name.match(matcher);
      return { index: Number(match[1]), path: path.join(directory, entry.name) };
    })
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.path);
}

export function sampleEvenly(items, count, range = [0, 1]) {
  if (!items.length) throw new Error("Cannot sample an empty frame list.");
  if (count === 1) return [items[Math.round((items.length - 1) * range[0])]];
  const [start, end] = range;
  return Array.from({ length: count }, (_, index) => {
    const progress = index / (count - 1);
    const sourceProgress = start + (end - start) * progress;
    return items[Math.round((items.length - 1) * sourceProgress)];
  });
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    shell: options.shell ?? false,
  });
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`Command failed (${result.status}): ${command} ${args.join(" ")}\n${details}`);
  }
  return result;
}

export function isDirectRun(importMetaUrl) {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(importMetaUrl);
}

export async function writeJson(filename, value) {
  await ensureDir(path.dirname(filename));
  await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
