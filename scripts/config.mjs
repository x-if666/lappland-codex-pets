import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CACHE_DIR = path.join(ROOT, ".cache");
export const ASSET_DIR = path.join(CACHE_DIR, "assets");
export const RENDER_DIR = path.join(CACHE_DIR, "rendered");
export const OUTPUT_DIR = path.join(ROOT, "output");
export const LOCK_FILE = path.join(ROOT, "sources.lock.json");

export const ATLAS = Object.freeze({
  columns: 8,
  rows: 11,
  cellWidth: 192,
  cellHeight: 208,
  width: 1536,
  height: 2288,
});

export const LEGACY_ATLAS = Object.freeze({
  ...ATLAS,
  rows: 9,
  height: 1872,
});

export const LOOK_ROWS = Object.freeze([
  Object.freeze({ id: "look-directions-0-7", row: 9, count: 8 }),
  Object.freeze({ id: "look-directions-8-15", row: 10, count: 8 }),
]);

export const REQUIRED_ANIMATIONS = Object.freeze([
  "Default",
  "Interact",
  "Move",
  "Relax",
  "Sit",
  "Sleep",
]);

export const EXPECTED_ANIMATION_FRAME_COUNTS = Object.freeze({
  default: Object.freeze({
    Default: 1,
    Interact: 40,
    Move: 63,
    Relax: 92,
    Sit: 157,
    Sleep: 152,
  }),
  "unruly-humbleness": Object.freeze({
    Default: 1,
    Interact: 45,
    Move: 63,
    Relax: 105,
    Sit: 157,
    Sleep: 152,
  }),
});

export const STATES = Object.freeze([
  {
    id: "idle",
    row: 0,
    count: 6,
    animation: "Relax",
    sourceFrames: {
      default: [1, 5, 9, 13, 16, 20],
      "unruly-humbleness": [1, 5, 10, 14, 18, 23],
    },
  },
  {
    id: "running-right",
    row: 1,
    count: 8,
    animation: "Move",
    sourceFrames: {
      default: [1, 5, 9, 13, 17, 20, 24, 28],
      "unruly-humbleness": [1, 5, 9, 13, 17, 21, 25, 29],
    },
  },
  {
    id: "running-left",
    row: 2,
    count: 8,
    animation: "Move",
    sourceFrames: {
      default: [1, 5, 9, 13, 17, 20, 24, 28],
      "unruly-humbleness": [1, 5, 9, 13, 17, 21, 25, 29],
    },
    mirror: true,
  },
  {
    id: "waving",
    row: 3,
    count: 4,
    animation: "Interact",
    sourceFrames: {
      default: [1, 9, 26, 38],
      "unruly-humbleness": [1, 11, 21, 43],
    },
  },
  {
    id: "jumping",
    row: 4,
    count: 5,
    animation: "Interact",
    sourceFrames: {
      default: [1, 9, 19, 9, 1],
      "unruly-humbleness": [1, 11, 21, 11, 1],
    },
    yOffsets: [0, -8, -14, -8, 0],
  },
  {
    id: "failed",
    row: 5,
    count: 8,
    animation: "Sleep",
    sourceFrames: {
      default: [1, 5, 9, 13, 17, 20, 24, 28],
      "unruly-humbleness": [1, 5, 9, 13, 17, 20, 24, 28],
    },
    posture: "sleep",
  },
  {
    id: "waiting",
    row: 6,
    count: 6,
    animation: "Sit",
    sourceFrames: {
      default: [1, 5, 10, 14, 18, 23],
      "unruly-humbleness": [1, 5, 10, 14, 18, 23],
    },
  },
  {
    id: "running",
    row: 7,
    count: 6,
    animation: "Interact",
    sourceFrames: {
      default: [1, 6, 10, 19, 30, 38],
      "unruly-humbleness": [1, 6, 12, 18, 30, 43],
    },
  },
  {
    id: "review",
    row: 8,
    count: 6,
    animation: "Sit",
    sourceFrames: {
      default: [131, 135, 140, 144, 148, 153],
      "unruly-humbleness": [131, 135, 140, 144, 148, 153],
    },
  },
]);

export const PETS = Object.freeze([
  {
    key: "default",
    id: "lappland-decadenza",
    displayName: "荒芜拉普兰德",
    description: "使用游戏内基建 Q 版动画制作的荒芜拉普兰德 Codex 宠物。",
    repoPath: "models/1038_whitw2",
    assetBase: "build_char_1038_whitw2",
  },
  {
    key: "unruly-humbleness",
    id: "lappland-decadenza-unruly-humbleness",
    displayName: "荒芜拉普兰德·无序的谦卑",
    description: "使用游戏内“无序的谦卑”基建 Q 版动画制作的 Codex 宠物。",
    repoPath: "models/1038_whitw2_sale#15",
    assetBase: "build_char_1038_whitw2_sale#15",
  },
]);

export function assetFiles(pet) {
  return [".atlas", ".png", ".skel"].map((extension) => `${pet.assetBase}${extension}`);
}

export function githubRawUrl(pet, filename) {
  const encodedPath = pet.repoPath.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/isHarryh/Ark-Models/main/${encodedPath}/${encodeURIComponent(filename)}`;
}
