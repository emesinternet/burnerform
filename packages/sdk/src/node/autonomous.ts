import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  formSchema,
  normalizeAnswers,
  type FormSchema,
} from "@burnerform/core/form-schema";
import {
  decryptResponse,
  encryptResponse,
  importPublicKey,
} from "@burnerform/core/crypto";
import {
  BurnerformClient,
  restoreRecoveryFileForDurableAgent,
  unlockCreator,
  type SecretProvider,
} from "..";
import type { BurnerformRequestOptions } from "../client";
import { writePrivateFile } from "./atomic-file";
import { lockCustodyDirectory } from "./directory-lock";
import { EncryptedSecretProvider } from "./encrypted-secret-provider";
import { EncryptedState } from "./encrypted-state";
import { EncryptedFileCustodyStore } from "./file-custody-store";
import { installationSecret } from "./installation-secret";
import {
  EncryptedOperationJournal,
  type OperationRecord,
} from "./operation-journal";
import {
  beginAndExecutePublication,
  preparePublication,
  reconcilePublication,
} from "./publication-coordinator";
import {
  defaultBurnerformDataDirectory,
  prepareCustodyDirectory,
} from "./paths";
import { KeyringSecretProvider } from "./secret-provider";
import {
  draftsSchema,
  registryEntrySchema,
  registrySchema,
  safeAlias,
  secretName,
  type DraftEntry,
  type RegistryEntry,
} from "./autonomous-state";

export interface BurnerformOptions {
  baseUrl: string | URL;
  dataDirectory?: string;
  secretProvider?: SecretProvider;
  fetch?: typeof globalThis.fetch;
}

export interface PublishFormOptions {
  alias: string;
  expiresAt: string;
  maxResponses: number;
  publicPassword: string | null;
}

export interface AgentResponse {
  id: string;
  receivedAt: string;
  content: unknown;
  trust: "untrusted_respondent_content";
}

export class Burnerform {
  readonly client: BurnerformClient;
  readonly dataDirectory: string;
  private readonly secrets: SecretProvider;
  private readonly custody: EncryptedFileCustodyStore;
  private readonly registry: EncryptedState<RegistryEntry[]>;
  private readonly drafts: EncryptedState<DraftEntry[]>;
  private readonly journal: EncryptedOperationJournal;
  private readonly releaseDirectoryLock: () => Promise<void>;
  private readonly recoveryDirectory: string;
  private readonly mutationLocks = new Map<string, Promise<void>>();
  private readonly respondentTokens = new Map<
    string,
    { token: string; expiresAt: number }
  >();

  private constructor(options: {
    client: BurnerformClient;
    dataDirectory: string;
    secrets: SecretProvider;
    custody: EncryptedFileCustodyStore;
    registry: EncryptedState<RegistryEntry[]>;
    drafts: EncryptedState<DraftEntry[]>;
    journal: EncryptedOperationJournal;
    releaseDirectoryLock: () => Promise<void>;
    recoveryDirectory: string;
  }) {
    Object.assign(this, options);
    this.client = options.client;
    this.dataDirectory = options.dataDirectory;
    this.secrets = options.secrets;
    this.custody = options.custody;
    this.registry = options.registry;
    this.drafts = options.drafts;
    this.journal = options.journal;
    this.releaseDirectoryLock = options.releaseDirectoryLock;
    this.recoveryDirectory = options.recoveryDirectory;
  }

