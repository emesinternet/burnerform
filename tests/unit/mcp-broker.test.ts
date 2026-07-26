import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createBrokerCaller, runBroker } from "../../packages/mcp/src/broker";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

describe("Burnerform MCP broker", () => {
  it("serves concurrent MCP clients through one custody owner", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "burnerform-broker-"),
    );
    process.env.BURNERFORM_SECRET =
      "broker-test-installation-secret-at-least-thirty-two-characters";
    const options = {
      baseUrl: "https://burnerform.test",
      dataDirectory,
      secretMode: "environment" as const,
    };
    const broker = await runBroker(options);
    cleanup.push(async () => {
      await broker.close();
      await rm(dataDirectory, { recursive: true, force: true });
      delete process.env.BURNERFORM_SECRET;
    });
    const first = createBrokerCaller(options);
    const second = createBrokerCaller(options);
    const schema = {
      version: 1 as const,
      title: "Shared broker form",
      fields: [
        {
          id: "answer_field_0001",
          type: "short_text" as const,
          label: "Answer",
          required: true,
          maxLength: 200,
        },
      ],
    };

    await expect(
      Promise.all([
        first.call("draft_form", { alias: "first-form", schema }),
        second.call("draft_form", { alias: "second-form", schema }),
      ]),
    ).resolves.toEqual([
      { alias: "first-form", fieldCount: 1 },
      { alias: "second-form", fieldCount: 1 },
    ]);
  });
});
