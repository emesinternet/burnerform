import { access, lstat, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const UNSAFE_DIRECTORY_MESSAGE =
  "The custody directory must not be inside a Git repository or broadly writable.";

export function defaultBurnerformDataDirectory(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData)
      throw new Error("LOCALAPPDATA is required for local custody.");
    return path.join(localAppData, "Burnerform");
  }
  if (process.platform === "darwin")
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Burnerform",
    );
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
    "burnerform",
  );
}

async function isInsideGitRepository(directory: string): Promise<boolean> {
  let current = path.resolve(directory);
  for (;;) {
    try {
      await access(path.join(current, ".git"));
      return true;
    } catch {
      // Continue walking toward the filesystem root.
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export async function prepareCustodyDirectory(
  directory: string,
): Promise<string> {
  const resolved = path.resolve(directory);
  if (await isInsideGitRepository(resolved))
    throw new Error(UNSAFE_DIRECTORY_MESSAGE);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(UNSAFE_DIRECTORY_MESSAGE);
  if (process.platform !== "win32") {
    const permissions = (await stat(resolved)).mode & 0o777;
    if ((permissions & 0o077) !== 0) throw new Error(UNSAFE_DIRECTORY_MESSAGE);
  }
  return resolved;
}
