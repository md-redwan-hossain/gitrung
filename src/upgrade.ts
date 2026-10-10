import * as p from "@clack/prompts";
import chalk from "chalk";
import { unzipSync } from "fflate";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { checkUpgradeWriteAccess, isBunRuntime } from "./io-access.ts";
import { createSpinner } from "./spinner.ts";

const RELEASE_BASE =
  "https://github.com/md-redwan-hossain/gitrung/releases/download/latest";

type PlatformAsset = {
  archive: string;
  binary: string;
  checksum: string;
};

function resolvePlatformAsset(): PlatformAsset {
  if (process.platform === "win32" && process.arch === "x64") {
    return {
      archive: "gitrung-windows-x64.zip",
      binary: "gitrung-windows-x64.exe",
      checksum: "gitrung-windows-x64.sha256",
    };
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return {
      archive: "gitrung-linux-x64.zip",
      binary: "gitrung-linux-x64",
      checksum: "gitrung-linux-x64.sha256",
    };
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return {
      archive: "gitrung-darwin-arm64.zip",
      binary: "gitrung-darwin-arm64",
      checksum: "gitrung-darwin-arm64.sha256",
    };
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return {
      archive: "gitrung-darwin-x64.zip",
      binary: "gitrung-darwin-x64",
      checksum: "gitrung-darwin-x64.sha256",
    };
  }
  throw new Error(
    `Unsupported platform: ${process.platform}/${process.arch}.`,
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function renderDownloadProgress(
  filename: string,
  spinner: ReturnType<typeof createSpinner>,
  downloaded: number,
  total: number | undefined,
): void {
  const downloadedText = formatBytes(downloaded);
  if (total === undefined) {
    spinner.text = `Downloading ${filename}: ${chalk.yellow(`${downloadedText} downloaded`)}`;
    return;
  }

  spinner.text = `Downloading ${filename}: ${chalk.yellow(
    `${downloadedText} / ${formatBytes(total)}`,
  )}`;
}

async function download(
  url: string,
  options: { progressFilename?: string } = {},
): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status} ${response.statusText})`);
  }

  if (!response.body) {
    throw new Error("Download failed: response body is unavailable.");
  }

  const totalHeader = response.headers.get("content-length");
  const parsedTotal = totalHeader ? Number.parseInt(totalHeader, 10) : NaN;
  const total =
    Number.isFinite(parsedTotal) && parsedTotal >= 0 ? parsedTotal : undefined;
  const progress = options.progressFilename
    ? createSpinner(
        `Downloading ${options.progressFilename}: ${chalk.yellow("0 B")}`,
      ).start()
    : undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let downloaded = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      downloaded += value.byteLength;
      if (progress) {
        renderDownloadProgress(
          options.progressFilename!,
          progress,
          downloaded,
          total,
        );
      }
    }
  } finally {
    reader.releaseLock();
    progress?.stop();
  }

  const result = new Uint8Array(downloaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function parseChecksum(data: Uint8Array, expectedAsset: string): string {
  const text = new TextDecoder().decode(data).trim();
  const match = text.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
  if (!match || basename(match[2]!.trim()) !== expectedAsset) {
    throw new Error(`Checksum file is malformed for ${expectedAsset}.`);
  }
  return match[1]!.toLowerCase();
}

function extractBinaryFromZip(
  zipBytes: Uint8Array,
  binaryName: string,
): Uint8Array {
  const files = unzipSync(zipBytes);
  const direct = files[binaryName];
  if (direct) return direct;

  const key = Object.keys(files).find((k) => basename(k) === binaryName);
  if (key && files[key]) return files[key]!;

  throw new Error(`Zip archive does not contain ${binaryName}.`);
}

function currentExecutable(): string {
  if (isBunRuntime()) {
    throw new Error(
      "Self-update is available only for a compiled gitrung binary, not bun src/index.ts.",
    );
  }
  const executable = resolve(process.execPath);
  if (!existsSync(executable)) {
    throw new Error(`Current executable was not found: ${executable}`);
  }
  return executable;
}

function siblingExecutable(executable: string, tag: "new" | "old"): string {
  const ext = executable.toLowerCase().endsWith(".exe") ? ".exe" : "";
  const stem = ext ? executable.slice(0, -ext.length) : executable;
  return `${stem}.${tag}${ext}`;
}

function cleanupPreviousExecutable(executable: string): void {
  const oldExecutable = siblingExecutable(executable, "old");
  if (!existsSync(oldExecutable)) return;

  try {
    unlinkSync(oldExecutable);
  } catch (err) {
    p.log.warn(
      `Could not remove previous executable backup ${oldExecutable}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Best-effort delete of <exe>.old[.exe] after a prior self-update. No-op under bun source. */
