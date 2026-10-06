import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

async function main() {
  const dataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "burnerform-mcp-smoke-"),
  );
  const env = {
    NODE_ENV: process.env.NODE_ENV ?? "test",
    BURNERFORM_BASE_URL: "https://burnerform.test",
    BURNERFORM_DATA_DIR: dataDirectory,
    BURNERFORM_SECRET: "mcp-smoke-installation-secret-123456",
  };

  try {
    for (const { mode, era } of [
      { mode: "auto", era: "modern" },
      { mode: "legacy", era: "legacy" },
    ] as const) {
      const client = new Client(
        { name: "burnerform-smoke", version: "0.5.0" },
        { versionNegotiation: { mode } },
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["packages/mcp/dist/cli.js"],
        cwd: process.cwd(),
        env,
        stderr: "ignore",
      });

      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        if (tools.length === 0)
          throw new Error("MCP server returned no tools.");
        const prepared = await client.callTool({
          name: "prepare_burn",
          arguments: { alias: "mcp-smoke" },
        });
        if (prepared.isError || !prepared.structuredContent)
          throw new Error("MCP server could not call tools.");
        if (client.getProtocolEra() !== era)
          throw new Error(`MCP server did not negotiate the ${era} protocol.`);
        process.stdout.write(`${era}: ${tools.length} tools\n`);
      } finally {
        await transport.close();
      }
    }
    process.stdout.write("MCP stdio smoke passed for both protocol eras.\n");
  } finally {
    spawnSync(process.execPath, ["packages/mcp/dist/cli.js", "--stop-broker"], {
      cwd: process.cwd(),
      env,
      stdio: "ignore",
    });
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

void main();
