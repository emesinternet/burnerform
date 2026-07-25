#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Burnerform, EnvironmentSecretProvider } from "@burnerform/sdk/node";
import { createBurnerformMcpServer } from "./server";

async function main() {
  const baseUrl = process.env.BURNERFORM_BASE_URL ?? "https://burnerform.com";
  const secretProvider = process.env.BURNERFORM_SECRET
    ? new EnvironmentSecretProvider()
    : undefined;
  const burnerform = await Burnerform.open({
    baseUrl,
    dataDirectory: process.env.BURNERFORM_DATA_DIR,
    secretProvider,
  });
  await burnerform.reconcile();
  const server = createBurnerformMcpServer(burnerform);
  const shutdown = async () => {
    await server.close();
    await burnerform.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(
    `burnerform_mcp_failed ${error instanceof Error ? error.name : "unknown"}\n`,
  );
  process.exitCode = 1;
});
