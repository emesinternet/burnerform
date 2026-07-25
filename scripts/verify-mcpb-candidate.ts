import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { unpackExtension } from "@anthropic-ai/mcpb";
import { z } from "zod";

const responseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.number(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();
const manifestSchema = z.object({
  $schema: z.literal(
    "https://raw.githubusercontent.com/modelcontextprotocol/mcpb/main/schemas/mcpb-manifest-v0.4.schema.json",
  ),
  manifest_version: z.literal("0.4"),
  name: z.literal("burnerform"),
  version: z.literal("0.1.1"),
  license: z.literal("UNLICENSED"),
  privacy_policies: z.array(z.literal("https://burnerform.com/privacy")),
  server: z.object({
    type: z.literal("binary"),
    entry_point: z.string(),
  }),
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
});

async function smokeExecutable(executable: string, workingDirectory: string) {
  const child = spawn(executable, [], {
    cwd: workingDirectory,
    env: {
      ...process.env,
      BURNERFORM_BASE_URL: "https://burnerform.test",
      BURNERFORM_DATA_DIR: path.join(workingDirectory, "custody"),
      BURNERFORM_SECRET: "mcpb-candidate-installation-secret-123456",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  try {
    const response = new Promise<z.infer<typeof responseSchema>>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("MCP Bundle executable smoke timed out.")),
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
    if (result.error)
      throw new Error("MCP Bundle executable returned an error.");
    const tools = z
      .object({ tools: z.array(z.object({ name: z.string() })) })
      .parse(result.result).tools;
    if (tools.length !== 15)
      throw new Error(
        `Expected 15 MCP Bundle tools, received ${tools.length}.`,
      );
  } finally {
    child.stdin.end();
    child.kill();
    lines.close();
    if (child.exitCode === null)
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

async function main() {
  const artifacts = path.resolve("artifacts", "mcpb");
  const candidates = (await readdir(artifacts)).filter((file) =>
    file.endsWith(".mcpb"),
  );
  if (candidates.length !== 1)
    throw new Error("Expected exactly one platform MCP Bundle candidate.");
  const candidateName = candidates[0]!;
  const candidatePath = path.join(artifacts, candidateName);
  const checksumManifest = (
    await readFile(path.join(artifacts, "SHA256SUMS"), "utf8")
  ).trim();
  const checksumMatch = checksumManifest.match(/^([a-f0-9]{64})\s{2}(\S+)$/u);
  if (!checksumMatch || checksumMatch[2] !== candidateName)
    throw new Error("MCP Bundle checksum manifest is invalid.");
  const checksum = createHash("sha256")
    .update(await readFile(candidatePath))
    .digest("hex");
  if (checksum !== checksumMatch[1])
    throw new Error("MCP Bundle checksum verification failed.");

  const directory = await mkdtemp(
    path.join(os.tmpdir(), "burnerform-mcpb-candidate-"),
  );
  try {
    if (
      !(await unpackExtension({
        mcpbPath: candidatePath,
        outputDir: directory,
        silent: true,
      }))
    )
      throw new Error("MCP Bundle could not be unpacked.");
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")),
    );
    if (manifest.tools.length !== 15)
      throw new Error("MCP Bundle manifest must declare all 15 tools.");
    const files = (await readdir(directory, { recursive: true }))
      .map((file) => file.replaceAll("\\", "/"))
      .sort();
    const expectedFiles = [
      "icon.png",
      "manifest.json",
      "server",
      manifest.server.entry_point,
    ].sort();
    if (JSON.stringify(files) !== JSON.stringify(expectedFiles))
      throw new Error(
        `MCP Bundle contains unexpected files: ${files.join(", ")}.`,
      );
    const executable = path.join(directory, manifest.server.entry_point);
    if (!(await stat(executable)).isFile())
      throw new Error("MCP Bundle executable is missing.");
    await smokeExecutable(executable, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  process.stdout.write(
    "Private MCP Bundle integrity, contents, and tool discovery passed.\n",
  );
}

void main();
