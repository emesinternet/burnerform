import { Entry } from "@napi-rs/keyring";
import type { SecretProvider } from "../custody/secret-provider";

const SERVICE = "Burnerform";

export class KeyringSecretProvider implements SecretProvider {
  async get(name: string) {
    return new Entry(SERVICE, name).getPassword() ?? undefined;
  }

  async set(name: string, value: string) {
    new Entry(SERVICE, name).setPassword(value);
  }

  async delete(name: string) {
    new Entry(SERVICE, name).deletePassword();
  }
}

export class EnvironmentSecretProvider implements SecretProvider {
  constructor(private readonly variableName = "BURNERFORM_SECRET") {}

  async get(name: string) {
    if (name !== "installation-secret") return undefined;
    const value = process.env[this.variableName];
    if (!value || value.length < 32)
      throw new Error(
        `${this.variableName} must contain at least 32 characters.`,
      );
    return value;
  }

  async set(): Promise<void> {
    throw new Error(
      "Environment-backed secrets cannot be changed by Burnerform.",
    );
  }

  async delete(): Promise<void> {
    throw new Error(
      "Environment-backed secrets cannot be deleted by Burnerform.",
    );
  }
}
