import { open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { prepareCustodyDirectory } from "./paths";

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function lockCustodyDirectory(
  directory: string,
): Promise<() => Promise<void>> {
  const safeDirectory = await prepareCustodyDirectory(directory);
  const lockPath = path.join(safeDirectory, ".burnerform.lock");
  try {
    const existingPid = Number(await readFile(lockPath, "utf8"));
    if (Number.isInteger(existingPid) && processIsRunning(existingPid))
      throw new Error("This custody directory is already in use.");
    await unlink(lockPath);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "This custody directory is already in use."
    )
      throw error;
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code !== "ENOENT"
    )
      throw error;
  }
  const handle = await open(lockPath, "wx", 0o600);
  await handle.writeFile(String(process.pid), "utf8");
  await handle.close();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await unlink(lockPath).catch((error: unknown) => {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    });
  };
}
