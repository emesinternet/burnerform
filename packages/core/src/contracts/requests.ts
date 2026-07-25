import { z } from "zod";
import { decodeBase64Url, responseEnvelopeV2Schema } from "../crypto";
import { wrappedSecretSchema } from "../crypto/password-wrap";
import { formSchema } from "../form-schema";

export { formSchema as publicFormSchema };
export type CreateFormRequest = z.infer<typeof createFormRequest>;

export const random128IdSchema = z.string().refine((value) => {
  if (
    /^[0-9a-f]{32}$/iu.test(value) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  )
    return true;
  try {
    return decodeBase64Url(value).byteLength === 16;
  } catch {
    return false;
  }
}, "ID must encode 128 random bits");
export const managementKeySchema = z.string().refine((value) => {
  try {
    return decodeBase64Url(value).byteLength === 32;
  } catch {
    return false;
  }
}, "Management key must encode 256 random bits");
const creatorPublicKey = z
  .object({
    format: z.literal("raw-p256"),
    value: z.string().min(80).max(128),
    keyId: random128IdSchema,
  })
  .strict();

export const createFormRequest = z
  .object({
    formId: random128IdSchema,
    idempotencyKey: z.string().uuid(),
    schema: formSchema,
    creatorPublicKey,
    managementKey: managementKeySchema,
    responseAccessMode: z.enum([
      "shared_password",
      "creator_password",
      "creator_only",
    ]),
    wrappedResponsePrivateKey: wrappedSecretSchema.optional(),
    responsePassword: z.string().min(12).max(256).optional(),
    respondentPassword: z.string().min(12).max(256).optional(),
    expiresAt: z.iso.datetime(),
    maxResponses: z.number().int().min(1).max(10_000),
    maxResponseBytes: z.number().int().min(1024).max(1_048_576),
  })
  .strict()
  .superRefine((value, context) => {
    const shared = value.responseAccessMode === "shared_password";
    const hasSharedCustody = Boolean(
      value.wrappedResponsePrivateKey && value.responsePassword,
    );
    if (shared !== hasSharedCustody) {
      context.addIssue({
        code: "custom",
        message: "Shared mode requires a wrapped key and response password",
      });
    }
    if (
      !shared &&
      (value.wrappedResponsePrivateKey !== undefined ||
        value.responsePassword !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Creator-only custody must remain in the browser",
      });
    }
  });

export const envelopeSchema = responseEnvelopeV2Schema.and(
  z.object({ submissionId: random128IdSchema }),
);
export const submitResponseRequest = z
  .object({ envelope: envelopeSchema })
  .strict();
export const queryResponsesRequest = z
  .object({
    cursor: z.string().max(256).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();
export const expirationRequest = z
  .object({ expiresAt: z.iso.datetime(), idempotencyKey: z.string().uuid() })
  .strict();
export const responseLimitRequest = z
  .object({
    maxResponses: z.number().int().min(1).max(10_000),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export const respondentAccessUpdateRequest = z
  .object({
    password: z.string().min(12).max(256).nullable(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export const passwordRequest = z
  .object({ password: z.string().min(1).max(256) })
  .strict();
export const rotateResponsePasswordRequest = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(12).max(256),
    wrappedResponsePrivateKey: wrappedSecretSchema,
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export const burnRequest = z
  .object({
    confirmation: z.string().min(1).max(160),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
