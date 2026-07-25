import { describe, expect, it } from "vitest";
import {
  decryptResponse,
  encryptResponse,
  exportPublicKey,
  generateResponseKeyPair,
  importPublicKey,
  responsePayloadByteLength,
  responseEnvelopeSchema,
  type EnvelopeContext,
} from "@burnerform/core/crypto";
import { FORM_LIMITS } from "@burnerform/core/form-schema";

const context: EnvelopeContext = {
  formId: "form-123",
  schemaHash: "schema-hash",
  schemaVersion: 1,
  keyId: "key-12345678",
};
const payload = {
  formVersion: 1,
  answers: { field: "secret" },
  submittedAt: "2026-07-21T12:00:00.000Z",
};
const mutate = (value: string) =>
  `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;

describe("response envelope", () => {
  it("round trips using exported public key and browser-bound private key", async () => {
    const creator = await generateResponseKeyPair(false);
    const publicKey = await importPublicKey(
      await exportPublicKey(creator.publicKey),
    );
    const envelope = await encryptResponse(
      payload,
      publicKey,
      context,
      "submission_123456",
    );
    await expect(
      decryptResponse(envelope, creator.privateKey, context),
    ).resolves.toEqual(payload);
    expect(envelope.version).toBe(2);
  });
  it("fails closed when ciphertext or authenticated context is modified", async () => {
    const creator = await generateResponseKeyPair(false);
    const envelope = await encryptResponse(payload, creator.publicKey, context);
    const tampered = { ...envelope, ciphertext: mutate(envelope.ciphertext) };
    await expect(
      decryptResponse(tampered, creator.privateKey, context),
    ).rejects.toThrow();
    await expect(
      decryptResponse(envelope, creator.privateKey, {
        ...context,
        schemaHash: "other",
      }),
    ).rejects.toThrow();
    for (const changedContext of [
      { ...context, formId: "other-form" },
      { ...context, keyId: "other-key-123456" },
      { ...context, schemaVersion: 2 },
    ]) {
      await expect(
        decryptResponse(envelope, creator.privateKey, changedContext),
      ).rejects.toThrow();
    }
    await expect(
      decryptResponse(
        { ...envelope, nonce: mutate(envelope.nonce) },
        creator.privateKey,
        context,
      ),
    ).rejects.toThrow();
    await expect(
      decryptResponse(
        { ...envelope, salt: mutate(envelope.salt) },
        creator.privateKey,
        context,
      ),
    ).rejects.toThrow();
    await expect(
      decryptResponse(
        {
          ...envelope,
          ephemeralPublicKey: mutate(envelope.ephemeralPublicKey),
        },
        creator.privateKey,
        context,
      ),
    ).rejects.toThrow();
    await expect(
      decryptResponse({ ...envelope, version: 1 }, creator.privateKey, context),
    ).rejects.toThrow();
  });
  it("fails closed when a version 2 submission ID is modified", async () => {
    const creator = await generateResponseKeyPair(false);
    const envelope = await encryptResponse(
      payload,
      creator.publicKey,
      context,
      "submission_123456",
    );
    await expect(
      decryptResponse(
        { ...envelope, submissionId: "submission_654321" },
        creator.privateKey,
        context,
      ),
    ).rejects.toThrow();
  });
  it("rejects malformed or incorrectly sized envelope encodings", async () => {
    const creator = await generateResponseKeyPair(false);
    const envelope = await encryptResponse(payload, creator.publicKey, context);
    expect(
      responseEnvelopeSchema.safeParse({ ...envelope, salt: "not+base64" })
        .success,
    ).toBe(false);
    expect(
      responseEnvelopeSchema.safeParse({ ...envelope, nonce: "AA" }).success,
    ).toBe(false);
    expect(
      responseEnvelopeSchema.safeParse({ ...envelope, ciphertext: "AA" })
        .success,
    ).toBe(false);
  });
  it("keeps new encrypted responses within the serialized envelope budget", async () => {
    const creator = await generateResponseKeyPair(false);
    const answers = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`field_${index}`, ""]),
    );
    const sizedPayload = { ...payload, answers };
    let remaining =
      FORM_LIMITS.maxResponsePlaintextBytes -
      responsePayloadByteLength(sizedPayload);
    for (const key of Object.keys(answers)) {
      const length = Math.min(FORM_LIMITS.maxLongTextLength, remaining);
      answers[key] = "x".repeat(length);
      remaining -= length;
    }
    expect(remaining).toBe(0);
    const envelope = await encryptResponse(
      sizedPayload,
      creator.publicKey,
      context,
    );
    expect(
      new TextEncoder().encode(JSON.stringify(envelope)).byteLength,
    ).toBeLessThanOrEqual(FORM_LIMITS.maxSerializedResponseBytes);
    const finalKey = Object.keys(answers).at(-1)!;
    answers[finalKey] += "x";
    await expect(
      encryptResponse(sizedPayload, creator.publicKey, context),
    ).rejects.toThrow(/total answer limit/u);
  });
  it("decrypts the documented version 2 interoperability vector", async () => {
    const creatorPrivateKey = await crypto.subtle.importKey(
      "jwk",
      {
        key_ops: ["deriveBits"],
        ext: true,
        kty: "EC",
        x: "xLMIXvJO_C5jESVgOnVpxtknysxezU2YDixyRYp5rKA",
        y: "I_L6l5_uFyj6fSxDIrMDb7ND0dZt8QHJ2Xbws4TXXN0",
        crv: "P-256",
        d: "OTBXo0YqDpwWQL_sr7kCMgs2nJLqiQdNkviSs09hA9A",
      },
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    await expect(
      decryptResponse(
        {
          version: 2,
          keyId: "YBFWQF0NUjcgEdpTY1Oang",
          ephemeralPublicKey:
            "BO8mSWEu_ZuQ-Q5XxcX5ckSX8V5k0UWBlL5GB4irrt8lYooylx9fME5QCkrOBxzFQp7_EXX04fOjvl2nc_Jpquc",
          salt: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
          nonce: "oKGio6Slpqeoqaqr",
          ciphertext:
            "wGHwOx68d5IeHDdTyxkYpGjCiyBJCp6qzDnOctlqZ1LZpmDQhb3CjakaQSFpcm-h1u-7fIYHQAg4U1kF1o1YIZNXSyt-q7smJT7QDt044b844zLEdL9OvsYiGwpsQ9CNS-IqBqfBaJehMxWU2e85JQ",
          submissionId: "AAECAwQFBgcICQoLDA0ODw",
        },
        creatorPrivateKey,
        {
          formId: "test-form",
          keyId: "YBFWQF0NUjcgEdpTY1Oang",
          schemaHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          schemaVersion: 1,
        },
      ),
    ).resolves.toEqual({
      answers: { email: "ada@example.com" },
      formVersion: 1,
      submittedAt: "2026-07-21T00:00:00.000Z",
    });
  });
  it("cannot decrypt with another creator key", async () => {
    const creator = await generateResponseKeyPair(false);
    const attacker = await generateResponseKeyPair(false);
    const envelope = await encryptResponse(payload, creator.publicKey, context);
    await expect(
      decryptResponse(envelope, attacker.privateKey, context),
    ).rejects.toThrow();
  });
});
