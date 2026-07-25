import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const outputDirectory = path.resolve("artifacts", "npm");
const packages = [
  "@burnerform/core",
  "@burnerform/sdk",
  "@burnerform/mcp",
] as const;
const pnpmCli = process.env.npm_execpath;

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code ?? "null"}.`));
    });
  });
}

async function main() {
  if (!pnpmCli) throw new Error("pnpm must invoke the candidate build.");
  const pnpmUsesNode = /\.[cm]?js$/iu.test(pnpmCli);
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  for (const packageName of packages) {
    const args = [
      "--filter",
      packageName,
      "pack",
      "--pack-destination",
      outputDirectory,
    ];
    await run(
      pnpmUsesNode ? process.execPath : pnpmCli,
      pnpmUsesNode ? [pnpmCli, ...args] : args,
    );
  }

  const tarballs = (await readdir(outputDirectory))
    .filter((file) => file.endsWith(".tgz"))
    .sort();
  if (tarballs.length !== packages.length)
    throw new Error(`Expected ${packages.length} package candidates.`);
  const checksums = await Promise.all(
    tarballs.map(async (file) => {
      const contents = await readFile(path.join(outputDirectory, file));
      return `${createHash("sha256").update(contents).digest("hex")}  ${file}`;
    }),
  );
  await writeFile(
    path.join(outputDirectory, "SHA256SUMS"),
    `${checksums.join("\n")}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  console.log(`Built ${tarballs.length} package candidates.`);
}

void main();
