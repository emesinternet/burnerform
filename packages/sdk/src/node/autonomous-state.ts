import { z } from "zod";
import { formSchema } from "@burnerform/core/form-schema";
import { encodeBase64Url, randomBytes } from "@burnerform/core/crypto";

export const aliasSchema = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/u);
export const registryEntrySchema = z
  .object({
    alias: aliasSchema,
    formId: z.string().min(16).max(64),
    keyId: z.string().min(16).max(64),
    responsePasswordSecret: z.string().min(1).max(128),
    publicPasswordSecret: z.string().min(1).max(128).optional(),
    recoveryFileName: z
      .string()
      .regex(/^[a-z][a-z0-9-]{2,63}\.recovery\.json$/u),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type RegistryEntry = z.infer<typeof registryEntrySchema>;
export const registrySchema = z.array(registryEntrySchema).max(10_000);

export const draftSchema = z
  .object({
    alias: aliasSchema,
    schema: formSchema,
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type DraftEntry = z.infer<typeof draftSchema>;
export const draftsSchema = z.array(draftSchema).max(1_000);

export function safeAlias(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 54);
  const withPrefix = /^[a-z]/u.test(normalized)
    ? normalized
    : `form-${normalized}`;
  return aliasSchema.parse(
    withPrefix.length >= 3
      ? withPrefix
      : `form-${encodeBase64Url(randomBytes(4)).toLowerCase()}`,
  );
}

export function secretName(alias: string, kind: "response" | "public") {
  return `form:${alias}:${kind}`;
}
