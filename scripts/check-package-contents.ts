import { execFileSync } from "node:child_process";
import { z } from "zod";

const packages = ["@burnerform/core", "@burnerform/sdk", "@burnerform/mcp"];
const manifestSchema = z.object({
  name: z.string(),
  files: z.array(z.object({ path: z.string() })),
});
const pnpm =
  process.platform === "win32"
    ? (process.env.npm_execpath ?? "pnpm.exe")
    : "pnpm";

for (const packageName of packages) {
  const output = execFileSync(
    pnpm,
    ["--filter", packageName, "pack", "--dry-run", "--json"],
    { encoding: "utf8" },
  );
  const manifest = manifestSchema.parse(JSON.parse(output));
  const unexpected = manifest.files
    .map(({ path }) => path)
    .filter(
      (file) =>
        file !== "package.json" &&
        file !== "README.md" &&
        file !== "LICENSE" &&
        !file.startsWith("dist/"),
    );
  if (unexpected.length > 0)
    throw new Error(
      `${packageName} contains unexpected files: ${unexpected.join(", ")}`,
    );
  if (!manifest.files.some(({ path }) => path === "README.md"))
    throw new Error(`${packageName} is missing README.md.`);
  if (!manifest.files.some(({ path }) => path === "LICENSE"))
    throw new Error(`${packageName} is missing LICENSE.`);
  if (!manifest.files.some(({ path }) => path.startsWith("dist/")))
    throw new Error(`${packageName} has no built output.`);
  process.stdout.write(`${manifest.name}: package contents pass\n`);
}
