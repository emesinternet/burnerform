import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { z } from "zod";

const responseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.number(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

function run(command: string, args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code ?? "null"}.`));
    });
  });
}

async function exists(target: string) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function smokeMcp(workingDirectory: string) {
  const child = spawn(
    process.execPath,
    ["node_modules/@burnerform/mcp/dist/cli.js"],
    {
      cwd: workingDirectory,
      env: {
        ...process.env,
        BURNERFORM_BASE_URL: "https://burnerform.test",
        BURNERFORM_DATA_DIR: path.join(workingDirectory, "custody"),
        BURNERFORM_SECRET: "package-candidate-installation-secret-123456",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const lines = readline.createInterface({ input: child.stdout });
  const response = new Promise<z.infer<typeof responseSchema>>(
    (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Candidate MCP smoke timed out.")),
        20_000,
      );
      lines.once("line", (line) => {
        clearTimeout(timer);
        resolve(responseSchema.parse(JSON.parse(line)));
      });
    },
  );
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    })}\n`,
  );
  const result = await response;
  child.stdin.end();
  child.kill();
  if (result.error) throw new Error("Candidate MCP returned an error.");
  const tools = z
    .object({ tools: z.array(z.object({ name: z.string() })).min(1) })
    .parse(result.result).tools;
  if (tools.length !== 15)
    throw new Error(
      `Expected 15 candidate MCP tools, received ${tools.length}.`,
    );
}

async function main() {
  const artifacts = path.resolve("artifacts", "npm");
  const checksums = await readFile(path.join(artifacts, "SHA256SUMS"), "utf8");
  const entries = checksums
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.match(/^([a-f0-9]{64})\s{2}(\S+)$/u);
      if (!match) throw new Error("Package checksum manifest is invalid.");
      const checksum = match[1];
      const fileName = match[2];
      if (!checksum || !fileName)
        throw new Error("Package checksum manifest is invalid.");
      return {
        checksum,
        file: path.join(artifacts, fileName),
      };
    });
  const tarballs = entries.map(({ file }) => file);
  if (
    tarballs.length !== 3 ||
    !(await Promise.all(tarballs.map(exists))).every(Boolean)
  )
    throw new Error("Package candidate set is incomplete.");
  for (const { checksum, file } of entries) {
    const actual = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    if (actual !== checksum)
      throw new Error(`Package checksum failed for ${path.basename(file)}.`);
  }

  const directory = await mkdtemp(
    path.join(os.tmpdir(), "burnerform-package-candidate-"),
  );
  const npmCli = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const npmCommand = process.platform === "win32" ? process.execPath : "npm";
  const npmPrefix = process.platform === "win32" ? [npmCli] : [];
  try {
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    await run(
      npmCommand,
      [...npmPrefix, "install", "--no-audit", "--no-fund", ...tarballs],
      directory,
    );
    await run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "await import('@burnerform/sdk'); await import('@burnerform/core');",
      ],
      directory,
    );
    await smokeMcp(directory);
    await run(
      npmCommand,
      [
        ...npmPrefix,
        "uninstall",
        "--no-audit",
        "--no-fund",
        "@burnerform/mcp",
        "@burnerform/sdk",
        "@burnerform/core",
      ],
      directory,
    );
    for (const packageName of ["mcp", "sdk", "core"]) {
      if (
        await exists(
          path.join(directory, "node_modules", "@burnerform", packageName),
        )
      )
        throw new Error(`@burnerform/${packageName} was not uninstalled.`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  console.log("Package install, smoke, and uninstall passed.");
}

void main();
