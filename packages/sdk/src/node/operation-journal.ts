import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { unwrapJson, wrapJson } from "@burnerform/core/crypto";
import { createFormRequest } from "@burnerform/core/contracts/requests";
import { creatorCustodyRecordSchema, recoveryFileSchema } from "../custody";
import { writePrivateFile } from "./atomic-file";
import { prepareCustodyDirectory } from "./paths";

export const preparedPublishSchema = z
  .object({
    request: createFormRequest,
    responsePassword: z.string().min(1).max(4_096),
    publicPassword: z.string().min(1).max(4_096).optional(),
    responsePasswordSecret: z.string().min(1).max(128),
    publicPasswordSecret: z.string().min(1).max(128).optional(),
    recoveryFileName: z
      .string()
      .regex(/^[a-z][a-z0-9-]{2,63}\.recovery\.json$/u),
    custodyRecord: creatorCustodyRecordSchema,
    recoveryFile: recoveryFileSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();
export type PreparedPublish = z.infer<typeof preparedPublishSchema>;

const operationSchema = z
  .object({
    id: z.string().uuid(),
    formAlias: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/u),
    operation: z.enum([
      "publish",
      "expiration",
      "response_limit",
      "public_password",
      "recovery",
      "burn",
    ]),
    idempotencyKey: z.string().uuid(),
    payload: z
      .union([
        preparedPublishSchema,
        z.object({ expiresAt: z.iso.datetime() }).strict(),
        z
          .object({ maxResponses: z.number().int().min(1).max(10_000) })
          .strict(),
        z.object({ password: z.string().min(12).max(256).nullable() }).strict(),
        z.object({}).strict(),
      ])
      .optional(),
    state: z.enum(["pending", "complete", "failed"]),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type OperationRecord = z.infer<typeof operationSchema>;
const journalSchema = z.array(operationSchema).max(10_000);

export class EncryptedOperationJournal {
  private readonly file: string;
  private records: OperationRecord[] = [];

  private constructor(
    directory: string,
    private readonly installationSecret: string,
  ) {
    this.file = path.join(directory, "operations.journal");
  }

  static async open(directory: string, installationSecret: string) {
    const safeDirectory = await prepareCustodyDirectory(directory);
    const journal = new EncryptedOperationJournal(
      safeDirectory,
      installationSecret,
    );
    try {
      const wrapped: unknown = JSON.parse(await readFile(journal.file, "utf8"));
      journal.records = journalSchema.parse(
        await unwrapJson<unknown>(wrapped, installationSecret),
      );
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
    return journal;
  }

  private async persist() {
    const wrapped = await wrapJson(this.records, this.installationSecret);
    await writePrivateFile(this.file, JSON.stringify(wrapped));
  }

  async begin(
    formAlias: string,
    operation: OperationRecord["operation"],
    payload?: OperationRecord["payload"],
    idempotencyKey: string = randomUUID(),
  ) {
    const now = new Date().toISOString();
    const record = operationSchema.parse({
      id: randomUUID(),
      formAlias,
      operation,
      idempotencyKey,
      payload,
      state: "pending",
      createdAt: now,
      updatedAt: now,
    });
    this.records.push(record);
    await this.persist();
    return record;
  }

  pending() {
    return this.records.filter((record) => record.state === "pending");
  }

  async finish(id: string, state: "complete" | "failed") {
    const record = this.records.find((candidate) => candidate.id === id);
    if (!record) throw new Error("Operation record was not found.");
    record.state = state;
    record.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async compact(retainCompletedDays = 7) {
    const cutoff = Date.now() - retainCompletedDays * 86_400_000;
    this.records = this.records.filter(
      (record) =>
        record.state === "pending" ||
        new Date(record.updatedAt).getTime() >= cutoff,
    );
    await this.persist();
  }
}
