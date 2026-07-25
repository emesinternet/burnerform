import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { apiV1PublicFormResponseSchema } from "@burnerform/core/contracts/api-v1";
import {
  decryptResponse,
  generateResponseKeyPair,
  responseEnvelopeSchema,
  responsePayloadSchema,
  unwrapSecret,
  wrappedSecretSchema,
} from "@burnerform/core/crypto";
import { normalizeAnswers } from "@burnerform/core/form-schema";

const privateJwkSchema = z.object({
  key_ops: z.array(z.string()),
  ext: z.boolean(),
  kty: z.literal("EC"),
  x: z.string(),
  y: z.string(),
  crv: z.literal("P-256"),
  d: z.string(),
});
const vectorSchema = z
  .object({
    name: z.string(),
    producer: z.enum(["browser", "node"]),
    creatorPrivateKeyJwk: privateJwkSchema,
    creatorPublicKey: z.string(),
    context: z.object({
      formId: z.string(),
      keyId: z.string(),
      schemaHash: z.string(),
      schemaVersion: z.number().int().positive(),
    }),
    envelope: responseEnvelopeSchema,
    payload: responsePayloadSchema,
  })
  .strict();
const publicFormFixtureSchema = z
  .object({
    available: apiV1PublicFormResponseSchema,
    protected: apiV1PublicFormResponseSchema,
    validAnswers: z.record(z.string(), z.unknown()),
    invalidAnswers: z.record(z.string(), z.unknown()),
  })
  .strict();
const passwordFixtureSchema = z
  .object({
    name: z.string(),
    password: z.string(),
    wrongPassword: z.string(),
    plaintext: z.string(),
    wrapped: wrappedSecretSchema,
  })
  .strict();

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(path.resolve("conformance", file), "utf8"));
}

async function checkEnvelope(file: string) {
  const vector = vectorSchema.parse(await readJson(file));
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    vector.creatorPrivateKeyJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const decrypted = await decryptResponse(
    vector.envelope,
    privateKey,
    vector.context,
  );
  if (JSON.stringify(decrypted) !== JSON.stringify(vector.payload))
    throw new Error(`${vector.name} did not produce the expected payload.`);

  const tampered = {
    ...vector.envelope,
    ciphertext: `${vector.envelope.ciphertext[0] === "A" ? "B" : "A"}${vector.envelope.ciphertext.slice(1)}`,
  };
  await expectFailure(
    () => decryptResponse(tampered, privateKey, vector.context),
    `${vector.producer} tampered ciphertext`,
  );
  for (const context of [
    { ...vector.context, formId: "wrong-form" },
    { ...vector.context, schemaHash: "wrong-schema-hash" },
    { ...vector.context, schemaVersion: vector.context.schemaVersion + 1 },
    { ...vector.context, keyId: "wrong-key-id" },
  ])
    await expectFailure(
      () => decryptResponse(vector.envelope, privateKey, context),
      `${vector.producer} associated-data tamper`,
    );

  const wrongKey = await generateResponseKeyPair();
  await expectFailure(
    () => decryptResponse(vector.envelope, wrongKey.privateKey, vector.context),
    `${vector.producer} wrong creator key`,
  );
  process.stdout.write(`${vector.name}: pass\n`);
}

async function checkPublicForm() {
  const fixture = publicFormFixtureSchema.parse(
    await readJson("public-form-v1.json"),
  );
  if (fixture.available.passwordRequired)
    throw new Error("Available public-form fixture requires a password.");
  if (!fixture.protected.passwordRequired)
    throw new Error("Protected public-form fixture is not protected.");
  normalizeAnswers(fixture.available.schema, fixture.validAnswers);
  try {
    normalizeAnswers(fixture.available.schema, fixture.invalidAnswers);
  } catch {
    process.stdout.write("Burnerform public form v1: pass\n");
    return;
  }
  throw new Error("Invalid public-form answers were accepted.");
}

async function checkPasswordWrap() {
  const fixture = passwordFixtureSchema.parse(
    await readJson("password-wrap-v1.json"),
  );
  const plaintext = await unwrapSecret(fixture.wrapped, fixture.password);
  try {
    if (new TextDecoder().decode(plaintext) !== fixture.plaintext)
      throw new Error(`${fixture.name} produced the wrong plaintext.`);
  } finally {
    plaintext.fill(0);
  }
  await expectFailure(
    () => unwrapSecret(fixture.wrapped, fixture.wrongPassword),
    "wrong password",
  );
  process.stdout.write(`${fixture.name}: pass\n`);
}

async function main() {
  await checkEnvelope("response-envelope-v2.json");
  await checkEnvelope("response-envelope-v2-node.json");
  await checkPublicForm();
  await checkPasswordWrap();
}

async function expectFailure(run: () => Promise<unknown>, label: string) {
  try {
    await run();
  } catch {
    return;
  }
  throw new Error(`The ${label} vector was accepted.`);
}

void main();
