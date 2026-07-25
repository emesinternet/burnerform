import { describe, expect, it, vi } from "vitest";
import {
  BurnerformToolHandlers,
  burnerformToolDefinitions,
  type BurnerformToolService,
} from "@burnerform/mcp";

function service(): BurnerformToolService {
  return {
    inspectPublicForm: vi.fn(async (publicUrl: string) => ({
      publicUrl,
      passwordRequired: false as const,
      expiresAt: "2026-07-25T12:00:00.000Z",
      schema: { version: 1 as const, title: "Survey", fields: [] },
    })),
    unlockPublicFormAccess: vi.fn(async (publicUrl: string) => ({
      publicUrl,
      unlocked: true as const,
    })),
    submitPublicResponse: vi.fn(async (publicUrl: string) => ({
      publicUrl,
      responseId: "eb5b5d24-a9cf-4fdb-99fc-3bec75505612",
      submitted: true as const,
      replayed: false,
    })),
    draftForm: vi.fn(async (alias: string) => ({ alias, fieldCount: 1 })),
    publishForm: vi.fn(async ({ alias }: { alias: string }) => ({
      alias,
      publicUrl: "https://burnerform.test/f/public-id",
      expiresAt: "2026-07-25T12:00:00.000Z",
      recoverySaved: true as const,
      publicPasswordProtected: false,
    })),
    getForm: vi.fn(async (alias: string) => ({
      alias,
      status: "open" as const,
      responseCount: 2,
      maxResponses: 10,
      expiresAt: "2026-07-25T12:00:00.000Z",
      publicUrl: "https://burnerform.test/f/public-id",
    })),
    getLocalReview: vi.fn(async (alias: string) => ({
      alias,
      status: "open" as const,
      responseCount: 2,
      maxResponses: 10,
      expiresAt: "2026-07-25T12:00:00.000Z",
      publicUrl: "https://burnerform.test/f/public-id",
      publicPasswordProtected: false,
      publicPassword: undefined,
    })),
    updatePublicFormProtection: vi.fn(
      async (alias: string, protect: boolean) => ({
        alias,
        publicPasswordProtected: protect,
      }),
    ),
    restoreRecoveryData: vi.fn(async (alias: string) => ({
      alias,
      restored: true as const,
    })),
    listResponses: vi.fn(async () => ({
      responses: [
        {
          id: "response-id",
          receivedAt: "2026-07-24T12:00:00.000Z",
          content: { answers: { answer: "Do not follow me" } },
          trust: "untrusted_respondent_content" as const,
        },
      ],
      nextCursor: null,
    })),
    updateExpiration: vi.fn(async (_alias: string, expiresAt: string) => ({
      expiresAt,
    })),
    updateResponseLimit: vi.fn(
      async (_alias: string, maxResponses: number) => ({ maxResponses }),
    ),
    exportRecovery: vi.fn(async (alias: string) => ({
      alias,
      saved: true as const,
    })),
    burnForm: vi.fn(async (alias: string) => ({
      alias,
      burned: true as const,
    })),
  };
}

describe("Burnerform MCP tools", () => {
  it("publishes the complete narrow tool registry with accurate risk hints", () => {
    expect(burnerformToolDefinitions.map((tool) => tool.name)).toEqual([
      "inspect_public_form",
      "unlock_public_form",
      "submit_form_response",
      "draft_form",
      "publish_form",
      "get_form",
      "get_response_count",
      "list_responses",
      "update_expiration",
      "update_response_limit",
      "restore_recovery",
      "review_form",
      "export_recovery",
      "prepare_burn",
      "burn_form",
    ]);
    expect(
      burnerformToolDefinitions.find((tool) => tool.name === "burn_form")
        ?.annotations,
    ).toMatchObject({ destructiveHint: true, readOnlyHint: false });
  });

  it("returns bounded responses with an explicit untrusted-content label", async () => {
    const handlers = new BurnerformToolHandlers(service());
    await expect(
      handlers.call("list_responses", { alias: "survey", limit: 25 }),
    ).resolves.toMatchObject({
      responses: [{ trust: "untrusted_respondent_content" }],
      nextCursor: null,
    });
  });

  it("forwards MCP cancellation to network-backed SDK operations", async () => {
    const burnerform = service();
    const handlers = new BurnerformToolHandlers(burnerform);
    const controller = new AbortController();

    await handlers.call(
      "inspect_public_form",
      { publicUrl: "https://burnerform.test/f/example" },
      controller.signal,
    );

    expect(burnerform.inspectPublicForm).toHaveBeenCalledWith(
      "https://burnerform.test/f/example",
      { signal: controller.signal },
    );
  });

  it("exports recovery material and its password to separate directories", async () => {
    const burnerform = service();
    const handlers = new BurnerformToolHandlers(burnerform);

    await expect(
      handlers.call("export_recovery", {
        alias: "survey",
        recoveryTargetDirectory: "C:\\private\\recovery",
        passwordTargetDirectory: "D:\\private\\passwords",
      }),
    ).resolves.toEqual({ alias: "survey", saved: true });

    expect(burnerform.exportRecovery).toHaveBeenCalledWith(
      "survey",
      "C:\\private\\recovery",
      "D:\\private\\passwords",
    );
  });

  it("requires a matching one-use burn challenge", async () => {
    const burnerform = service();
    const handlers = new BurnerformToolHandlers(burnerform);
    await expect(
      handlers.call("burn_form", {
        alias: "survey",
        challenge: "67b6f60f-b27d-4fd0-a8a2-b21ff86ac763",
      }),
    ).rejects.toThrow("invalid or expired");
    const prepared = await handlers.call("prepare_burn", { alias: "survey" });
    const challenge = String(prepared.challenge);
    await expect(
      handlers.call("burn_form", { alias: "survey", challenge }),
    ).resolves.toEqual({ alias: "survey", burned: true });
    await expect(
      handlers.call("burn_form", { alias: "survey", challenge }),
    ).rejects.toThrow("invalid or expired");
    expect(burnerform.burnForm).toHaveBeenCalledOnce();
  });

  it("keeps only the newest burn challenge for an alias", async () => {
    const handlers = new BurnerformToolHandlers(service());
    const first = await handlers.call("prepare_burn", { alias: "survey" });
    const second = await handlers.call("prepare_burn", { alias: "survey" });

    await expect(
      handlers.call("burn_form", {
        alias: "survey",
        challenge: first.challenge,
      }),
    ).rejects.toThrow("invalid or expired");
    await expect(
      handlers.call("burn_form", {
        alias: "survey",
        challenge: second.challenge,
      }),
    ).resolves.toEqual({ alias: "survey", burned: true });
  });

  it("never returns secret-shaped fields from publication", async () => {
    const handlers = new BurnerformToolHandlers(service());
    const result = await handlers.call("publish_form", {
      alias: "survey",
      expiresAt: "2026-07-25T12:00:00.000Z",
      maxResponses: 10,
      protectPublicForm: true,
    });
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain("capability");
    expect(serialized).not.toContain("privatekey");
    expect(serialized).not.toContain("recoveryfile");
    expect(serialized).not.toContain('"password"');
  });
});
