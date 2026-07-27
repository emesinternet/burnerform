import { readFile } from "node:fs/promises";
import path from "node:path";
import { FORM_LIMITS, type FormSchema } from "@burnerform/core/form-schema";
import { encodeBase64Url, randomBytes } from "@burnerform/core/crypto";
import { createFormRequest } from "@burnerform/core/contracts/requests";
import {
  bindCreatorCustody,
  MemoryCustodyStore,
  provisionCreatorCustody,
  serializeRecoveryFile,
  unlockRecoveryFile,
  type SecretProvider,
} from "../custody";
import type { BurnerformClient, BurnerformRequestOptions } from "../client";
import { writePrivateFile } from "./atomic-file";
import type { EncryptedFileCustodyStore } from "./file-custody-store";
import {
  preparedPublishSchema,
  type EncryptedOperationJournal,
  type OperationRecord,
  type PreparedPublish,
} from "./operation-journal";

export interface PublishedRegistryEntry {
  alias: string;
  formId: string;
  keyId: string;
  responsePasswordSecret: string;
  publicPasswordSecret?: string;
  recoveryFileName: string;
  createdAt: string;
}

interface PublicationDependencies {
  client: BurnerformClient;
  secrets: SecretProvider;
  custody: EncryptedFileCustodyStore;
  journal: EncryptedOperationJournal;
  recoveryDirectory: string;
  rememberPublishedForm(entry: PublishedRegistryEntry): Promise<void>;
}

function secretName(alias: string, kind: "response" | "public") {
  return `form:${alias}:${kind}`;
}

export async function preparePublication(input: {
  alias: string;
  schema: FormSchema;
  expiresAt: string;
  maxResponses: number;
  publicPassword: string | null;
}): Promise<PreparedPublish> {
  const formId = encodeBase64Url(randomBytes(16));
  const keyId = encodeBase64Url(randomBytes(16));
  const responsePassword = encodeBase64Url(randomBytes(32));
  const publicPassword = input.publicPassword ?? undefined;
  const temporaryStore = new MemoryCustodyStore();
  const custody = await provisionCreatorCustody({
    formId,
    keyId,
    mode: "creator_password",
    password: responsePassword,
    recoveryPassword: responsePassword,
    store: temporaryStore,
  });
  const custodyRecord = await temporaryStore.get(formId);
  if (!custodyRecord || !custody.recoveryFile)
    throw new Error("Verified recovery material is required.");

  return preparedPublishSchema.parse({
    request: createFormRequest.parse({
      idempotencyKey: crypto.randomUUID(),
      schema: input.schema,
      creatorPublicKey: {
        format: "raw-p256",
        value: custody.publicKey,
        keyId,
      },
      managementKey: custody.managementKey,
      responseAccessMode: "creator_password",
      respondentPassword: publicPassword,
      expiresAt: input.expiresAt,
      maxResponses: input.maxResponses,
      maxResponseBytes: FORM_LIMITS.maxSerializedResponseBytes,
    }),
    responsePassword,
    publicPassword,
    responsePasswordSecret: secretName(input.alias, "response"),
    publicPasswordSecret: publicPassword
      ? secretName(input.alias, "public")
      : undefined,
    recoveryFileName: `${input.alias}.recovery.json`,
    custodyRecord,
    recoveryFile: custody.recoveryFile,
    createdAt: new Date().toISOString(),
  });
}

export async function executePublication(
  alias: string,
  preparedInput: PreparedPublish,
  dependencies: PublicationDependencies,
  requestOptions: BurnerformRequestOptions = {},
) {
  const prepared = preparedPublishSchema.parse(preparedInput);
  await dependencies.secrets.set(
    prepared.responsePasswordSecret,
    prepared.responsePassword,
  );
  if (prepared.publicPassword && prepared.publicPasswordSecret) {
    await dependencies.secrets.set(
      prepared.publicPasswordSecret,
      prepared.publicPassword,
    );
  }
  const created = await dependencies.client.createForm(
    prepared.request,
    requestOptions,
  );
  const bound = await bindCreatorCustody(
    prepared.custodyRecord,
    prepared.recoveryFile,
    prepared.responsePassword,
    created.formId,
    dependencies.custody,
  );
  if (!bound.recoveryFile)
    throw new Error("Verified recovery material is required.");
  const recoveryPath = path.join(
    dependencies.recoveryDirectory,
    prepared.recoveryFileName,
  );
  await writePrivateFile(
    recoveryPath,
    serializeRecoveryFile(bound.recoveryFile),
  );
  const verified = await unlockRecoveryFile(
    JSON.parse(await readFile(recoveryPath, "utf8")),
    prepared.responsePassword,
  );
  const managementKey = prepared.request.managementKey;
  if (!managementKey || verified.managementKey !== managementKey) {
    throw new Error("Recovery verification failed.");
  }

  await dependencies.rememberPublishedForm({
    alias,
    formId: created.formId,
    keyId: prepared.request.creatorPublicKey.keyId,
    responsePasswordSecret: prepared.responsePasswordSecret,
    publicPasswordSecret: prepared.publicPasswordSecret,
    recoveryFileName: prepared.recoveryFileName,
    createdAt: prepared.createdAt,
  });
  return created;
}

export async function beginAndExecutePublication(
  alias: string,
  prepared: PreparedPublish,
  dependencies: PublicationDependencies,
  requestOptions: BurnerformRequestOptions = {},
) {
  const operation = await dependencies.journal.begin(
    alias,
    "publish",
    prepared,
    prepared.request.idempotencyKey,
  );
  const created = await executePublication(
    alias,
    prepared,
    dependencies,
    requestOptions,
  );
  await dependencies.journal.finish(operation.id, "complete");
  return created;
}

export async function reconcilePublication(
  operation: OperationRecord,
  dependencies: PublicationDependencies,
  requestOptions: BurnerformRequestOptions = {},
) {
  const prepared = preparedPublishSchema.parse(operation.payload);
  return executePublication(
    operation.formAlias,
    prepared,
    dependencies,
    requestOptions,
  );
}
