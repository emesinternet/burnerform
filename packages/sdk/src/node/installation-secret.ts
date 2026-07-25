import { encodeBase64Url, randomBytes } from "@burnerform/core/crypto";
import type { SecretProvider } from "../custody/secret-provider";

const INSTALLATION_SECRET_NAME = "installation-secret";

export async function installationSecret(
  provider: SecretProvider,
): Promise<string> {
  const existing = await provider.get(INSTALLATION_SECRET_NAME);
  if (existing) return existing;
  const created = encodeBase64Url(randomBytes(32));
  await provider.set(INSTALLATION_SECRET_NAME, created);
  const persisted = await provider.get(INSTALLATION_SECRET_NAME);
  if (persisted !== created)
    throw new Error("The installation secret could not be verified.");
  return created;
}
