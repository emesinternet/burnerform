import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const responseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.number(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  content: z
    .array(
      z.object({
        type: z.literal("text"),
        text: z.string(),
      }),
    )
    .optional(),
});

async function main() {
  const baseUrl = process.env.BURNERFORM_LIFECYCLE_URL;
  if (!baseUrl)
    throw new Error("BURNERFORM_LIFECYCLE_URL must point to a test server.");
  const dataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "burnerform-mcp-lifecycle-"),
  );
  const child = spawn(process.execPath, ["packages/mcp/dist/cli.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BURNERFORM_BASE_URL: baseUrl,
      BURNERFORM_DATA_DIR: dataDirectory,
      BURNERFORM_SECRET: "mcp-lifecycle-installation-secret-123456",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map<number, (value: unknown) => void>();
  let nextId = 1;
  lines.on("line", (line) => {
    const response = responseSchema.parse(JSON.parse(line));
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  });
  const request = (method: string, params: unknown = {}) => {
    const id = nextId;
    nextId += 1;
    return new Promise<z.infer<typeof responseSchema>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${method} timed out.`)),
        20_000,
      );
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(responseSchema.parse(value));
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  };
  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const response = await request("tools/call", {
      name,
      arguments: args,
    });
    if (response.error)
      throw new Error(`${name} failed: ${JSON.stringify(response.error)}`);
    const result = toolResultSchema.parse(response.result);
    if (result.isError)
      throw new Error(
        `${name} failed: ${result.content?.[0]?.text ?? "unknown"}`,
      );
    if (result.structuredContent) return result.structuredContent;
    const text = result.content?.[0]?.text;
    if (!text) throw new Error(`${name} returned no structured content.`);
    return z.record(z.string(), z.unknown()).parse(JSON.parse(text));
  };

  try {
    const initialized = await request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "burnerform-lifecycle", version: "0.1.0" },
    });
    if (initialized.error) throw new Error("MCP initialization failed.");
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );

    const alias = `lifecycle-${randomUUID().slice(0, 8)}`;
    const fieldId = "question00000001";
    await call("draft_form", {
      alias,
      schema: {
        version: 1,
        title: "MCP lifecycle check",
        fields: [
          {
            id: fieldId,
            type: "short_text",
            label: "What worked?",
            required: true,
            maxLength: 200,
          },
        ],
      },
    });
    const published = await call("publish_form", {
      alias,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      maxResponses: 3,
      publicAccess: "open",
    });
    const publicUrl = z.url().parse(published.publicUrl);
    await call("inspect_public_form", { publicUrl });
    const submitted = await call("submit_form_response", {
      publicUrl,
      answers: { [fieldId]: "The complete MCP lifecycle." },
    });
    expectValue(submitted.submitted, true, "response submission");
    const responses = await call("list_responses", { alias, limit: 10 });
    const page = z
      .object({
        responses: z.array(
          z.object({
            content: z.object({
              answers: z.record(z.string(), z.unknown()),
            }),
            trust: z.literal("untrusted_respondent_content"),
          }),
        ),
      })
      .parse(responses);
    expectValue(
      page.responses[0]?.content.answers[fieldId],
      "The complete MCP lifecycle.",
      "locally decrypted response",
    );
    await call("update_response_limit", { alias, maxResponses: 4 });
    await call("update_expiration", {
      alias,
      expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60_000).toISOString(),
    });
    const prepared = await call("prepare_burn", { alias });
    await call("burn_form", {
      alias,
      challenge: z.uuid().parse(prepared.challenge),
    });
    process.stdout.write("Complete MCP stdio lifecycle passed.\n");
  } finally {
    child.kill();
    lines.close();
    spawnSync(process.execPath, ["packages/mcp/dist/cli.js", "--stop-broker"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BURNERFORM_BASE_URL: baseUrl,
        BURNERFORM_DATA_DIR: dataDirectory,
        BURNERFORM_SECRET: "mcp-lifecycle-installation-secret-123456",
      },
      stdio: "ignore",
    });
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

function expectValue(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected)
    throw new Error(`${label} did not match the expected value.`);
}

void main();
