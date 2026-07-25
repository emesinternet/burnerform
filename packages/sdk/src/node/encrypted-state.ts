import { readFile } from "node:fs/promises";
import type { z } from "zod";
import { unwrapJson, wrapJson } from "@burnerform/core/crypto";
import { writePrivateFile } from "./atomic-file";

export class EncryptedState<T> {
  private constructor(
    private readonly file: string,
    private readonly installationSecret: string,
    private readonly schema: z.ZodType<T>,
    private value: T,
  ) {}

  static async open<T>(
    file: string,
    installationSecret: string,
    schema: z.ZodType<T>,
    empty: T,
  ) {
    let value = empty;
    try {
      const wrapped: unknown = JSON.parse(await readFile(file, "utf8"));
      value = schema.parse(
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
    return new EncryptedState(file, installationSecret, schema, value);
  }

  get() {
    return structuredClone(this.value);
  }

  async set(value: T) {
    this.value = this.schema.parse(value);
    const wrapped = await wrapJson(this.value, this.installationSecret);
    await writePrivateFile(this.file, JSON.stringify(wrapped));
  }
}