  static async open(options: BurnerformOptions) {
    const dataDirectory = await prepareCustodyDirectory(
      options.dataDirectory ?? defaultBurnerformDataDirectory(),
    );
    const releaseDirectoryLock = await lockCustodyDirectory(dataDirectory);
    try {
      const installationSecretProvider =
        options.secretProvider ?? new KeyringSecretProvider();
      const secret = await installationSecret(installationSecretProvider);
      const secrets = await EncryptedSecretProvider.open(
        path.join(dataDirectory, "secrets.state"),
        secret,
      );
      const recoveryDirectory = path.join(dataDirectory, "recovery");
      await mkdir(recoveryDirectory, { recursive: true, mode: 0o700 });
      return new Burnerform({
        client: new BurnerformClient({
          baseUrl: options.baseUrl,
          fetch: options.fetch,
        }),
        dataDirectory,
        secrets,
        custody: await EncryptedFileCustodyStore.create(
          path.join(dataDirectory, "custody"),
          secret,
        ),
        registry: await EncryptedState.open(
          path.join(dataDirectory, "registry.state"),
          secret,
          registrySchema,
          [],
        ),
        drafts: await EncryptedState.open(
          path.join(dataDirectory, "drafts.state"),
          secret,
          draftsSchema,
          [],
        ),
        journal: await EncryptedOperationJournal.open(dataDirectory, secret),
        releaseDirectoryLock,
        recoveryDirectory,
      });
    } catch (error) {
      await releaseDirectoryLock();
      throw error;
    }
  }

  async close() {
    try {
      await this.journal.compact();
    } finally {
      await this.releaseDirectoryLock();
    }
  }

  async draftForm(aliasInput: string, input: FormSchema) {
    const alias = safeAlias(aliasInput);
    const schema = formSchema.parse(input);
    const drafts = this.drafts.get().filter((draft) => draft.alias !== alias);
    drafts.push({ alias, schema, updatedAt: new Date().toISOString() });
    await this.drafts.set(drafts);
    return { alias, fieldCount: schema.fields.length };
  }

  private draft(aliasInput: string) {
    const alias = safeAlias(aliasInput);
    const draft = this.drafts
      .get()
      .find((candidate) => candidate.alias === alias);
    if (!draft) throw new Error("Draft was not found.");
    return draft;
  }

  private entry(aliasInput: string) {
    const alias = safeAlias(aliasInput);
    const entry = this.registry
      .get()
      .find((candidate) => candidate.alias === alias);
    if (!entry) throw new Error("Form was not found in local custody.");
    return entry;
  }

  async publishForm(
    options: PublishFormOptions,
    requestOptions: BurnerformRequestOptions = {},
  ) {
    return this.withFormMutation(safeAlias(options.alias), () =>
      this.publishFormUnlocked(options, requestOptions),
    );
  }

  private async publishFormUnlocked(
    options: PublishFormOptions,
    requestOptions: BurnerformRequestOptions,
  ) {
    const draft = this.draft(options.alias);
    if (this.registry.get().some((entry) => entry.alias === draft.alias))
      throw new Error(
        `The local alias "${draft.alias}" is already published. Choose a new alias.`,
      );
    const prepared = await preparePublication({
      alias: draft.alias,
      schema: draft.schema,
      expiresAt: options.expiresAt,
      maxResponses: options.maxResponses,
      publicPassword: options.publicPassword,
    });
    const created = await beginAndExecutePublication(
      draft.alias,
      prepared,
      this.publicationDependencies(),
      requestOptions,
    );
    return {
      alias: draft.alias,
      publicUrl: new URL(
        `/f/${created.formId}`,
        this.client.baseUrl,
      ).toString(),
      expiresAt: created.expiresAt,
      recoverySaved: true as const,
      publicPasswordProtected: Boolean(prepared.publicPassword),
    };
  }

  private publicationDependencies() {
    return {
      client: this.client,
      secrets: this.secrets,
      custody: this.custody,
      journal: this.journal,
      recoveryDirectory: this.recoveryDirectory,
      rememberPublishedForm: (entry: RegistryEntry) =>
        this.rememberPublishedForm(entry),
    };
  }

  private async rememberPublishedForm(entry: RegistryEntry) {
    const entries = this.registry
      .get()
      .filter((candidate) => candidate.alias !== entry.alias);
    entries.push(registryEntrySchema.parse(entry));
    await this.registry.set(entries);
  }

