import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { z } from "zod";

const platformNames = {
  darwin: "macos",
  linux: "linux",
  win32: "win",
} as const;
const platform = platformNames[process.platform as keyof typeof platformNames];
if (!platform) throw new Error(`Unsupported platform: ${process.platform}`);

const executable = path.resolve(
  "artifacts",
  "mcp-executable",
  `burnerform-mcp-${platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`,
);
const responseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.number(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

async function main() {
  const dataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "burnerform-mcp-executable-smoke-"),
  );
  const child = spawn(executable, [], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BURNERFORM_BASE_URL: "https://burnerform.test",
      BURNERFORM_DATA_DIR: dataDirectory,
      BURNERFORM_SECRET: "mcp-executable-smoke-installation-secret-123456",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map<number, (value: unknown) => void>();
  lines.on("line", (line) => {
    const response = responseSchema.parse(JSON.parse(line));
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  });

  const request = (id: number, method: string, params: unknown = {}) =>
    new Promise<z.infer<typeof responseSchema>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${method} timed out.`)),
        10_000,
      );
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(responseSchema.parse(value));
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });

  try {
    const initialized = await request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "burnerform-executable-smoke", version: "0.1.0" },
    });
    if (initialized.error) throw new Error("MCP initialization failed.");
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const listed = await request(2, "tools/list");
    const tools = z
      .object({ tools: z.array(z.object({ name: z.string() }).passthrough()) })
      .parse(listed.result).tools;
    if (tools.length === 0)
      throw new Error("MCP executable returned no tools.");
    process.stdout.write(
      `MCP executable smoke passed with ${tools.length} tools.\n`,
    );
  } finally {
    child.kill();
    lines.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

void main();
