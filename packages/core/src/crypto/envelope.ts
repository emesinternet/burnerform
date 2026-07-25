import { z } from "zod";
import {
  FORM_LIMITS,
  assertSafeObjectGraph,
  canonicalJson,
} from "../form-schema";
import {
  asArrayBuffer,
  decodeBase64Url,
  encodeBase64Url,
  randomBytes,
  utf8,
  utf8Decoder,
} from "./encoding";

function base64UrlBytes(length: number, label: string) {
  return z.string().superRefine((value, context) => {
    try {
      if (decodeBase64Url(value).byteLength !== length)
        context.addIssue({
          code: "custom",
          message: `${label} has invalid length`,
        });
    } catch {
      context.addIssue({
        code: "custom",
        message: `${label} is not base64url`,
      });
    }
  });
}

function boundedBase64UrlBytes(
  minimum: number,
  maximum: number,
  label: string,
) {
  return z.string().superRefine((value, context) => {
    try {
      const length = decodeBase64Url(value).byteLength;
      if (length < minimum || length > maximum)
        context.addIssue({
          code: "custom",
          message: `${label} has invalid length`,
        });
    } catch {
      context.addIssue({
        code: "custom",
        message: `${label} is not base64url`,
      });
    }
  });
}

export const responseEnvelopeSchema = z
  .object({
    version: z.literal(2),
    keyId: z.string().min(8).max(128),
    ephemeralPublicKey: base64UrlBytes(65, "Ephemeral public key"),
    salt: base64UrlBytes(32, "HKDF salt"),
    nonce: base64UrlBytes(12, "AES-GCM nonce"),
    ciphertext: boundedBase64UrlBytes(
      16,
      FORM_LIMITS.maxCiphertextBytes,
      "Ciphertext",
    ),
    submissionId: z.string().min(16).max(64),
  })
  .strict();
export const responseEnvelopeV2Schema = responseEnvelopeSchema;
export type ResponseEnvelope = z.infer<typeof responseEnvelopeSchema>;

export interface EnvelopeContext {
  formId: string;
  schemaHash: string;
  schemaVersion: number;
  keyId: string;
}
export interface ResponsePayload {
  formVersion: number;
  answers: Record<string, string | number | boolean | string[] | null>;
  submittedAt: string;
}

const answerValueSchema = z.union([
  z.string().max(FORM_LIMITS.maxAnswerLength),
  z.number().finite(),
  z.boolean(),
  z
    .array(z.string().max(FORM_LIMITS.maxAnswerLength))
    .max(FORM_LIMITS.maxMatrixAnswers),
  z.null(),
]);
export const responsePayloadSchema = z
  .object({
    formVersion: z.number().int().positive(),
    answers: z.record(z.string().min(1).max(64), answerValueSchema),
    submittedAt: z.iso.datetime(),
  })
  .strict();

export function responsePayloadByteLength(payload: ResponsePayload): number {
  return utf8.encode(canonicalJson(responsePayloadSchema.parse(payload)))
    .byteLength;
}

function aad(context: EnvelopeContext, submissionId: string): Uint8Array {
  return utf8.encode(
    canonicalJson({
      envelopeVersion: 2,
      formId: context.formId,
      keyId: context.keyId,
      schemaHash: context.schemaHash,
      schemaVersion: context.schemaVersion,
      submissionId,
    }),
  );
}

export async function generateResponseKeyPair(
  extractable = false,
): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    extractable,
    ["deriveBits"],
  );
}

async function deriveAesKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  salt: Uint8Array,
  context: EnvelopeContext,
  submissionId: string,
): Promise<CryptoKey> {
  const secret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256,
  );
  const hkdf = await crypto.subtle.importKey("raw", secret, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: asArrayBuffer(salt),
      info: asArrayBuffer(aad(context, submissionId)),
    },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptResponse(
  payload: ResponsePayload,
  creatorPublicKey: CryptoKey,
  context: EnvelopeContext,
  submissionId = encodeBase64Url(randomBytes(16)),
): Promise<ResponseEnvelope> {
  const envelopeVersion = 2;
  const ephemeral = await generateResponseKeyPair(false);
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const aesKey = await deriveAesKey(
    ephemeral.privateKey,
    creatorPublicKey,
    salt,
    context,
    submissionId,
  );
  const parsedPayload = responsePayloadSchema.parse(payload);
  const plaintext = utf8.encode(canonicalJson(parsedPayload));
  if (plaintext.byteLength > FORM_LIMITS.maxResponsePlaintextBytes)
    throw new Error("Response exceeds the total answer limit");
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(nonce),
      additionalData: asArrayBuffer(aad(context, submissionId)),
      tagLength: 128,
    },
    aesKey,
    asArrayBuffer(plaintext),
  );
  const publicBytes = await crypto.subtle.exportKey("raw", ephemeral.publicKey);
  return responseEnvelopeSchema.parse({
    version: envelopeVersion,
    keyId: context.keyId,
    ephemeralPublicKey: encodeBase64Url(new Uint8Array(publicBytes)),
    salt: encodeBase64Url(salt),
    nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
    submissionId,
  });
}

export async function decryptResponse(
  envelopeInput: unknown,
  creatorPrivateKey: CryptoKey,
  context: EnvelopeContext,
): Promise<ResponsePayload> {
  const envelope = responseEnvelopeSchema.parse(envelopeInput);
  if (envelope.keyId !== context.keyId)
    throw new Error("Envelope key does not match context");
  const ephemeralPublicKey = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(decodeBase64Url(envelope.ephemeralPublicKey)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const aesKey = await deriveAesKey(
    creatorPrivateKey,
    ephemeralPublicKey,
    decodeBase64Url(envelope.salt),
    context,
    envelope.submissionId,
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(decodeBase64Url(envelope.nonce)),
      additionalData: asArrayBuffer(aad(context, envelope.submissionId)),
      tagLength: 128,
    },
    aesKey,
    asArrayBuffer(decodeBase64Url(envelope.ciphertext)),
  );
  const parsed: unknown = JSON.parse(utf8Decoder.decode(plaintext));
  assertSafeObjectGraph(parsed);
  return responsePayloadSchema.parse(parsed);
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.exportKey("raw", key)),
  );
}
export async function importPublicKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    asArrayBuffer(decodeBase64Url(value)),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
}