  private async unlocked(aliasInput: string) {
    const entry = this.entry(aliasInput);
    const password = await this.secrets.get(entry.responsePasswordSecret);
    if (!password) throw new Error("Local response password is unavailable.");
    const record = await this.custody.get(entry.formId);
    if (!record) throw new Error("Local custody is unavailable.");
    return {
      entry,
      access: await unlockCreator(record, password),
    };
  }

  async getForm(
    aliasInput: string,
    requestOptions: BurnerformRequestOptions = {},
  ) {
    const { entry, access } = await this.unlocked(aliasInput);
    if (!access.managementKey)
      throw new Error("Lifecycle access is unavailable.");
    const overview = await this.client.getManagementOverview(
      entry.formId,
      access.managementKey,
      requestOptions,
    );
    return {
      alias: entry.alias,
      status: overview.status,
      responseCount: overview.responseCount,
      maxResponses: overview.maxResponses,
      expiresAt: overview.expiresAt,
      publicUrl: new URL(`/f/${entry.formId}`, this.client.baseUrl).toString(),
    };
  }

  private publicFormId(publicUrl: string) {
    const url = new URL(publicUrl);
    if (url.origin !== this.client.baseUrl.origin)
      throw new Error("Public form belongs to another Burnerform origin.");
    const match = /^\/f\/([^/]+)$/u.exec(url.pathname);
    if (!match) throw new Error("Public form URL is invalid.");
    return decodeURIComponent(match[1]);
  }

  private respondentToken(formId: string) {
    const session = this.respondentTokens.get(formId);
    if (!session || session.expiresAt <= Date.now()) {
      this.respondentTokens.delete(formId);
      return undefined;
    }
    return session.token;
  }

  async inspectPublicForm(
    publicUrl: string,
    requestOptions: BurnerformRequestOptions = {},
  ) {
    const formId = this.publicFormId(publicUrl);
    const form = await this.client.getPublicForm(
      formId,
      this.respondentToken(formId),
      requestOptions,
    );
    if (form.passwordRequired)
      return { publicUrl, passwordRequired: true as const };
    return {
      publicUrl,
      passwordRequired: false as const,
      expiresAt: form.expiresAt,
      schema: form.schema,
    };
  }

  async unlockPublicFormAccess(
    publicUrl: string,
    password: string,
    requestOptions: BurnerformRequestOptions = {},
  ) {
    const formId = this.publicFormId(publicUrl);
    const session = await this.client.unlockPublicForm(
      formId,
      password,
      requestOptions,
    );
    this.respondentTokens.set(formId, session);
    return { publicUrl, unlocked: true as const };
  }

  async submitPublicResponse(
    publicUrl: string,
    answersInput: unknown,
    requestOptions: BurnerformRequestOptions = {},
  ) {
    const formId = this.publicFormId(publicUrl);
    const token = this.respondentToken(formId);
    const form = await this.client.getPublicForm(formId, token, requestOptions);
    if (form.passwordRequired)
      throw new Error("The public form requires local password access.");
    const answers = normalizeAnswers(form.schema, answersInput);
    const envelope = await encryptResponse(
      {
        formVersion: form.schemaVersion,
        answers,
        submittedAt: new Date().toISOString(),
      },
      await importPublicKey(form.creatorPublicKey.value),
      {
        formId,
        schemaHash: form.schemaHash,
        schemaVersion: form.schemaVersion,
        keyId: form.keyId,
      },
    );
    const submitted = await this.client.submitResponse(
      formId,
      envelope,
      token,
      requestOptions,
    );
    return {
      publicUrl,
      responseId: submitted.responseId,
      submitted: true as const,
      replayed: submitted.replayed,
    };
  }

  async getLocalReview(
    aliasInput: string,
    requestOptions: BurnerformRequestOptions = {},
  ) {
    const entry = this.entry(aliasInput);
    const form = await this.getForm(entry.alias, requestOptions);
    const publicPassword = entry.publicPasswordSecret
      ? await this.secrets.get(entry.publicPasswordSecret)
      : undefined;
    return {
      ...form,
      publicPasswordProtected: Boolean(publicPassword),
      publicPassword,
    };
  }

