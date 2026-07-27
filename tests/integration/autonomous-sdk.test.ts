import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateFormRequest } from "@burnerform/core/contracts/requests";
import {
  decryptResponse,
  encryptResponse,
  exportPublicKey,
  generateResponseKeyPair,
  importPublicKey,
} from "@burnerform/core/crypto";
import {
  MemoryCustodyStore,
  MemorySecretProvider,
  provisionCreatorCustody,
  serializeRecoveryFile,
} from "@burnerform/sdk";
import { Burnerform } from "@burnerform/sdk/node";

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "burnerform-autonomous-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function apiResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "burnerform-api-version": "v1",
      "burnerform-supported-client-range": ">=0.3.0 <1.0.0",
    },
  });
}

describe("autonomous SDK lifecycle", () => {
  it("publishes, restarts, decrypts, mutates, and burns without returning secrets", async () => {
    let created: CreateFormRequest | undefined;
    const createdFormId = "00112233445566778899aabbccddeeff";
    let burned = false;
    let activeMutations = 0;
    let maximumConcurrentMutations = 0;
    const schemaHash = "a".repeat(64);
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/v1/forms" && method === "POST") {
        created = JSON.parse(String(init?.body)) as CreateFormRequest;
        return apiResponse(
          {
            formId: createdFormId,
            expiresAt: created.expiresAt,
            replayed: false,
          },
          201,
        );
      }
      if (url.pathname.endsWith("/responses/query") && method === "POST") {
        if (!created) throw new Error("Form was not created.");
        const envelope = await encryptResponse(
          {
            formVersion: 1,
            answers: { question00000001: "Untrusted answer" },
            submittedAt: "2026-07-24T12:00:00.000Z",
          },
          await importPublicKey(created.creatorPublicKey.value),
          {
            formId: createdFormId,
            schemaHash,
            schemaVersion: 1,
            keyId: created.creatorPublicKey.keyId,
          },
        );
        return apiResponse({
          responses: [
            {
              id: "eb5b5d24-a9cf-4fdb-99fc-3bec75505612",
              envelopeVersion: 2,
              envelope,
              receivedAt: "2026-07-24T12:00:00.000Z",
              ciphertextBytes: JSON.stringify(envelope).length,
            },
          ],
          nextCursor: null,
        });
      }
      if (url.pathname.endsWith("/expiration") && method === "PATCH") {
        activeMutations += 1;
        maximumConcurrentMutations = Math.max(
          maximumConcurrentMutations,
          activeMutations,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        const body = JSON.parse(String(init?.body)) as { expiresAt: string };
        activeMutations -= 1;
        return apiResponse({ expiresAt: body.expiresAt });
      }
      if (url.pathname.endsWith("/response-limit") && method === "PATCH") {
        activeMutations += 1;
        maximumConcurrentMutations = Math.max(
          maximumConcurrentMutations,
          activeMutations,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        const body = JSON.parse(String(init?.body)) as {
          maxResponses: number;
        };
        activeMutations -= 1;
        return apiResponse({ maxResponses: body.maxResponses });
      }
      if (url.pathname.startsWith("/api/v1/manage/") && method === "DELETE") {
        burned = true;
        return apiResponse({ burned: true, replayed: false });
      }
      if (url.pathname.startsWith("/api/v1/manage/") && method === "GET") {
        if (!created) throw new Error("Form was not created.");
        return apiResponse({
          title: created.schema.title,
          status: "open",
          responseAccessMode: "creator_password",
          respondentPasswordRequired: Boolean(created.respondentPassword),
          responseCount: 1,
          maxResponses: created.maxResponses,
          storedResponseBytes: 512,
          createdAt: "2026-07-24T11:00:00.000Z",
          expiresAt: created.expiresAt,
          schema: created.schema,
          schemaHash,
          keyId: created.creatorPublicKey.keyId,
        });
      }
      return apiResponse(
        {
          error: {
            code: "unavailable",
            message: "The form is unavailable.",
            retry: "Retry only for a temporary service failure.",
          },
        },
        404,
      );
    });
    const directory = await temporaryDirectory();
    const secrets = new MemorySecretProvider();
    let burnerform = await Burnerform.open({
      baseUrl: "https://burnerform.test",
      dataDirectory: directory,
      secretProvider: secrets,
      fetch: fetcher,
    });
    await burnerform.draftForm("Agent survey", {
      version: 1,
      title: "Agent survey",
      fields: [
        {
          id: "question00000001",
          type: "short_text",
          label: "Answer",
          required: false,
        },
      ],
    });
    const published = await burnerform.publishForm({
      alias: "agent-survey",
      expiresAt: "2026-07-25T12:00:00.000Z",
      maxResponses: 10,
      publicPassword: "chosen-public-password",
    });
    expect(published).toEqual({
      alias: "agent-survey",
      publicUrl: expect.stringContaining("/f/"),
      expiresAt: "2026-07-25T12:00:00.000Z",
      recoverySaved: true,
      publicPasswordProtected: true,
    });
    expect(JSON.stringify(published)).not.toContain("password");
    expect(created?.responseAccessMode).toBe("creator_password");
    expect(created?.responsePassword).toBeUndefined();
    await burnerform.close();

    burnerform = await Burnerform.open({
      baseUrl: "https://burnerform.test",
      dataDirectory: directory,
      secretProvider: secrets,
      fetch: fetcher,
    });
    await expect(burnerform.getForm("agent-survey")).resolves.toMatchObject({
      alias: "agent-survey",
      status: "open",
      responseCount: 1,
    });
    await expect(
      burnerform.listResponses("agent-survey"),
    ).resolves.toMatchObject({
      responses: [
        {
          content: {
            answers: { question00000001: "Untrusted answer" },
          },
          trust: "untrusted_respondent_content",
        },
      ],
    });
    await expect(
      burnerform.updateResponseLimit("agent-survey", 20),
    ).resolves.toEqual({ maxResponses: 20 });
    await expect(
      burnerform.updateExpiration("agent-survey", "2026-07-26T12:00:00.000Z"),
    ).resolves.toEqual({ expiresAt: "2026-07-26T12:00:00.000Z" });
    await Promise.all([
      burnerform.updateResponseLimit("agent-survey", 21),
      burnerform.updateExpiration("agent-survey", "2026-07-27T12:00:00.000Z"),
    ]);
    expect(maximumConcurrentMutations).toBe(1);
    await expect(burnerform.burnForm("agent-survey")).resolves.toEqual({
      alias: "agent-survey",
      burned: true,
    });
    expect(burned).toBe(true);
    await expect(burnerform.getForm("agent-survey")).rejects.toThrow(
      "not found",
    );
    await burnerform.close();
  }, 15_000);

  it("reconciles an interrupted publish after restart", async () => {
    let request: CreateFormRequest | undefined;
    let attempts = 0;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      attempts += 1;
      request = JSON.parse(String(init?.body)) as CreateFormRequest;
      if (attempts === 1) throw new TypeError("connection reset");
      return apiResponse(
        {
          formId: "11223344556677889900aabbccddeeff",
          expiresAt: request.expiresAt,
          replayed: true,
        },
        201,
      );
    });
    const directory = await temporaryDirectory();
    const secrets = new MemorySecretProvider();
    let burnerform = await Burnerform.open({
      baseUrl: "https://burnerform.test",
      dataDirectory: directory,
      secretProvider: secrets,
      fetch: fetcher,
    });
    await burnerform.draftForm("restart-survey", {
      version: 1,
      title: "Restart survey",
      fields: [
        {
          id: "question00000001",
          type: "short_text",
          label: "Answer",
          required: false,
        },
      ],
    });
    await expect(
      burnerform.publishForm({
        alias: "restart-survey",
        expiresAt: "2026-07-25T12:00:00.000Z",
        maxResponses: 10,
        publicPassword: null,
      }),
    ).rejects.toThrow("connection reset");
    await burnerform.close();

    burnerform = await Burnerform.open({
      baseUrl: "https://burnerform.test",
      dataDirectory: directory,
      secretProvider: secrets,
      fetch: fetcher,
    });
    await expect(burnerform.reconcile()).resolves.toEqual([
      { operationId: expect.any(String), state: "complete" },
    ]);
    expect(attempts).toBe(2);
    expect(request).toBeDefined();
    await burnerform.close();
  });

  it("reconciles a publish interrupted before its first durable side effect", async () => {
    let attempts = 0;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      attempts += 1;
      const request = JSON.parse(String(init?.body)) as CreateFormRequest;
      return apiResponse(
        {
          formId: "22334455667788990011aabbccddeeff",
          expiresAt: request.expiresAt,
          replayed: false,
        },
        201,
      );
    });
    const directory = await temporaryDirectory();
    const secrets = new MemorySecretProvider();
    let burnerform = await Burnerform.open({
      baseUrl: "https://burnerform.test",
      dataDirectory: directory,
      secretProvider: secrets,
      fetch: fetcher,
    });
    await burnerform.draftForm("early-interruption", {
      version: 1,
      title: "Early interruption",
      fields: [
        {
          id: "question00000001",
          type: "short_text",
          label: "Answer",
          required: false,
        },
      ],
    });
    const encryptedSecrets = (
      burnerform as unknown as {
        secrets: { set(name: string, value: string): Promise<void> };
      }
    ).secrets;
    const originalSet = encryptedSecrets.set.bind(encryptedSecrets);
    vi.spyOn(encryptedSecrets, "set")
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockImplementation(originalSet);

    await expect(
      burnerform.publishForm({
        alias: "early-interruption",
        expiresAt: "2026-07-25T12:00:00.000Z",
        maxResponses: 10,
        publicPassword: null,
      }),
    ).rejects.toThrow("disk unavailable");
    expect(attempts).toBe(0);
    await burnerform.close();

    burnerform = await Burnerform.open({
      baseUrl: "https://burnerform.test",
      dataDirectory: directory,
      secretProvider: secrets,
      fetch: fetcher,
    });
    await expect(burnerform.reconcile()).resolves.toEqual([
      { operationId: expect.any(String), state: "complete" },
    ]);
    expect(attempts).toBe(1);
    await burnerform.close();
  });

  it("reconciles a publish interrupted after the server accepts it", async () => {
    let attempts = 0;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      attempts += 1;
      const request = JSON.parse(String(init?.body)) as CreateFormRequest;
      return apiResponse(
        {
          formId: "33445566778899001122aabbccddeeff",
          expiresAt: request.expiresAt,
          replayed: attempts > 1,
        },
        attempts > 1 ? 200 : 201,
      );
    });
    const directory = await temporaryDirectory();
    const secrets = new MemorySecretProvider();
    let burnerform = await Burnerform.open({
      baseUrl: "https://burnerform.test",
      dataDirectory: directory,
      secretProvider: secrets,
      fetch: fetcher,
    });
    await burnerform.draftForm("late-interruption", {
      version: 1,
      title: "Late interruption",
      fields: [
        {
          id: "question00000001",
          type: "short_text",
          label: "Answer",
          required: false,
        },
      ],
    });
    const registry = (
      burnerform as unknown as {
        registry: { set(value: unknown): Promise<void> };
      }
    ).registry;
    const originalSet = registry.set.bind(registry);
    vi.spyOn(registry, "set")
      .mockRejectedValueOnce(new Error("registry unavailable"))
      .mockImplementation(originalSet);

    await expect(
      burnerform.publishForm({
        alias: "late-interruption",
        expiresAt: "2026-07-25T12:00:00.000Z",
        maxResponses: 10,
        publicPassword: null,
      }),
    ).rejects.toThrow("registry unavailable");
    expect(attempts).toBe(1);
    await burnerform.close();

    burnerform = await Burnerform.open({
      baseUrl: "https://burnerform.test",
      dataDirectory: directory,
      secretProvider: secrets,
      fetch: fetcher,
    });
    await expect(burnerform.reconcile()).resolves.toEqual([
      { operationId: expect.any(String), state: "complete" },
    ]);
    expect(attempts).toBe(2);
    await burnerform.close();
  });

  it("releases the custody lock even when journal compaction fails", async () => {
    const directory = await temporaryDirectory();
    const secrets = new MemorySecretProvider();
    const burnerform = await Burnerform.open({
      baseUrl: "https://burnerform.test",
      dataDirectory: directory,
      secretProvider: secrets,
    });
    const journal = (
      burnerform as unknown as {
        journal: { compact(): Promise<void> };
      }
    ).journal;
    vi.spyOn(journal, "compact").mockRejectedValueOnce(
      new Error("journal unavailable"),
    );
    await expect(burnerform.close()).rejects.toThrow("journal unavailable");

    const reopened = await Burnerform.open({
      baseUrl: "https://burnerform.test",
      dataDirectory: directory,
      secretProvider: secrets,
    });
    await reopened.close();
  });

  it("reconciles interrupted protection and burn mutations after restart", async () => {
    let created: CreateFormRequest | undefined;
    let protectionAttempts = 0;
    let burnAttempts = 0;
    let passwordProtected = false;
    let burned = false;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/v1/forms" && method === "POST") {
        created = JSON.parse(String(init?.body)) as CreateFormRequest;
        return apiResponse(
          {
            formId: "44556677889900112233aabbccddeeff",
            expiresAt: created.expiresAt,
            replayed: false,
          },
          201,
        );
      }
      if (url.pathname.endsWith("/respondent-access") && method === "PATCH") {
        protectionAttempts += 1;
        const body = JSON.parse(String(init?.body)) as {
          password: string | null;
        };
        passwordProtected = body.password !== null;
        if (protectionAttempts === 1)
          throw new TypeError("connection reset after protection");
        return apiResponse({ passwordRequired: passwordProtected });
      }
      if (url.pathname.startsWith("/api/v1/manage/") && method === "DELETE") {
        burnAttempts += 1;
        burned = true;
        if (burnAttempts === 1)
          throw new TypeError("connection reset after burn");
        return apiResponse({ burned: true, replayed: true });
      }
      if (url.pathname.startsWith("/api/v1/manage/") && method === "GET") {
        if (!created) throw new Error("Form was not created.");
        return apiResponse({
          title: created.schema.title,
          status: "open",
          responseAccessMode: "creator_password",
          respondentPasswordRequired: passwordProtected,
          responseCount: 0,
          maxResponses: created.maxResponses,
          storedResponseBytes: 0,
          createdAt: "2026-07-24T11:00:00.000Z",
          expiresAt: created.expiresAt,
          schema: created.schema,
          schemaHash: "a".repeat(64),
          keyId: created.creatorPublicKey.keyId,
        });
      }
      return apiResponse(
        {
          error: {
            code: "unavailable",
            message: "The form is unavailable.",
            retry: "Retry only for a temporary service failure.",
          },
        },
        404,
      );
    });
    const directory = await temporaryDirectory();
    const secrets = new MemorySecretProvider();
    let burnerform = await Burnerform.open({
      baseUrl: "https://burnerform.test",
      dataDirectory: directory,
      secretProvider: secrets,
      fetch: fetcher,
    });
    await burnerform.draftForm("restart-mutations", {
      version: 1,
      title: "Restart mutations",
      fields: [
        {
          id: "question00000001",
          type: "short_text",
          label: "Answer",
          required: false,
        },
      ],
    });
    await burnerform.publishForm({
      alias: "restart-mutations",
      expiresAt: "2026-07-25T12:00:00.000Z",
      maxResponses: 10,
      publicPassword: null,
    });

    await expect(
      burnerform.updatePublicFormPassword(
        "restart-mutations",
        "chosen-public-password",
      ),
    ).rejects.toThrow("connection reset after protection");
    expect(passwordProtected).toBe(true);
    await burnerform.close();

    burnerform = await Burnerform.open({
      baseUrl: "https://burnerform.test",
      dataDirectory: directory,
      secretProvider: secrets,
      fetch: fetcher,
    });
    await expect(burnerform.reconcile()).resolves.toEqual([
      { operationId: expect.any(String), state: "complete" },
    ]);
    await expect(
      burnerform.getLocalReview("restart-mutations"),
    ).resolves.toMatchObject({
      publicPasswordProtected: true,
      publicPassword: expect.any(String),
    });
    expect(protectionAttempts).toBe(2);

    await expect(burnerform.burnForm("restart-mutations")).rejects.toThrow(
      "connection reset after burn",
    );
    expect(burned).toBe(true);
    await burnerform.close();

    burnerform = await Burnerform.open({
      baseUrl: "https://burnerform.test",
      dataDirectory: directory,
      secretProvider: secrets,
      fetch: fetcher,
    });
    await expect(burnerform.reconcile()).resolves.toEqual([
      { operationId: expect.any(String), state: "complete" },
    ]);
    await expect(burnerform.getForm("restart-mutations")).rejects.toThrow(
      "not found",
    );
    expect(burnAttempts).toBe(2);
    await burnerform.close();
  });

  it("restores exported recovery material in a clean custody directory", async () => {
    const formId = "0123456789abcdef0123456789abcdef";
    const keyId = "abcdef0123456789abcdef0123456789";
    const recoveryPassword = "generated-recovery-password-123456";
    const schemaHash = "c".repeat(64);
    const schema = {
      version: 1 as const,
      title: "Recovery source",
      fields: [
        {
          id: "question00000001",
          type: "short_text" as const,
          label: "Answer",
          required: false,
        },
      ],
    };
    const source = await provisionCreatorCustody({
      formId,
      keyId,
      mode: "creator_password",
      password: recoveryPassword,
      recoveryPassword,
      store: new MemoryCustodyStore(),
    });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname.startsWith("/api/v1/manage/") && method === "GET") {
        return apiResponse({
          title: schema.title,
          status: "open",
          responseAccessMode: "creator_password",
          respondentPasswordRequired: false,
          responseCount: 0,
          maxResponses: 10,
          storedResponseBytes: 0,
          createdAt: "2026-07-24T11:00:00.000Z",
          expiresAt: "2026-07-25T12:00:00.000Z",
          schema,
          schemaHash,
          keyId,
        });
      }
      return apiResponse(
        {
          error: {
            code: "unavailable",
            message: "The form is unavailable.",
            retry: "Retry only for a temporary service failure.",
          },
        },
        404,
      );
    });
    const exportDirectory = await temporaryDirectory();
    const restoredDirectory = await temporaryDirectory();
    const recoveryFilePath = path.join(
      exportDirectory,
      "recovery-source.recovery.json",
    );
    await writeFile(
      recoveryFilePath,
      serializeRecoveryFile(source.recoveryFile!),
      "utf8",
    );

    const restored = await Burnerform.open({
      baseUrl: "https://burnerform.test",
      dataDirectory: restoredDirectory,
      secretProvider: new MemorySecretProvider(),
      fetch: fetcher,
    });
    await expect(
      restored.restoreRecovery(
        "recovered-form",
        recoveryFilePath,
        recoveryPassword,
      ),
    ).resolves.toEqual({ alias: "recovered-form", restored: true });
    await expect(restored.getForm("recovered-form")).resolves.toMatchObject({
      alias: "recovered-form",
      status: "open",
      maxResponses: 10,
    });
    await restored.close();
  });

  it("validates and encrypts respondent-agent answers before submission", async () => {
    const creator = await generateResponseKeyPair(false);
    const formId = "dfa320f9bace4daaa4ff9164ad5b6e88";
    const keyId = "bf1320f9bace4daaa4ff9164ad5b6e77";
    const schemaHash = "b".repeat(64);
    let submittedEnvelope: unknown;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname.endsWith("/responses")) {
        submittedEnvelope = (
          JSON.parse(String(init.body)) as { envelope: unknown }
        ).envelope;
        return apiResponse(
          {
            responseId: "eb5b5d24-a9cf-4fdb-99fc-3bec75505612",
            replayed: false,
          },
          201,
        );
      }
      return apiResponse({
        passwordRequired: false,
        formId,
        schemaVersion: 1,
        schema: {
          version: 1,
          title: "Public survey",
          fields: [
            {
              id: "question00000001",
              type: "email",
              label: "Email",
              required: true,
            },
          ],
        },
        schemaHash,
        keyId,
        creatorPublicKey: {
          format: "raw-p256",
          value: await exportPublicKey(creator.publicKey),
          keyId,
        },
        maxResponseBytes: 524_288,
        expiresAt: "2026-07-25T12:00:00.000Z",
        apiVersion: "v1",
        links: {
          self: `/api/v1/forms/${formId}`,
          access: `/api/v1/forms/${formId}/access`,
          responses: `/api/v1/forms/${formId}/responses`,
        },
      });
    });
    const burnerform = await Burnerform.open({
      baseUrl: "https://burnerform.test",
      dataDirectory: await temporaryDirectory(),
      secretProvider: new MemorySecretProvider(),
      fetch: fetcher,
    });
    const publicUrl = `https://burnerform.test/f/${formId}`;
    await expect(
      burnerform.inspectPublicForm(publicUrl),
    ).resolves.toMatchObject({
      passwordRequired: false,
      schema: { title: "Public survey" },
    });
    await expect(
      burnerform.submitPublicResponse(publicUrl, {
        question00000001: "ada@example.com",
      }),
    ).resolves.toMatchObject({ submitted: true });
    await expect(
      decryptResponse(submittedEnvelope, creator.privateKey, {
        formId,
        schemaHash,
        schemaVersion: 1,
        keyId,
      }),
    ).resolves.toMatchObject({
      answers: { question00000001: "ada@example.com" },
    });
    await burnerform.close();
  });
});
