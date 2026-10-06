#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
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
  const handle = serveStdio(() =>
    createBurnerformMcpServer(createBrokerCaller(options)),
  );
  const shutdown = () => void handle.close();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `burnerform_mcp_failed ${error instanceof Error ? error.name : "unknown"}\n`,
  );
  process.exitCode = 1;
});