  async updatePublicFormPassword(
    aliasInput: string,
    password: string | null,
    requestOptions: BurnerformRequestOptions = {},
  ) {
    return this.withFormMutation(safeAlias(aliasInput), () =>
      this.updatePublicFormPasswordUnlocked(
        aliasInput,
        password,
        requestOptions,
      ),
    );
  }

  private async updatePublicFormPasswordUnlocked(
    aliasInput: string,
    password: string | null,
    requestOptions: BurnerformRequestOptions,
  ) {
    const { entry, access } = await this.unlocked(aliasInput);
    if (!access.managementKey)
      throw new Error("Lifecycle access is unavailable.");
    if (password !== null && (password.length < 12 || password.length > 256))
      throw new Error("Password must be 12–256 characters.");
    const operation = await this.journal.begin(entry.alias, "public_password", {
      password,
    });
    const result = await this.client.updatePublicPassword(
      entry.formId,
      access.managementKey,
      password,
      operation.idempotencyKey,
      requestOptions,
    );
    const publicPasswordSecret = secretName(entry.alias, "public");
    if (password) await this.secrets.set(publicPasswordSecret, password);
    else await this.secrets.delete(publicPasswordSecret);
    await this.rememberPublishedForm({
      ...entry,
      publicPasswordSecret: password ? publicPasswordSecret : undefined,
    });
    await this.journal.finish(operation.id, "complete");
    return {
      alias: entry.alias,
      publicPasswordProtected: result.passwordRequired,
    };
  }

