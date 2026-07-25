import { readFile } from "node:fs/promises";
import { burnerformToolDefinitions } from "@burnerform/mcp";

async function main() {
  const skill = await readFile("skills/burnerform/SKILL.md", "utf8");
  const missing = burnerformToolDefinitions
    .map((tool) => tool.name)
    .filter((name) => !skill.includes(`\`${name}\``));

  if (missing.length > 0)
    throw new Error(
      `Burnerform skill is missing MCP tools: ${missing.join(", ")}`,
    );

  process.stdout.write(
    `Burnerform skill covers ${burnerformToolDefinitions.length} MCP tools.\n`,
  );
}

void main();
