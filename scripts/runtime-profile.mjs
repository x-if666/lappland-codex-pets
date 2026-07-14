import path from "node:path";
import { spawnSync } from "node:child_process";
import { isDirectRun } from "./utils.mjs";

function rangeDurations(count, frameDurationMs, lastFrameDurationMs) {
  return Array.from(
    { length: count },
    (_, index) => (index === count - 1 ? lastFrameDurationMs : frameDurationMs),
  );
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// Extracted from and reverified against the avatar renderer bundled with Codex 26.707.8479.0.
// Keeping this in one versioned profile makes QA previews match the app instead
// of assuming the six-frames-per-second source-render rate.
export const CODEX_RUNTIME_PROFILE = deepFreeze({
  codexVersion: "26.707.8479.0",
  spriteVersionNumber: 2,
  atlas: {
    columns: 8,
    rows: 11,
    cellWidth: 192,
    cellHeight: 208,
    width: 1536,
    height: 2288,
  },
  cssWidth: 128,
  devicePixelRatio: 1.5,
  idle: {
    durationsMs: [1680, 660, 660, 840, 840, 1920],
    repeat: Infinity,
  },
  states: {
    failed: {
      durationsMs: rangeDurations(8, 140, 240),
      repeat: 3,
      tail: "idle",
    },
    jumping: {
      durationsMs: rangeDurations(5, 140, 280),
      repeat: 3,
      tail: "idle",
    },
    review: {
      durationsMs: rangeDurations(6, 150, 280),
      repeat: 3,
      tail: "idle",
    },
    running: {
      durationsMs: rangeDurations(6, 120, 220),
      repeat: 3,
      tail: "idle",
    },
    "running-left": {
      durationsMs: rangeDurations(8, 120, 220),
      repeat: 3,
      tail: "idle",
    },
    "running-right": {
      durationsMs: rangeDurations(8, 120, 220),
      repeat: 3,
      tail: "idle",
    },
    waving: {
      durationsMs: rangeDurations(4, 140, 280),
      repeat: 3,
      tail: "idle",
    },
    waiting: {
      durationsMs: rangeDurations(6, 150, 260),
      repeat: 3,
      tail: "idle",
    },
  },
  gaze: {
    startAngleDegrees: 0,
    angleStepDegrees: 22.5,
    clockwise: true,
    deadZoneCssPixels: 1,
    rows: [9, 10],
    directions: 16,
  },
});

export function runtimeStateProfile(stateId) {
  if (stateId === "idle") return CODEX_RUNTIME_PROFILE.idle;
  const profile = CODEX_RUNTIME_PROFILE.states[stateId];
  if (!profile) throw new Error(`No Codex runtime timing profile for state: ${stateId}`);
  return profile;
}

function assertFrames(label, frames, expectedCount) {
  if (!Array.isArray(frames) || frames.length !== expectedCount) {
    throw new Error(`${label} requires ${expectedCount} frames, got ${frames?.length ?? 0}.`);
  }
}

export function buildRuntimeSequence(stateId, { stateFrames, idleFrames } = {}) {
  const profile = runtimeStateProfile(stateId);
  assertFrames(`${stateId} preview`, stateFrames, profile.durationsMs.length);

  if (stateId === "idle") {
    return stateFrames.map((frame, index) => ({
      frame,
      durationMs: profile.durationsMs[index],
      phase: "idle",
      cycle: 1,
      frameIndex: index,
    }));
  }

  const sequence = [];
  for (let cycle = 1; cycle <= profile.repeat; cycle += 1) {
    for (let index = 0; index < stateFrames.length; index += 1) {
      sequence.push({
        frame: stateFrames[index],
        durationMs: profile.durationsMs[index],
        phase: stateId,
        cycle,
        frameIndex: index,
      });
    }
  }

  if (profile.tail === "idle") {
    assertFrames("idle tail", idleFrames, CODEX_RUNTIME_PROFILE.idle.durationsMs.length);
    for (let index = 0; index < idleFrames.length; index += 1) {
      sequence.push({
        frame: idleFrames[index],
        durationMs: CODEX_RUNTIME_PROFILE.idle.durationsMs[index],
        phase: "idle-tail",
        cycle: 1,
        frameIndex: index,
      });
    }
  }
  return sequence;
}

export function serializableRuntimeProfile() {
  return {
    ...CODEX_RUNTIME_PROFILE,
    idle: { ...CODEX_RUNTIME_PROFILE.idle, repeat: "infinite" },
  };
}

export function detectInstalledCodexRuntime({
  platform = process.platform,
  runCommand = spawnSync,
} = {}) {
  if (platform !== "win32") {
    return {
      available: false,
      source: null,
      installedVersion: null,
      reason: `Codex Appx version detection is only available on Windows (current: ${platform}).`,
    };
  }

  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const command = [
    "$package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue",
    "| Sort-Object {[version]$_.Version} -Descending",
    "| Select-Object -First 1",
    "; if ($null -ne $package) { $package.Version.ToString() }",
  ].join(" ");
  const result = runCommand(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", windowsHide: true },
  );
  const installedVersion = result.stdout?.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? null;
  if (result.error || result.status !== 0 || !installedVersion) {
    const detail = result.error?.message || result.stderr?.trim() || "OpenAI.Codex Appx package was not found.";
    return {
      available: false,
      source: "Get-AppxPackage OpenAI.Codex",
      installedVersion: null,
      reason: detail,
    };
  }
  return {
    available: true,
    source: "Get-AppxPackage OpenAI.Codex",
    installedVersion,
    reason: null,
  };
}

export function verifyInstalledCodexRuntime(options) {
  const detected = detectInstalledCodexRuntime(options);
  return {
    ...detected,
    expectedVersion: CODEX_RUNTIME_PROFILE.codexVersion,
    matches: detected.available
      ? detected.installedVersion === CODEX_RUNTIME_PROFILE.codexVersion
      : null,
  };
}

if (isDirectRun(import.meta.url)) {
  if (process.argv.includes("--verify")) {
    const verification = verifyInstalledCodexRuntime();
    console.log(JSON.stringify(verification, null, 2));
    if (!verification.available) {
      console.warn(`Warning: Codex runtime version could not be detected: ${verification.reason}`);
    } else if (!verification.matches) {
      console.error(
        `Installed Codex ${verification.installedVersion} does not match inspected runtime `
        + `${verification.expectedVersion}. Reinspect the avatar renderer and update the runtime profile.`,
      );
      process.exitCode = 1;
    }
  } else {
    console.log(JSON.stringify(serializableRuntimeProfile(), null, 2));
  }
}
