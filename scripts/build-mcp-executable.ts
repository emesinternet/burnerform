import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const supportedPlatforms = {
  darwin: "macos",
  linux: "linux",
  win32: "win",
} as const;

const platform =
  supportedPlatforms[process.platform as keyof typeof supportedPlatforms];
if (!platform || !["x64", "arm64"].includes(process.arch)) {
  throw new Error(
    `Unsupported executable target: ${process.platform}-${process.arch}`,
  );
}

const pnpm = process.env.npm_execpath ?? "pnpm";
const pnpmUsesNode = /\.[cm]?js$/iu.test(pnpm);
const commandOptions = {
  stdio: "inherit" as const,
};
function runPnpm(args: string[]) {
  execFileSync(
    pnpmUsesNode ? process.execPath : pnpm,
    pnpmUsesNode ? [pnpm, ...args] : args,
    commandOptions,
  );
}

async function main() {
  const outputDirectory = path.resolve("artifacts", "mcp-executable");
  const extension = process.platform === "win32" ? ".exe" : "";
  const artifactName = `burnerform-mcp-${platform}-${process.arch}${extension}`;
  const artifactPath = path.join(outputDirectory, artifactName);

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  runPnpm([
    "exec",
    "tsup",
    "--config",
    "packages/mcp/tsup.executable.config.ts",
  ]);
  runPnpm([
    "exec",
    "pkg",
    "packages/mcp/dist-executable/burnerform-mcp.js",
    "--targets",
    `node24-${platform}-${process.arch}`,
    "--output",
    artifactPath,
  ]);

  const digest = createHash("sha256")
    .update(await readFile(artifactPath))
    .digest("hex");
  await writeFile(
    path.join(outputDirectory, "SHA256SUMS"),
    `${digest}  ${artifactName}\n`,
    "utf8",
  );

  process.stdout.write(`Built ${artifactPath}\n`);
}

void main();
