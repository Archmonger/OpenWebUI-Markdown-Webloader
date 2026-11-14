/**
 * Cross-platform stand-in for `dom_smoothie_cli` in tests.
 *
 * The preprocessing tests need a real *executable* that speaks the cleaner's
 * stdin -> stdout contract, because `src/preprocess.ts` spawns it directly
 * (no shell). A `#!/usr/bin/env bash` script works on Linux/macOS but cannot
 * be spawned on Windows, which made the suite fail on the Windows runners.
 *
 * This helper compiles a tiny Bun program once per test process with
 * `bun build --compile`, producing a native executable for whatever platform
 * the suite is running on (Linux/macOS/Windows, x64/arm64). Each call then
 * hard-links that executable into a fresh temp dir and writes a `mode.json`
 * beside it describing the behaviour to emulate. The compiled program reads
 * `mode.json` relative to `process.execPath` (its own location), so every
 * "binary" is independent even though the bytes are shared.
 *
 * Modes:
 *   - `passthrough` echo stdin unchanged
 *   - `clean`       echo stdin with `<body>` rewritten (proves stdin flowed)
 *   - `log-args`    append argv to `argsLog`, then echo stdin
 *   - `fail`        exit non-zero
 *   - `empty`       consume stdin, print nothing
 *   - `whitespace`  consume stdin, print whitespace only
 *   - `hang`        consume stdin, then sleep far past the test timeout
 */
import { copyFileSync, linkSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FakeCliMode =
  | "passthrough"
  | "clean"
  | "log-args"
  | "fail"
  | "empty"
  | "whitespace"
  | "hang";

export interface FakeCliSpec {
  mode: FakeCliMode;
  /** Absolute path where the emulated CLI should record its argv. */
  argsLog?: string;
}

const FAKE_CLI_SOURCE = `import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

let spec = { mode: "passthrough" };
try {
  spec = JSON.parse(readFileSync(join(dirname(process.execPath), "mode.json"), "utf8"));
} catch {}

const input = await Bun.stdin.text();

if (spec.argsLog) {
  writeFileSync(spec.argsLog, process.argv.join(" "));
}

switch (spec.mode) {
  case "clean":
    process.stdout.write(input.replace("<body>", '<body data-cleaned="1">'));
    break;
  case "fail":
    process.exit(3);
    break;
  case "empty":
    break;
  case "whitespace":
    process.stdout.write("   \\n  \\n");
    break;
  case "hang":
    await new Promise((resolve) => setTimeout(resolve, 30000));
    break;
  default:
    process.stdout.write(input);
}
`;

/** Compiled template executable, built lazily once per test process. */
let compiledTemplate: string | undefined;

function ensureTemplate(): string {
  if (compiledTemplate) return compiledTemplate;

  const dir = mkdtempSync(join(tmpdir(), "fake-cli-build-"));
  const source = join(dir, "fake-cli.mjs");
  const out = join(
    dir,
    process.platform === "win32" ? "fake-cli.exe" : "fake-cli",
  );
  writeFileSync(source, FAKE_CLI_SOURCE);

  const result = Bun.spawnSync(
    [process.execPath, "build", "--compile", "--outfile", out, source],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `fake-cli: bun build --compile failed (exit ${result.exitCode}): ${result.stderr.toString()}`,
    );
  }

  compiledTemplate = out;
  return out;
}

/**
 * Create an executable that behaves like `dom_smoothie_cli` per `spec`.
 *
 * @param name Short label used for the temp dir / file name.
 * @param spec Behaviour to emulate plus an optional argv log path.
 * @returns Absolute path to the executable to pass as `PREPROCESS_BINARY`.
 */
export function makeFakeCli(name: string, spec: FakeCliSpec): string {
  const dir = mkdtempSync(join(tmpdir(), `fake-cli-${name}-`));
  const template = ensureTemplate();
  const bin = join(dir, process.platform === "win32" ? `${name}.exe` : name);

  try {
    // Hard links avoid copying the ~90 MB Bun runtime per fake binary. They
    // are supported on NTFS and all POSIX filesystems; fall back to a copy if
    // the temp filesystem refuses.
    linkSync(template, bin);
  } catch {
    copyFileSync(template, bin);
  }

  writeFileSync(join(dir, "mode.json"), JSON.stringify(spec));
  return bin;
}
