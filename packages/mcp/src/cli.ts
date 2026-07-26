#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultBurnerformDataDirectory } from "@burnerform/sdk/node";
import {
  createBrokerCaller,
  ensureBroker,
  runBroker,
  stopBroker,
} from "./broker";
import { createBurnerformMcpServer } from "./server";

async function main() {
  const baseUrl = process.env.BURNERFORM_BASE_URL ?? "https://burnerform.com";
  const options = {
    baseUrl,
    dataDirectory:
      process.env.BURNERFORM_DATA_DIR ?? defaultBurnerformDataDirectory(),
    secretMode: process.env.BURNERFORM_SECRET
      ? ("environment" as const)
      : ("keyring" as const),
  };
  if (process.argv.includes("--broker")) {
    await runBroker(options);
    return;
  }
  if (process.argv.includes("--stop-broker")) {
    await stopBroker(options);
    return;
  }
  await ensureBroker(options);
  const server = createBurnerformMcpServer(createBrokerCaller(options));
  const shutdown = async () => {
    await server.close();
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
