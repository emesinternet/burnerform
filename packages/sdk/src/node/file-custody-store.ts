import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { unwrapJson, wrapJson } from "@burnerform/core/crypto";
import {
  creatorCustodyRecordSchema,
  type CreatorCustodyRecord,
  type CustodyStore,
} from "../custody";
import { writePrivateFile } from "./atomic-file";
import { prepareCustodyDirectory } from "./paths";

function recordPath(directory: string, formId: string): string {
  if (!/^[A-Za-z0-9_-]{16,64}$/u.test(formId))
    throw new Error("Form ID is invalid.");
  return path.join(directory, `${formId}.custody`);
}

export class EncryptedFileCustodyStore implements CustodyStore {
  private constructor(
    private readonly directory: string,
    private readonly installationSecret: string,
  ) {}

  static async create(directory: string, installationSecret: string) {
    return new EncryptedFileCustodyStore(
      await prepareCustodyDirectory(directory),
      installationSecret,
    );
  }

  async get(formId: string) {
    try {
      const wrapped: unknown = JSON.parse(
        await readFile(recordPath(this.directory, formId), "utf8"),
      );
      return creatorCustodyRecordSchema.parse(
        await unwrapJson<unknown>(wrapped, this.installationSecret),
      );
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return undefined;
      throw error;
    }
  }

  async put(record: CreatorCustodyRecord) {
    if (record.mode === "creator_only")
      throw new Error(
        "Extractable creator custody is required for durable agent storage.",
      );
    const wrapped = await wrapJson(record, this.installationSecret);
    await writePrivateFile(
      recordPath(this.directory, record.formId),
      JSON.stringify(wrapped),
    );
  }

  async delete(formId: string) {
    try {
      await unlink(recordPath(this.directory, formId));
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
  }
}