export function cleanupStaleUpgradeArtifacts(): void {
  if (isBunRuntime()) return;
  const executable = resolve(process.execPath);
  if (!existsSync(executable)) return;
  cleanupPreviousExecutable(executable);
}

function replaceWindowsExecutable(
  executable: string,
  replacement: string,
): void {
  const oldExecutable = siblingExecutable(executable, "old");

  if (existsSync(oldExecutable)) {
    try {
      unlinkSync(oldExecutable);
    } catch (err) {
      throw new Error(
        `Could not remove previous backup ${oldExecutable}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  try {
    renameSync(executable, oldExecutable);
  } catch (err) {
    throw new Error(
      `Could not rename running executable to ${oldExecutable}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  try {
    renameSync(replacement, executable);
  } catch (err) {
    try {
      renameSync(oldExecutable, executable);
    } catch {
      // Leave both files for manual recovery.
    }
    throw new Error(
      `Could not install ${replacement} as ${executable}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function replaceExecutable(
  executable: string,
  replacementBytes: Uint8Array,
): Promise<void> {
  const replacement =
    process.platform === "win32"
      ? siblingExecutable(executable, "new")
      : join(
          dirname(executable),
          `.${basename(executable)}.upgrade-${Date.now()}`,
        );
  writeFileSync(replacement, replacementBytes);
  if (process.platform === "win32") {
    replaceWindowsExecutable(executable, replacement);
    return;
  }
  chmodSync(replacement, 0o755);
  copyFileSync(replacement, executable);
  unlinkSync(replacement);
}

export async function runUpgrade(): Promise<void> {
  p.intro("gitrung upgrade");

  try {
    const writeError = checkUpgradeWriteAccess();
    if (writeError) throw new Error(writeError);

    const asset = resolvePlatformAsset();
    const executable = currentExecutable();
    cleanupPreviousExecutable(executable);
    const checksumBytes = await download(
      `${RELEASE_BASE}/${encodeURIComponent(asset.checksum)}`,
    );
    const expectedHash = parseChecksum(checksumBytes, asset.binary);
    const currentHash = sha256(new Uint8Array(readFileSync(executable)));

    if (currentHash === expectedHash) {
      p.log.success("Already up to date.");
      return;
    }

    const choice = await p.select({
      message: "A new gitrung binary is available. Update now?",
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
    });
    if (p.isCancel(choice) || choice === "no") {
      p.outro("Update skipped.");
      return;
    }

    const zipBytes = await download(
      `${RELEASE_BASE}/${encodeURIComponent(asset.archive)}`,
      { progressFilename: asset.archive },
    );
    const replacementBytes = extractBinaryFromZip(zipBytes, asset.binary);
    if (sha256(replacementBytes) !== expectedHash) {
      throw new Error("Downloaded binary failed checksum verification.");
    }
    await replaceExecutable(executable, replacementBytes);
    p.outro(
      process.platform === "win32"
        ? "Updated successfully. Restart gitrung to use the new binary."
        : "Updated successfully.",
    );
  } catch (err) {
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