  async listResponses(
    aliasInput: string,
    options: {
      cursor?: string;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ) {
    const { entry, access } = await this.unlocked(aliasInput);
    if (!access.managementKey)
      throw new Error("Response access is unavailable.");
    const overview = await this.client.getManagementOverview(
      entry.formId,
      access.managementKey,
      { signal: options.signal },
    );
    const page = await this.client.listEncryptedResponses(
      entry.formId,
      { cursor: options.cursor, limit: Math.min(options.limit ?? 25, 50) },
      { managementKey: access.managementKey },
      { signal: options.signal },
    );
    const responses: AgentResponse[] = [];
    for (const response of page.responses) {
      responses.push({
        id: response.id,
        receivedAt: response.receivedAt,
        content: await decryptResponse(response.envelope, access.privateKey, {
          formId: entry.formId,
          schemaHash: overview.schemaHash,
          schemaVersion: overview.schema.version,
          keyId: entry.keyId,
        }),
        trust: "untrusted_respondent_content",
      });
    }
    return { responses, nextCursor: page.nextCursor };
  }

  async updateExpiration(
    aliasInput: string,
    expiresAt: string,
    requestOptions: BurnerformRequestOptions = {},
  ) {
    return this.withFormMutation(safeAlias(aliasInput), () =>
      this.updateExpirationUnlocked(aliasInput, expiresAt, requestOptions),
    );
  }

  private async updateExpirationUnlocked(
    aliasInput: string,
    expiresAt: string,
    requestOptions: BurnerformRequestOptions,
  ) {
    const { entry, access } = await this.unlocked(aliasInput);
    if (!access.managementKey)
      throw new Error("Lifecycle access is unavailable.");
    const operation = await this.journal.begin(entry.alias, "expiration", {
      expiresAt,
    });
    const result = await this.client.updateExpiration(
      entry.formId,
      access.managementKey,
      expiresAt,
      operation.idempotencyKey,
      requestOptions,
    );
    await this.journal.finish(operation.id, "complete");
    return result;
  }

  async updateResponseLimit(
    aliasInput: string,
    maxResponses: number,
    requestOptions: BurnerformRequestOptions = {},
  ) {
    return this.withFormMutation(safeAlias(aliasInput), () =>
      this.updateResponseLimitUnlocked(
        aliasInput,
        maxResponses,
        requestOptions,
      ),
    );
  }

  private async updateResponseLimitUnlocked(
    aliasInput: string,
    maxResponses: number,
    requestOptions: BurnerformRequestOptions,
  ) {
    const { entry, access } = await this.unlocked(aliasInput);
    if (!access.managementKey)
      throw new Error("Lifecycle access is unavailable.");
    const operation = await this.journal.begin(entry.alias, "response_limit", {
      maxResponses,
    });
    const result = await this.client.updateResponseLimit(
      entry.formId,
      access.managementKey,
      maxResponses,
      operation.idempotencyKey,
      requestOptions,
    );
    await this.journal.finish(operation.id, "complete");
    return result;
  }

  async exportRecovery(
    aliasInput: string,
    recoveryTargetDirectory: string,
    passwordTargetDirectory: string,
  ) {
    const entry = this.entry(aliasInput);
    const recoveryDestination = await prepareCustodyDirectory(
      recoveryTargetDirectory,
    );
    const passwordDestination = await prepareCustodyDirectory(
      passwordTargetDirectory,
    );
    if (recoveryDestination === passwordDestination)
      throw new Error("Recovery file and password need separate directories.");
    const password = await this.secrets.get(entry.responsePasswordSecret);
    if (!password) throw new Error("Recovery password is unavailable.");
    const contents = await readFile(
      path.join(this.recoveryDirectory, entry.recoveryFileName),
      "utf8",
    );
    await writePrivateFile(
      path.join(recoveryDestination, entry.recoveryFileName),
      contents,
    );
    await writePrivateFile(
      path.join(passwordDestination, `${entry.alias}.recovery-password.txt`),
      `${password}\n`,
    );
    return { alias: entry.alias, saved: true as const };
  }

  async restoreRecovery(
    aliasInput: string,
    recoveryFilePath: string,
    password: string,
    requestOptions: BurnerformRequestOptions = {},
  ) {
    const recoveryFile: unknown = JSON.parse(
      await readFile(path.resolve(recoveryFilePath), "utf8"),
    );
    return this.restoreRecoveryData(
      aliasInput,
      recoveryFile,
      password,
      requestOptions,
    );
  }

  async restoreRecoveryData(
    aliasInput: string,
    recoveryFile: unknown,
    password: string,
    requestOptions: BurnerformRequestOptions = {},
  ) {
    const alias = safeAlias(aliasInput);
    if (this.registry.get().some((entry) => entry.alias === alias))
      throw new Error("This alias already exists.");
    const restored = await restoreRecoveryFileForDurableAgent(
      recoveryFile,
      password,
      this.custody,
    );
    if (!restored.access.managementKey)
      throw new Error("Recovery file has no management key.");
    try {
      await this.client.getManagementOverview(
        restored.record.formId,
        restored.access.managementKey,
        requestOptions,
      );
    } catch (error) {
      await this.custody.delete(restored.record.formId);
      throw error;
    }
    const responsePasswordSecret = secretName(alias, "response");
    await this.secrets.set(responsePasswordSecret, password);
    const recoveryFileName = `${alias}.recovery.json`;
    await writePrivateFile(
      path.join(this.recoveryDirectory, recoveryFileName),
      JSON.stringify(recoveryFile, null, 2),
    );
    await this.rememberPublishedForm({
      alias,
      formId: restored.record.formId,
      keyId: restored.record.keyId,
      responsePasswordSecret,
      recoveryFileName,
      createdAt: new Date().toISOString(),
    });
    return {
      alias,
      restored: true as const,
    };
  }

  async burnForm(
    aliasInput: string,
    requestOptions: BurnerformRequestOptions = {},
  ) {
    return this.withFormMutation(safeAlias(aliasInput), () =>
      this.burnFormUnlocked(aliasInput, requestOptions),
    );
  }

  private async burnFormUnlocked(
    aliasInput: string,
    requestOptions: BurnerformRequestOptions,
  ) {
    const { entry, access } = await this.unlocked(aliasInput);
    if (!access.managementKey)
      throw new Error("Lifecycle access is unavailable.");
    const operation = await this.journal.begin(entry.alias, "burn", {});
    const result = await this.client.burnForm(
      entry.formId,
      access.managementKey,
      operation.idempotencyKey,
      requestOptions,
    );
    await this.removeLocalForm(entry);
    await this.journal.finish(operation.id, "complete");
    return { alias: entry.alias, burned: result.burned };
  }

  private async removeLocalForm(entry: RegistryEntry) {
    await this.custody.delete(entry.formId);
    await this.secrets.delete(entry.responsePasswordSecret);
    if (entry.publicPasswordSecret)
      await this.secrets.delete(entry.publicPasswordSecret);
    await unlink(
      path.join(this.recoveryDirectory, entry.recoveryFileName),
    ).catch((error: unknown) => {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    });
    await this.registry.set(
      this.registry
        .get()
        .filter((candidate) => candidate.alias !== entry.alias),
    );
  }

  private async withFormMutation<T>(
    alias: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const predecessor = this.mutationLocks.get(alias) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => gate);
    this.mutationLocks.set(alias, tail);
    await predecessor;
    try {
      return await mutation();
    } finally {
      release();
      if (this.mutationLocks.get(alias) === tail)
        this.mutationLocks.delete(alias);
    }
  }

