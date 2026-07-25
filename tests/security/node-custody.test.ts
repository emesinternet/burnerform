import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryCustodyStore,
  MemorySecretProvider,
  provisionCreatorCustody,
  restoreRecoveryFileForDurableAgent,
  unlockRecoveryFile,
} from "@burnerform/sdk";
import {
  EncryptedFileCustodyStore,
  EncryptedOperationJournal,
  EncryptedSecretProvider,
  installationSecret,
  lockCustodyDirectory,
  prepareCustodyDirectory,
} from "@burnerform/sdk/node";

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "burnerform-sdk-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Node autonomous custody", () => {
  it("encrypts durable custody and verifies recovery without plaintext leakage", async () => {
    const directory = await temporaryDirectory();
    const provider = new MemorySecretProvider();
    const secret = await installationSecret(provider);
    const store = await EncryptedFileCustodyStore.create(directory, secret);
    const password = "agent-generated-response-password-123456";
    const formId = "0123456789abcdef0123456789abcdef";

    const provisioned = await provisionCreatorCustody({
      formId,
      keyId: "abcdef0123456789abcdef0123456789",
      mode: "creator_password",
      password,
      recoveryPassword: password,
      store,
    });
    expect(provisioned.recoveryFile).toBeDefined();
    await expect(
      unlockRecoveryFile(provisioned.recoveryFile!, password),
    ).resolves.toMatchObject({
      lifecycleAccess: true,
      managementKey: provisioned.managementKey,
    });

    const persisted = await readFile(
      path.join(directory, `${formId}.custody`),
      "utf8",
    );
    expect(persisted).not.toContain(password);
    expect(persisted).not.toContain(provisioned.managementKey);
    await expect(store.get(formId)).resolves.toMatchObject({
      formId,
      mode: "creator_password",
    });
  });

  it("encrypts operation records and compacts completed history", async () => {
    const directory = await temporaryDirectory();
    const secret = await installationSecret(new MemorySecretProvider());
    const journal = await EncryptedOperationJournal.open(directory, secret);
    const record = await journal.begin("survey-form", "publish");
    expect(journal.pending()).toEqual([record]);
    await journal.finish(record.id, "complete");
    expect(journal.pending()).toEqual([]);
    await journal.compact(0);

    const persisted = await readFile(
      path.join(directory, "operations.journal"),
      "utf8",
    );
    expect(persisted).not.toContain("survey-form");
    expect(persisted).not.toContain(record.idempotencyKey);
  });

  it("stores generated form passwords in an encrypted local vault", async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, "secrets.state");
    const secret = "headless-installation-secret-123456";
    const vault = await EncryptedSecretProvider.open(file, secret);

    await vault.set("form:survey:response", "generated-response-password");
    await expect(vault.get("form:survey:response")).resolves.toBe(
      "generated-response-password",
    );
    expect(await readFile(file, "utf8")).not.toContain(
      "generated-response-password",
    );

    const reopened = await EncryptedSecretProvider.open(file, secret);
    await expect(reopened.get("form:survey:response")).resolves.toBe(
      "generated-response-password",
    );
    await reopened.delete("form:survey:response");
    await expect(reopened.get("form:survey:response")).resolves.toBeUndefined();
  });

  it("rejects custody written by an unsupported future format", async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, "secrets.state");
    const secret = "future-format-installation-secret-123456";
    const vault = await EncryptedSecretProvider.open(file, secret);
    await vault.set("form:survey:response", "generated-response-password");
    const wrapped = JSON.parse(await readFile(file, "utf8")) as {
      version: number;
    };
    wrapped.version = 2;
    await writeFile(file, JSON.stringify(wrapped));

    await expect(EncryptedSecretProvider.open(file, secret)).rejects.toThrow();
  });

  it("restores recovery material into durable encrypted custody", async () => {
    const source = await provisionCreatorCustody({
      formId: "0123456789abcdef0123456789abcdef",
      keyId: "abcdef0123456789abcdef0123456789",
      mode: "creator_password",
      password: "generated-recovery-password",
      recoveryPassword: "generated-recovery-password",
      store: new MemoryCustodyStore(),
    });
    const directory = await temporaryDirectory();
    const store = await EncryptedFileCustodyStore.create(
      directory,
      "headless-installation-secret-123456",
    );

    await expect(
      restoreRecoveryFileForDurableAgent(
        source.recoveryFile,
        "generated-recovery-password",
        store,
      ),
    ).resolves.toMatchObject({
      record: {
        formId: "0123456789abcdef0123456789abcdef",
        mode: "creator_password",
      },
    });
    await expect(
      store.get("0123456789abcdef0123456789abcdef"),
    ).resolves.toMatchObject({ mode: "creator_password" });
  });

  it("serializes access to one custody directory", async () => {
    const directory = await temporaryDirectory();
    const release = await lockCustodyDirectory(directory);
    await expect(lockCustodyDirectory(directory)).rejects.toThrow(
      "already in use",
    );
    await release();
    const releaseAgain = await lockCustodyDirectory(directory);
    await releaseAgain();
  });

  it("rejects custody directories inside Git repositories", async () => {
    await expect(prepareCustodyDirectory(process.cwd())).rejects.toThrow(
      "must not be inside a Git repository",
    );
  });
});
