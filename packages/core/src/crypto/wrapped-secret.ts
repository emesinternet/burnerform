import { z } from "zod";

import { decodeBase64Url } from "./encoding";

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

export const argonKdfSchema = z
  .object({
    name: z.literal("argon2id"),
    version: z.literal(1),
    memoryKiB: z.literal(19_456),
    passes: z.literal(2),
    parallelism: z.literal(1),
    tagLength: z.literal(32),
    salt: base64UrlBytes(16, "Argon2 salt"),
  })
  .strict();

export const wrappedSecretSchema = z
  .object({
    version: z.literal(1),
    kdf: argonKdfSchema,
    cipher: z
      .object({
        name: z.literal("AES-256-GCM"),
        nonce: base64UrlBytes(12, "AES-GCM nonce"),
        ciphertext: z.string().superRefine((value, context) => {
          try {
            const length = decodeBase64Url(value).byteLength;
            if (length < 16 || length > 512 * 1024)
              context.addIssue({
                code: "custom",
                message: "Wrapped ciphertext has invalid length",
              });
          } catch {
            context.addIssue({
              code: "custom",
              message: "Wrapped ciphertext is not base64url",
            });
          }
        }),
      })
      .strict(),
  })
  .strict();

export type WrappedSecret = z.infer<typeof wrappedSecretSchema>;
