import { z } from "zod";

import { wrappedSecretSchema } from "@burnerform/core/crypto/wrapped-secret";
import { formIdSchema } from "@burnerform/core/contracts/responses";

import type { CreatorCustodyRecord } from "./types";

const cryptoKeySchema = z.custom<CryptoKey>(
  (value) =>
    typeof CryptoKey !== "undefined" &&
    value instanceof CryptoKey &&
    value.type === "private" &&
    value.algorithm.name === "ECDH",
  "Private key is invalid",
);
const common = {
  version: z.literal(1),
  formId: formIdSchema,
  keyId: z.string().min(8).max(128),
  publicKey: z.string().min(80).max(128),
};

export const creatorCustodyRecordSchema: z.ZodType<CreatorCustodyRecord> =
  z.discriminatedUnion("mode", [
    z
      .object({
        ...common,
        mode: z.literal("creator_only"),
        privateKey: cryptoKeySchema,
        managementKey: z.string().min(40).max(128),
      })
      .strict(),
    z
      .object({
        ...common,
        mode: z.literal("creator_password"),
        wrappedLocalCustody: wrappedSecretSchema,
      })
      .strict(),
    z
      .object({
        ...common,
        mode: z.literal("shared_password"),
        managementKey: z.string().min(40).max(128),
        wrappedResponseKey: wrappedSecretSchema,
      })
      .strict(),
  ]);
