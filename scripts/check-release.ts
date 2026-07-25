import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
});

const exportSchema = z.object({
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  files: z.array(
    z.object({
      path: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    }),
  ),
});

async function readJson(file: string) {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

async function verifyVersions() {
  const files = [
    "package.json",
    "packages/core/package.json",
    "packages/sdk/package.json",
    "packages/mcp/package.json",
  ];
  const manifests = await Promise.all(
    files.map(async (file) => ({
      file,
      manifest: manifestSchema.parse(await readJson(path.resolve(file))),
    })),
  );
  const expected = manifests[0]?.manifest.version;
  if (!expected) throw new Error("The workspace version is missing.");

  const mismatches = manifests.filter(
    ({ manifest }) => manifest.version !== expected,
  );
  if (mismatches.length > 0)
    throw new Error(
      `Coordinated package versions do not match ${expected}: ${mismatches
        .map(({ file, manifest }) => `${file}=${manifest.version}`)
        .join(", ")}`,
    );

  const versionSource = await readFile(
    path.resolve("packages/core/src/version.ts"),
    "utf8",
  );
  const clientVersion = versionSource.match(
    /BURNERFORM_CLIENT_VERSION\s*=\s*"([^"]+)"/u,
  )?.[1];
  if (clientVersion !== expected)
    throw new Error(
      `The emitted client version is ${clientVersion ?? "missing"}, expected ${expected}.`,
    );

  return expected;
}

function verifyCleanWorktree() {
  const status = execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  });
  if (status.trim())
    throw new Error("Release checks require a clean Git worktree.");
}

async function verifyPublicExport() {
  const manifestFile = path.resolve(".burnerform-export.json");
  const exportManifest = await readJson(manifestFile).catch(() => null);
  if (!exportManifest) return;

  const parsed = exportSchema.parse(exportManifest);
  const stale: string[] = [];
  for (const entry of parsed.files) {
    const contents = await readFile(path.resolve(entry.path)).catch(() => null);
    if (!contents) {
      stale.push(entry.path);
      continue;
    }
    const rawHash = createHash("sha256").update(contents).digest("hex");
    const normalizedHash = createHash("sha256")
      .update(contents.toString("utf8").replaceAll("\r\n", "\n"))
      .digest("hex");
    if (rawHash !== entry.sha256 && normalizedHash !== entry.sha256)
      stale.push(entry.path);
  }
  if (stale.length > 0)
    throw new Error(`Public export files are stale: ${stale.join(", ")}`);
}

async function main() {
  verifyCleanWorktree();
  const version = await verifyVersions();
  await verifyPublicExport();
  process.stdout.write(`Release checks passed for ${version}.\n`);
}

void main();
