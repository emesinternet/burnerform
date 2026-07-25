import type { CreatorCustodyRecord } from "./types";

export interface CustodyStore {
  get(formId: string): Promise<CreatorCustodyRecord | undefined>;
  put(record: CreatorCustodyRecord): Promise<void>;
  delete(formId: string): Promise<void>;
}

export class MemoryCustodyStore implements CustodyStore {
  private readonly records = new Map<string, CreatorCustodyRecord>();

  async get(formId: string) {
    return this.records.get(formId);
  }

  async put(record: CreatorCustodyRecord) {
    this.records.set(record.formId, record);
  }

  async delete(formId: string) {
    this.records.delete(formId);
  }
}
