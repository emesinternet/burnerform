import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SecretProvider } from "@burnerform/sdk";
import { Burnerform } from "@burnerform/sdk/node";

const installationSecret = "recovery-matrix-installation-secret-123456";

class FixedInstallationSecretProvider implements SecretProvider {
  async get(name: string) {
    return name === "installation-secret" ? installationSecret : undefined;
  }

  async set() {
    throw new Error("The fixed test installation secret cannot change.");
  }

  async delete() {
    throw new Error("The fixed test installation secret cannot be deleted.");
  }
}

async function main() {
  const baseUrl = process.env.BURNERFORM_LIFECYCLE_URL;
  if (!baseUrl)
    throw new Error("BURNERFORM_LIFECYCLE_URL must point to a test server.");
  const root = await mkdtemp(
    path.join(os.tmpdir(), "burnerform-recovery-lifecycle-"),
  );
  const sourceDirectory = path.join(root, "source");
  const restoredDirectory = path.join(root, "restored");
  const exportDirectory = path.join(root, "export");
  const alias = `recovery-${randomUUID().slice(0, 8)}`;
  const restoredAlias = `${alias}-restored`;
  const secretProvider = new FixedInstallationSecretProvider();
  let source: Burnerform | undefined;
  let restored: Burnerform | undefined;
  let burned = false;

  try {
    source = await Burnerform.open({
      baseUrl,
      dataDirectory: sourceDirectory,
      secretProvider,
    });
    await source.draftForm(alias, {
      version: 1,
      title: "Clean recovery lifecycle",
      fields: [
        {
          id: "question00000001",
          type: "short_text",
          label: "What recovered?",
          required: true,
          maxLength: 200,
        },
      ],
    });
    await source.publishForm({
      alias,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      maxResponses: 2,
      publicPassword: null,
    });
    const passwordDirectory = path.join(root, "exported-password");
    await source.exportRecovery(alias, exportDirectory, passwordDirectory);
    await source.close();
    source = undefined;

    const recoveryPassword = (
      await readFile(
        path.join(passwordDirectory, `${alias}.recovery-password.txt`),
        "utf8",
      )
    ).trim();

    restored = await Burnerform.open({
      baseUrl,
      dataDirectory: restoredDirectory,
      secretProvider,
    });
    await restored.restoreRecovery(
      restoredAlias,
      path.join(exportDirectory, `${alias}.recovery.json`),
      recoveryPassword,
    );
    const overview = await restored.getForm(restoredAlias);
    if (overview.status !== "open" || overview.maxResponses !== 2)
      throw new Error("The clean recovery overview did not match.");
    await restored.updateResponseLimit(restoredAlias, 3);
    await restored.burnForm(restoredAlias);
    burned = true;
    await restored.close();
    restored = undefined;
    process.stdout.write(
      "Clean-directory recovery, management, and burn passed.\n",
    );
  } finally {
    await restored?.close().catch(() => undefined);
    await source?.close().catch(() => undefined);
    if (!burned) {
      const cleanup = await Burnerform.open({
        baseUrl,
        dataDirectory: sourceDirectory,
        secretProvider,
      }).catch(() => undefined);
      if (cleanup) {
        await cleanup.burnForm(alias).catch(() => undefined);
        await cleanup.close().catch(() => undefined);
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}

void main();
