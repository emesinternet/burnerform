import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writePrivateFile(
  target: string,
  contents: string,
): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}
