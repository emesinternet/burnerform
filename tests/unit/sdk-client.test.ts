import { describe, expect, it, vi } from "vitest";
import { BurnerformClient } from "@burnerform/sdk";

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      "burnerform-api-version": "v1",
      "burnerform-supported-client-range": ">=0.1.0 <1.0.0",
      ...init.headers,
    },
  });
}

describe("Burnerform SDK transport", () => {
  it("keeps management keys in headers and validates responses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        title: "Example",
        status: "open",
        responseAccessMode: "creator_only",
        respondentPasswordRequired: false,
        responseCount: 0,
        maxResponses: 10,
        storedResponseBytes: 0,
        createdAt: "2026-07-24T12:00:00.000Z",
        expiresAt: "2026-07-25T12:00:00.000Z",
        schema: {
          version: 1,
          title: "Example",
          fields: [
            {
              id: "abcdefghijklmnop",
              type: "short_text",
              label: "Answer",
              required: false,
            },
          ],
        },
        schemaHash: "a".repeat(64),
        keyId: "0123456789abcdef0123456789abcdef",
      }),
    );
    const client = new BurnerformClient({
      baseUrl: "https://burnerform.test",
      fetch: fetcher,
    });
    const managementKey = "secret-management-key";

    await client.getManagementOverview(
      "0123456789abcdef0123456789abcdef",
      managementKey,
    );

    const [request] = fetcher.mock.calls[0] ?? [];
    expect(request).toBeInstanceOf(URL);
    expect(String(request)).not.toContain(managementKey);
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-burner-management-key")).toBe(managementKey);
    expect(headers.get("x-burnerform-client-version")).toBe("0.1.2");
  });

  it("maps stable API failures without returning response bodies", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "rate_limited",
            message: "The request exceeded an active rate limit.",
            retry: "Wait before retrying.",
          },
        },
        {
          status: 429,
          headers: { "x-correlation-id": "correlation-id" },
        },
      ),
    );
    const client = new BurnerformClient({
      baseUrl: "https://burnerform.test",
      fetch: fetcher,
    });

    await expect(
      client.getPublicForm("0123456789abcdef0123456789abcdef"),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "rate_limited",
        correlationId: "correlation-id",
        description: "The request exceeded an active rate limit.",
        retry: "Wait before retrying.",
        status: 429,
      }),
    );
  });

  it("rejects malformed successful responses", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ activeForms: 4 }));
    const client = new BurnerformClient({
      baseUrl: "https://burnerform.test",
      fetch: fetcher,
    });

    await expect(
      client.getPublicForm("0123456789abcdef0123456789abcdef"),
    ).rejects.toMatchObject({
      name: "ZodError",
    });
  });

  it("requires version compatibility headers on successful responses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          activeForms: 0,
          activeHumanForms: 0,
          activeAgenticForms: 0,
          burnedForms: 0,
          burnedHumanForms: 0,
          burnedAgenticForms: 0,
        }),
        {
          headers: {
            "content-type": "application/json",
            "burnerform-api-version": "v1",
          },
        },
      ),
    );
    const client = new BurnerformClient({
      baseUrl: "https://burnerform.test",
      fetch: fetcher,
    });

    await expect(
      client.getPublicForm("0123456789abcdef0123456789abcdef"),
    ).rejects.toThrow("did not advertise a supported client range");
  });

  it("propagates caller cancellation to fetch", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const client = new BurnerformClient({
      baseUrl: "https://burnerform.test",
      fetch: fetcher,
      timeoutMs: 60_000,
    });
    const controller = new AbortController();
    const request = client.getPublicForm(
      "0123456789abcdef0123456789abcdef",
      undefined,
      { signal: controller.signal },
    );

    controller.abort(new Error("operator cancelled"));

    await expect(request).rejects.toThrow("operator cancelled");
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("aborts requests after the configured timeout", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const client = new BurnerformClient({
      baseUrl: "https://burnerform.test",
      fetch: fetcher,
      timeoutMs: 5,
    });

    await expect(
      client.getPublicForm("0123456789abcdef0123456789abcdef"),
    ).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });
});
