import fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./config.mjs";
import { isDirectRun } from "./utils.mjs";

const RENDERER_PATH = path.join(
  ROOT,
  "node_modules",
  "spine-exporter",
  "dist",
  "renderer.js",
);

const BUGGY_LINE = "this.canvas.height = viewsize?.height || Math.round(viewport.width);";
const FIXED_LINE = "this.canvas.height = viewsize?.height || Math.round(viewport.height);";

export async function patchSpineExporter() {
  const source = await fs.readFile(RENDERER_PATH, "utf8");
  if (source.includes(FIXED_LINE)) return false;
  if (!source.includes(BUGGY_LINE)) {
    throw new Error(
      "spine-exporter renderer layout changed; refusing to apply the viewport-height patch.",
    );
  }
  await fs.writeFile(RENDERER_PATH, source.replace(BUGGY_LINE, FIXED_LINE), "utf8");
  console.log("Patched spine-exporter 0.8.0 to use the animation viewport height.");
  return true;
}

if (isDirectRun(import.meta.url)) await patchSpineExporter();
