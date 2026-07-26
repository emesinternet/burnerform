import { describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import {
  openLocalRecovery,
  openLocalRespondentAccess,
  openLocalManagement,
  promptLocalPublicPassword,
} from "@burnerform/sdk/node";

function hiddenValue(html: string, name: string) {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`, "u"));
  if (!match?.[1]) throw new Error(`Hidden ${name} value was not found.`);
  return match[1];
}

function requestWithHost(url: string, host: string) {
  return new Promise<number>((resolve, reject) => {
    const outgoing = request(url, { headers: { host } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

describe("trusted local screens", () => {
  it("uses an unguessable local route and enforces host, origin, and CSRF", async () => {
    let reviewUrl = "";
    let passwordProtected = true;
    const service = {
      getLocalReview: vi.fn(async () => ({
        alias: "survey",
        status: "open",
        responseCount: 0,
        maxResponses: 10,
        expiresAt: "2026-07-25T12:00:00.000Z",
        publicUrl: "https://burnerform.test/f/public-id",
        publicPasswordProtected: passwordProtected,
        publicPassword: "local-only-password",
      })),
      updatePublicFormPassword: vi.fn(
        async (_alias, password: string | null) => {
          passwordProtected = Boolean(password);
          return { publicPasswordProtected: passwordProtected };
        },
      ),
    };
    const result = await openLocalManagement(service, "survey", {
      openBrowser(url) {
        reviewUrl = url;
      },
    });
    expect(result).toEqual({
      alias: "survey",
      opened: true,
      expiresInMinutes: 10,
    });
    expect(reviewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+$/u);

    const page = await fetch(reviewUrl);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("local-only-password");
    expect(html).toContain(`value="${reviewUrl}"`);
    const csrf = hiddenValue(html, "csrf");

    expect(await requestWithHost(reviewUrl, "attacker.test")).toBe(403);

    const crossOrigin = await fetch(reviewUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://attacker.test",
      },
      body: "action=remove&csrf=wrong",
    });
    expect(crossOrigin.status).toBe(403);

    const wrongCsrf = await fetch(reviewUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: new URL(reviewUrl).origin,
      },
      body: "action=remove&csrf=wrong",
    });
    expect(wrongCsrf.status).toBe(403);
    expect(service.updatePublicFormPassword).not.toHaveBeenCalled();

    const updated = await fetch(reviewUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: new URL(reviewUrl).origin,
      },
      body: new URLSearchParams({ action: "remove", csrf }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.text()).toContain("Public form access updated.");
    expect(service.updatePublicFormPassword).toHaveBeenCalledWith(
      "survey",
      null,
    );
  });

  it("collects a new public password without returning it to the caller", async () => {
    let passwordUrl = "";
    const pending = promptLocalPublicPassword("survey", {
      openBrowser(url) {
        passwordUrl = url;
      },
    });
    await vi.waitFor(() => expect(passwordUrl).not.toBe(""));
    const html = await (await fetch(passwordUrl)).text();
    const csrf = hiddenValue(html, "csrf");
    const saved = await fetch(passwordUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: new URL(passwordUrl).origin,
      },
      body: new URLSearchParams({
        csrf,
        password: "chosen-local-password",
      }),
    });
    expect(saved.status).toBe(200);
    await expect(pending).resolves.toBe("chosen-local-password");
  });

  it("cancels password entry without publishing a password", async () => {
    const controller = new AbortController();
    const pending = promptLocalPublicPassword("survey", {
      signal: controller.signal,
      openBrowser() {},
    });
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("keeps recovery material in the local form submission", async () => {
    let recoveryUrl = "";
    const service = {
      restoreRecoveryData: vi.fn(async () => ({
        alias: "restored-survey",
        restored: true as const,
      })),
    };
    await openLocalRecovery(service, "restored-survey", {
      openBrowser(url) {
        recoveryUrl = url;
      },
    });
    const page = await fetch(recoveryUrl);
    const html = await page.text();
    const csrf = hiddenValue(html, "csrf");
    const body = new FormData();
    body.set("csrf", csrf);
    body.set(
      "recovery",
      new File([JSON.stringify({ version: 1 })], "survey.recovery.json", {
        type: "application/json",
      }),
    );
    body.set("password", "local-recovery-password");

    const blocked = await fetch(recoveryUrl, {
      method: "POST",
      headers: { origin: "https://attacker.test" },
      body,
    });
    expect(blocked.status).toBe(403);
    expect(service.restoreRecoveryData).not.toHaveBeenCalled();

    const restored = await fetch(recoveryUrl, {
      method: "POST",
      headers: { origin: new URL(recoveryUrl).origin },
      body,
    });
    expect(restored.status).toBe(200);
    expect(await restored.text()).toContain("Access restored.");
    expect(service.restoreRecoveryData).toHaveBeenCalledWith(
      "restored-survey",
      { version: 1 },
      "local-recovery-password",
    );
  });

  it("keeps respondent passwords in the local form submission", async () => {
    let accessUrl = "";
    const publicUrl = "https://burnerform.test/f/public-id";
    const service = {
      unlockPublicFormAccess: vi.fn(async () => ({
        publicUrl,
        unlocked: true as const,
      })),
    };
    await openLocalRespondentAccess(service, publicUrl, {
      openBrowser(url) {
        accessUrl = url;
      },
    });
    const page = await fetch(accessUrl);
    const csrf = hiddenValue(await page.text(), "csrf");

    const blocked = await fetch(accessUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: new URL(accessUrl).origin,
      },
      body: new URLSearchParams({
        csrf: "wrong",
        password: "local-public-password",
      }),
    });
    expect(blocked.status).toBe(403);
    expect(service.unlockPublicFormAccess).not.toHaveBeenCalled();

    const unlocked = await fetch(accessUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: new URL(accessUrl).origin,
      },
      body: new URLSearchParams({
        csrf,
        password: "local-public-password",
      }),
    });
    expect(unlocked.status).toBe(200);
    expect(await unlocked.text()).toContain("Public form unlocked.");
    expect(service.unlockPublicFormAccess).toHaveBeenCalledWith(
      publicUrl,
      "local-public-password",
    );
  });
});
