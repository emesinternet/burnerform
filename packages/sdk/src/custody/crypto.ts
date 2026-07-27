import { z } from "zod";

import {
  asArrayBuffer,
  decodeBase64Url,
  encodeBase64Url,
  randomBytes,
} from "@burnerform/core/crypto/encoding";
import {
  exportPublicKey,
  generateResponseKeyPair,
} from "@burnerform/core/crypto/envelope";
import { unwrapJson, wrapJson } from "@burnerform/core/crypto/password-wrap";
import {
  wrappedSecretSchema,
  type WrappedSecret,
} from "@burnerform/core/crypto/wrapped-secret";
import type {
  CreatorCustodyRecord,
  RecoveryFile,
  ResponseAccessMode,
  SharedPasswordRecord,
  UnlockedCustody,
} from "./types";
import type { CustodyStore } from "./store";
import { creatorCustodyRecordSchema } from "./validation";

interface PortableCustody {
  privateKeyPkcs8: string;
  managementKey?: string;
  recoveryMetadata?: {
    formId: string;
    keyId: string;
    publicKey: string;
    createdAt: string;
  };
}
const portableCustodySchema = z
  .object({
    privateKeyPkcs8: z.string().min(1).max(1024),
    managementKey: z.string().min(40).max(128).optional(),
    recoveryMetadata: z
      .object({
        formId: z.string().min(1).max(64),
        keyId: z.string().min(1).max(128),
        publicKey: z.string().min(80).max(128),
        createdAt: z.iso.datetime(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const recoveryFileSchema = z
  .object({
    format: z.literal("burnerform-recovery"),
    version: z.literal(1),
    formId: z.string().min(1).max(64),
    keyId: z.string().min(1).max(64),
    publicKey: z.string().min(1).max(128),
    createdAt: z.iso.datetime(),
    wrappedCustody: wrappedSecretSchema,
  })
  .strict();
export interface ProvisionOptions {
  formId: string;
  keyId: string;
  mode: ResponseAccessMode;
  password?: string;
  recoveryPassword?: string;
  store: CustodyStore;
}
export interface ProvisionResult {
  publicKey: string;
  managementKey: string;
  wrappedResponseKey?: WrappedSecret;
  recoveryFile?: RecoveryFile;
}
export interface BoundCustody {
  record: CreatorCustodyRecord;
  recoveryFile?: RecoveryFile;
}

async function exportPrivate(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("pkcs8", key));
}
async function importPrivate(
  bytes: Uint8Array,
  extractable = false,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    asArrayBuffer(bytes),
    { name: "ECDH", namedCurve: "P-256" },
    extractable,
    ["deriveBits"],
  );
}
function createManagementKey(): string {
  return encodeBase64Url(randomBytes(32));
}

async function portable(
  privateKey: CryptoKey,
  managementKey?: string,
): Promise<{ value: PortableCustody; bytes: Uint8Array }> {
  const bytes = await exportPrivate(privateKey);
  return {
    value: { privateKeyPkcs8: encodeBase64Url(bytes), managementKey },
    bytes,
  };
}

export async function provisionCreatorCustody(
  options: ProvisionOptions,
): Promise<ProvisionResult> {
  const requiresExtractable =
    options.mode !== "creator_only" || Boolean(options.recoveryPassword);
  const pair = await generateResponseKeyPair(requiresExtractable);
  const publicKey = await exportPublicKey(pair.publicKey);
  const managementKey = createManagementKey();
  let recoveryFile: RecoveryFile | undefined;
  let record: CreatorCustodyRecord;

  if (options.mode === "creator_only" && !requiresExtractable) {
    record = {
      version: 1,
      mode: options.mode,
      formId: options.formId,
      keyId: options.keyId,
      publicKey,
      privateKey: pair.privateKey,
      managementKey,
    };
  } else {
    const exported = await portable(pair.privateKey, managementKey);
    try {
      if (options.recoveryPassword) {
        const createdAt = new Date().toISOString();
        recoveryFile = {
          format: "burnerform-recovery",
          version: 1,
          formId: options.formId,
          keyId: options.keyId,
          publicKey,
          createdAt,
          wrappedCustody: await wrapJson(
            {
              ...exported.value,
              recoveryMetadata: {
                formId: options.formId,
                keyId: options.keyId,
                publicKey,
                createdAt,
              },
            },
            options.recoveryPassword,
          ),
        };
      }
      if (options.mode === "creator_only") {
        const privateKey = await importPrivate(exported.bytes, false);
        record = {
          version: 1,
          mode: options.mode,
          formId: options.formId,
          keyId: options.keyId,
          publicKey,
          privateKey,
          managementKey,
        };
      } else if (options.mode === "creator_password") {
        if (!options.password) throw new Error("Creator password is required");
        record = {
          version: 1,
          mode: options.mode,
          formId: options.formId,
          keyId: options.keyId,
          publicKey,
          wrappedLocalCustody: await wrapJson(exported.value, options.password),
        };
      } else {
        if (!options.password)
          throw new Error("Shared response password is required");
        const wrappedResponseKey = await wrapJson(
          { privateKeyPkcs8: exported.value.privateKeyPkcs8 },
          options.password,
        );
        record = {
          version: 1,
          mode: options.mode,
          formId: options.formId,
          keyId: options.keyId,
          publicKey,
          managementKey,
          wrappedResponseKey,
        };
      }
    } finally {
      exported.bytes.fill(0);
    }
  }
  await options.store.put(record);
  return {
    publicKey,
    managementKey,
    wrappedResponseKey:
      record.mode === "shared_password" ? record.wrappedResponseKey : undefined,
    recoveryFile,
  };
}

export async function bindCreatorCustody(
  record: CreatorCustodyRecord,
  recoveryFile: RecoveryFile | undefined,
  recoveryPassword: string | undefined,
  formId: string,
  store: CustodyStore,
): Promise<BoundCustody> {
  const boundRecord = creatorCustodyRecordSchema.parse({ ...record, formId });
  let boundRecoveryFile: RecoveryFile | undefined;

  if (recoveryFile) {
    if (!recoveryPassword) throw new Error("Recovery password is required");
    const source = recoveryFileSchema.parse(recoveryFile);
    const value = portableCustodySchema.parse(
      await unwrapJson<unknown>(source.wrappedCustody, recoveryPassword),
    );
    if (value.recoveryMetadata) {
      const expected = canonicalRecoveryMetadata(source);
      if (JSON.stringify(value.recoveryMetadata) !== JSON.stringify(expected))
        throw new Error("Recovery metadata failed authentication");
    }
    boundRecoveryFile = {
      ...source,
      formId,
      wrappedCustody: await wrapJson(
        {
          ...value,
          recoveryMetadata: {
            formId,
            keyId: source.keyId,
            publicKey: source.publicKey,
            createdAt: source.createdAt,
          },
        },
        recoveryPassword,
      ),
    };
  }

  await store.put(boundRecord);
  return { record: boundRecord, recoveryFile: boundRecoveryFile };
}

async function unlockPortable(
  wrapped: WrappedSecret,
  password: string,
  lifecycleAccess: boolean,
): Promise<UnlockedCustody> {
  const value = portableCustodySchema.parse(
    await unwrapJson<unknown>(wrapped, password),
  );
  const bytes = decodeBase64Url(value.privateKeyPkcs8);
  try {
    return {
      privateKey: await importPrivate(bytes),
      managementKey: value.managementKey,
      lifecycleAccess,
    };
  } finally {
    bytes.fill(0);
  }
}

export async function unlockCreator(
  record: CreatorCustodyRecord,
  password?: string,
): Promise<UnlockedCustody> {
  if (record.mode === "creator_only")
    return {
      privateKey: record.privateKey,
      managementKey: record.managementKey,
      lifecycleAccess: true,
    };
  if (!password) throw new Error("Password is required");
  if (record.mode === "creator_password")
    return unlockPortable(record.wrappedLocalCustody, password, true);
  const unlocked = await unlockPortable(
    record.wrappedResponseKey,
    password,
    false,
  );
  return {
    ...unlocked,
    managementKey: record.managementKey,
    lifecycleAccess: true,
  };
}

export async function unlockSharedReader(
  wrapped: WrappedSecret,
  password: string,
): Promise<UnlockedCustody> {
  return unlockPortable(wrapped, password, false);
}

export async function persistRotatedSharedKey(
  store: CustodyStore,
  record: SharedPasswordRecord,
  wrappedResponseKey: WrappedSecret,
): Promise<SharedPasswordRecord> {
  const updated = { ...record, wrappedResponseKey };
  await store.put(updated);
  return updated;
}

export async function unlockRecoveryFile(
  fileInput: RecoveryFile,
  password: string,
): Promise<UnlockedCustody> {
  const file = recoveryFileSchema.parse(fileInput);
  const value = portableCustodySchema.parse(
    await unwrapJson<unknown>(file.wrappedCustody, password),
  );
  if (value.recoveryMetadata) {
    const expected = canonicalRecoveryMetadata(file);
    if (JSON.stringify(value.recoveryMetadata) !== JSON.stringify(expected))
      throw new Error("Recovery metadata failed authentication");
  }
  const bytes = decodeBase64Url(value.privateKeyPkcs8);
  try {
    return {
      privateKey: await importPrivate(bytes),
      managementKey: value.managementKey,
      lifecycleAccess: true,
    };
  } finally {
    bytes.fill(0);
  }
}

function canonicalRecoveryMetadata(file: RecoveryFile) {
  return {
    formId: file.formId,
    keyId: file.keyId,
    publicKey: file.publicKey,
    createdAt: file.createdAt,
  };
}

export async function restoreRecoveryFile(
  fileInput: unknown,
  password: string,
  store: CustodyStore,
  expectedFormId: string,
): Promise<{ record: CreatorCustodyRecord; access: UnlockedCustody }> {
  const file = recoveryFileSchema.parse(fileInput);
  if (file.formId !== expectedFormId)
    throw new Error("Recovery file belongs to another form");
  const access = await unlockRecoveryFile(file, password);
  if (!access.managementKey)
    throw new Error("Recovery file has no management key");
  const record: CreatorCustodyRecord = {
    version: 1,
    mode: "creator_only",
    formId: file.formId,
    keyId: file.keyId,
    publicKey: file.publicKey,
    privateKey: access.privateKey,
    managementKey: access.managementKey,
  };
  await store.put(record);
  return { record, access };
}

export async function restoreRecoveryFileForDurableAgent(
  fileInput: unknown,
  password: string,
  store: CustodyStore,
): Promise<{ record: CreatorCustodyRecord; access: UnlockedCustody }> {
  const file = recoveryFileSchema.parse(fileInput);
  const access = await unlockRecoveryFile(file, password);
  if (!access.managementKey)
    throw new Error("Recovery file has no management key");
  const record: CreatorCustodyRecord = {
    version: 1,
    mode: "creator_password",
    formId: file.formId,
    keyId: file.keyId,
    publicKey: file.publicKey,
    wrappedLocalCustody: file.wrappedCustody,
  };
  await store.put(record);
  return { record, access };
}

export function serializeRecoveryFile(file: RecoveryFile): string {
  return JSON.stringify(file, null, 2);
}
