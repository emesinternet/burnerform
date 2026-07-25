import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { BURNERFORM_CLIENT_VERSION } from "@burnerform/core";
import { burnerformToolDefinitions } from "@burnerform/mcp";

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(target) : [target];
    }),
  );
  return nested.flat();
}

async function main() {
  const failures: string[] = [];
  const documentationDirectory = path.resolve(
    process.argv.includes("--public-export") ? "docs" : "content/docs",
  );
  const publicFiles = [
    ...(await filesUnder(documentationDirectory)).filter((file) =>
      file.endsWith(".mdx"),
    ),
    path.resolve("packages", "sdk", "README.md"),
    path.resolve("packages", "mcp", "README.md"),
    path.resolve("skills", "burnerform", "SKILL.md"),
    ...(await filesUnder(path.resolve("skills", "burnerform", "references"))),
  ];
  const compatibilityFile = path.resolve(
    documentationDirectory,
    "compatibility.mdx",
  );
  const compatibilitySource = await readFile(compatibilityFile, "utf8");
  for (const expected of [
    `X-Burnerform-Client-Version: ${BURNERFORM_CLIENT_VERSION}`,
    `VERSION="${BURNERFORM_CLIENT_VERSION}"`,
  ])
    if (!compatibilitySource.includes(expected))
      failures.push(
        `${path.relative(".", compatibilityFile)}: missing released version example ${expected}`,
      );
  const toolNames = new Set<string>(
    burnerformToolDefinitions.map((definition) => definition.name),
  );
  const sdkSource = await readFile(
    path.resolve("packages", "sdk", "src", "node", "autonomous.ts"),
    "utf8",
  );
  const sdkMethods = new Set(
    Array.from(sdkSource.matchAll(/^\s{2}async\s+([A-Za-z]\w*)\s*\(/gmu))
      .map((match) => match[1])
      .filter((name): name is string => Boolean(name)),
  );
  sdkMethods.add("open");
  sdkMethods.add("close");

  const knownEnvironmentVariables = new Set([
    "BURNERFORM_BASE_URL",
    "BURNERFORM_DATA_DIR",
    "BURNERFORM_SECRET",
  ]);
  const toolLike =
    /^(?:burn|draft|export|get|inspect|list|prepare|publish|restore|review|submit|unlock|update)_[a-z0-9_]+$/u;
  const forbiddenReleaseLanguage =
    /\b(?:unpublished|not published|not officially published|private release candidate|release candidate|publishing remains paused)\b/iu;
  const forbiddenTerms = /\b(?:brandingAvatar|BrandingAvatar)\b/u;

  for (const file of publicFiles) {
    const source = await readFile(file, "utf8");
    const relative = path.relative(".", file);

    if (forbiddenReleaseLanguage.test(source))
      failures.push(`${relative}: contains non-live release language`);
    if (forbiddenTerms.test(source))
      failures.push(`${relative}: exposes obsolete form-image terminology`);

    for (const match of source.matchAll(/`([a-z][a-z0-9_]+)`/gu)) {
      const name = match[1];
      if (name && toolLike.test(name) && !toolNames.has(name))
        failures.push(`${relative}: unknown MCP tool ${name}`);
    }

    for (const match of source.matchAll(/\bburnerform\.([A-Za-z]\w*)\s*\(/gu)) {
      const method = match[1];
      if (method && !sdkMethods.has(method))
        failures.push(`${relative}: unknown SDK method ${method}`);
    }

    for (const match of source.matchAll(/\bBURNERFORM_[A-Z_]+\b/gu)) {
      const variable = match[0];
      if (!knownEnvironmentVariables.has(variable))
        failures.push(
          `${relative}: unknown public environment variable ${variable}`,
        );
    }
  }

  if (failures.length)
    throw new Error(`Documentation contract failures:\n${failures.join("\n")}`);

  process.stdout.write(
    `Documentation contracts match ${toolNames.size} MCP tools and ${sdkMethods.size} SDK methods.\n`,
  );
}

void main();
