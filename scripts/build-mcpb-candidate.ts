import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { burnerformToolDefinitions } from "../packages/mcp/src/tool-registry";

const platformNames = {
  darwin: "macos",
  linux: "linux",
  win32: "win",
} as const;

async function main() {
  const platform =
    platformNames[process.platform as keyof typeof platformNames];
  if (!platform || !["x64", "arm64"].includes(process.arch))
    throw new Error(
      `Unsupported MCP bundle target: ${process.platform}-${process.arch}.`,
    );

  const outputDirectory = path.resolve("artifacts", "mcpb");
  const stagingDirectory = path.join(outputDirectory, "staging");
  const serverDirectory = path.join(stagingDirectory, "server");
  const executableExtension = process.platform === "win32" ? ".exe" : "";
  const sourceExecutable = path.resolve(
    "artifacts",
    "mcp-executable",
    `burnerform-mcp-${platform}-${process.arch}${executableExtension}`,
  );
  const bundledExecutable = `burnerform-mcp${executableExtension}`;
  const entryPoint = `server/${bundledExecutable}`;
  const candidateName = `burnerform-mcp-${platform}-${process.arch}.mcpb`;
  const candidatePath = path.join(outputDirectory, candidateName);

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(serverDirectory, { recursive: true });
  await copyFile(
    sourceExecutable,
    path.join(serverDirectory, bundledExecutable),
  );
  await copyFile(
    path.resolve("public", "brand", "icon-512.png"),
    path.join(stagingDirectory, "icon.png"),
  );
  await writeFile(
    path.join(stagingDirectory, "manifest.json"),
    JSON.stringify(
      {
        $schema:
          "https://raw.githubusercontent.com/modelcontextprotocol/mcpb/main/schemas/mcpb-manifest-v0.4.schema.json",
        manifest_version: "0.4",
        name: "burnerform",
        display_name: "Burnerform",
        version: "0.1.1",
        description:
          "Create, collect, recover, and burn encrypted temporary forms.",
        long_description:
          "A private local MCP server for the complete Burnerform lifecycle. Secrets and decrypted responses remain under local custody.",
        author: {
          name: "emesinternet",
          url: "https://burnerform.com",
        },
        repository: {
          type: "git",
          url: "https://github.com/emesinternet/burnerform.git",
        },
        homepage: "https://burnerform.com",
        documentation: "https://burnerform.com/docs/mcp",
        icon: "icon.png",
        license: "UNLICENSED",
        privacy_policies: ["https://burnerform.com/privacy"],
        keywords: ["forms", "encryption", "temporary", "agentic"],
        compatibility: {
          platforms: [process.platform],
        },
        server: {
          type: "binary",
          entry_point: entryPoint,
          mcp_config: {
            command: `\${__dirname}/${entryPoint}`,
            args: [],
            env: {
              BURNERFORM_BASE_URL: "https://burnerform.com",
            },
          },
        },
        tools: burnerformToolDefinitions.map(({ name, description }) => ({
          name,
          description,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );

  const cli = path.resolve(
    "node_modules",
    "@anthropic-ai",
    "mcpb",
    "dist",
    "cli",
    "cli.js",
  );
  execFileSync(process.execPath, [cli, "validate", stagingDirectory], {
    stdio: "inherit",
  });
  execFileSync(
    process.execPath,
    [cli, "pack", stagingDirectory, candidatePath],
    { stdio: "inherit" },
  );
  execFileSync(process.execPath, [cli, "info", candidatePath], {
    stdio: "inherit",
  });

  const checksum = createHash("sha256")
    .update(await readFile(candidatePath))
    .digest("hex");
  await writeFile(
    path.join(outputDirectory, "SHA256SUMS"),
    `${checksum}  ${candidateName}\n`,
    "utf8",
  );
  await rm(stagingDirectory, { recursive: true, force: true });
  process.stdout.write(`Built ${candidatePath}\n`);
}

void main();