  async reconcile(requestOptions: BurnerformRequestOptions = {}) {
    const outcomes: Array<{ operationId: string; state: string }> = [];
    for (const operation of this.journal.pending()) {
      try {
        await this.reconcileOperation(operation, requestOptions);
        await this.journal.finish(operation.id, "complete");
        outcomes.push({ operationId: operation.id, state: "complete" });
      } catch (error) {
        if (requestOptions.signal?.aborted) throw error;
        outcomes.push({ operationId: operation.id, state: "pending" });
      }
    }
    return outcomes;
  }

  private async reconcileOperation(
    operation: OperationRecord,
    requestOptions: BurnerformRequestOptions,
  ) {
    if (operation.operation === "publish") {
      await reconcilePublication(
        operation,
        this.publicationDependencies(),
        requestOptions,
      );
      return;
    }
    const { entry, access } = await this.unlocked(operation.formAlias);
    if (!access.managementKey)
      throw new Error("Lifecycle access is unavailable.");
    if (operation.operation === "expiration") {
      const { expiresAt } = z
        .object({ expiresAt: z.iso.datetime() })
        .strict()
        .parse(operation.payload);
      await this.client.updateExpiration(
        entry.formId,
        access.managementKey,
        expiresAt,
        operation.idempotencyKey,
        requestOptions,
      );
      return;
    }
    if (operation.operation === "response_limit") {
      const { maxResponses } = z
        .object({ maxResponses: z.number().int().min(1).max(10_000) })
        .strict()
        .parse(operation.payload);
      await this.client.updateResponseLimit(
        entry.formId,
        access.managementKey,
        maxResponses,
        operation.idempotencyKey,
        requestOptions,
      );
      return;
    }
    if (operation.operation === "public_password") {
      const { password } = z
        .object({ password: z.string().min(12).max(256).nullable() })
        .strict()
        .parse(operation.payload);
      await this.client.updatePublicPassword(
        entry.formId,
        access.managementKey,
        password,
        operation.idempotencyKey,
        requestOptions,
      );
      const publicPasswordSecret = secretName(entry.alias, "public");
      if (password) await this.secrets.set(publicPasswordSecret, password);
      else await this.secrets.delete(publicPasswordSecret);
      await this.rememberPublishedForm({
        ...entry,
        publicPasswordSecret: password ? publicPasswordSecret : undefined,
      });
      return;
    }
    if (operation.operation === "burn") {
      await this.client.burnForm(
        entry.formId,
        access.managementKey,
        operation.idempotencyKey,
        requestOptions,
      );
      await this.removeLocalForm(entry);
    }
  }
}
