import { z } from "zod";
import type { SecretProvider } from "../custody/secret-provider";
import { EncryptedState } from "./encrypted-state";

const secretsSchema = z.record(
  z.string().min(1).max(128),
  z.string().min(1).max(4_096),
);

export class EncryptedSecretProvider implements SecretProvider {
  private constructor(
    private readonly state: EncryptedState<Record<string, string>>,
  ) {}

  static async open(file: string, installationSecret: string) {
    return new EncryptedSecretProvider(
      await EncryptedState.open(file, installationSecret, secretsSchema, {}),
    );
  }

  async get(name: string) {
    return this.state.get()[name];
  }

  async set(name: string, value: string) {
    const secrets = this.state.get();
    secrets[name] = value;
    await this.state.set(secrets);
  }

  async delete(name: string) {
    const secrets = this.state.get();
    delete secrets[name];
    await this.state.set(secrets);
  }
}
