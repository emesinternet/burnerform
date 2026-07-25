export interface SecretProvider {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export class MemorySecretProvider implements SecretProvider {
  private readonly values = new Map<string, string>();

  async get(name: string) {
    return this.values.get(name);
  }

  async set(name: string, value: string) {
    this.values.set(name, value);
  }

  async delete(name: string) {
    this.values.delete(name);
  }
}
