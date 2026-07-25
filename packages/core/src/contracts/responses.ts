import { z } from "zod";

import { responseEnvelopeSchema } from "../crypto/envelope";
import { decodeBase64Url } from "../crypto/encoding";
import { wrappedSecretSchema } from "../crypto/wrapped-secret";
import { formSchema } from "../form-schema";

export const formIdSchema = z.string().refine((value) => {
  if (/^[0-9a-f]{32}$/iu.test(value)) return true;
  try {
    return decodeBase64Url(value).byteLength === 16;
  } catch {
    return false;
  }
}, "Form ID is invalid");

const keyIdSchema = z.string().min(8).max(128);
const publicKeySchema = z
  .object({
    format: z.literal("raw-p256"),
    value: z.string().min(80).max(128),
    keyId: keyIdSchema,
  })
  .strict();

export const publicFormResponseSchema = z
  .object({
    passwordRequired: z.literal(false),
    formId: formIdSchema,
    schemaVersion: z.number().int().positive(),
    schema: formSchema,
    schemaHash: z.string().min(16).max(128),
    keyId: keyIdSchema,
    creatorPublicKey: publicKeySchema,
    maxResponseBytes: z.number().int().positive(),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.schema.version !== value.schemaVersion)
      context.addIssue({ code: "custom", message: "Schema version mismatch" });
    if (value.creatorPublicKey.keyId !== value.keyId)
      context.addIssue({ code: "custom", message: "Key ID mismatch" });
  });
export type PublicFormResponse = z.infer<typeof publicFormResponseSchema>;

export const passwordRequiredResponseSchema = z
  .object({ passwordRequired: z.literal(true) })
  .strict();

export const managementOverviewSchema = z
  .object({
    title: z.string().min(1).max(120),
    status: z.enum(["open", "quota_exhausted"]),
    responseAccessMode: z.enum([
      "creator_only",
      "creator_password",
      "shared_password",
    ]),
    respondentPasswordRequired: z.boolean(),
    responseCount: z.number().int().nonnegative(),
    maxResponses: z.number().int().positive(),
    storedResponseBytes: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    schema: formSchema,
    schemaHash: z.string().min(16).max(128),
    keyId: keyIdSchema,
  })
  .strict();
export type ManagementOverview = z.infer<typeof managementOverviewSchema>;

export const responsePageSchema = z
  .object({
    responses: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            envelopeVersion: z.literal(2),
            envelope: responseEnvelopeSchema,
            receivedAt: z.iso.datetime(),
            ciphertextBytes: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(200),
    nextCursor: z.string().max(256).nullable(),
  })
  .strict();
export type ResponsePage = z.infer<typeof responsePageSchema>;

export const sharedReaderResponseSchema = z
  .object({
    token: z.string().min(1).max(4096),
    expiresAt: z.number().int().positive(),
    wrappedResponsePrivateKey: wrappedSecretSchema,
    schema: formSchema,
    schemaHash: z.string().min(16).max(128),
    keyId: keyIdSchema,
    responseCount: z.number().int().nonnegative(),
    maxResponses: z.number().int().positive(),
    formExpiresAt: z.iso.datetime(),
  })
  .strict();

export const createdSessionSchema = z
  .object({
    formId: formIdSchema,
    expiresAt: z.iso.datetime().optional(),
    recoveryFile: z
      .object({
        format: z.literal("burnerform-recovery"),
        version: z.literal(1),
        formId: formIdSchema,
        keyId: keyIdSchema,
        publicKey: z.string().min(80).max(128),
        createdAt: z.iso.datetime(),
        wrappedCustody: wrappedSecretSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.recoveryFile && value.recoveryFile.formId !== value.formId)
      context.addIssue({
        code: "custom",
        message: "Recovery file belongs to another form",
      });
  });
export type CreatedSession = z.infer<typeof createdSessionSchema>;
