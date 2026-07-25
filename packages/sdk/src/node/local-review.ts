import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { encodeBase64Url } from "@burnerform/core/crypto";

interface ReviewData {
  alias: string;
  status: string;
  responseCount: number;
  maxResponses: number;
  expiresAt: string;
  publicUrl: string;
  publicPasswordProtected: boolean;
  publicPassword?: string;
}

export interface LocalReviewService {
  getLocalReview(alias: string): Promise<ReviewData>;
  updatePublicFormProtection(
    alias: string,
    protect: boolean,
  ): Promise<{ publicPasswordProtected: boolean }>;
}

export interface LocalRecoveryService {
  restoreRecoveryData(
    alias: string,
    recoveryFile: unknown,
    password: string,
  ): Promise<{ alias: string; restored: true }>;
}

export interface LocalRespondentAccessService {
  unlockPublicFormAccess(
    publicUrl: string,
    password: string,
  ): Promise<{ publicUrl: string; unlocked: true }>;
}

interface LocalPageContext {
  csrf: string;
  expectedOrigin: string;
  closeAfterResponse(): void;
}

interface LocalPageOptions {
  openBrowser?: (url: string) => void;
  startError: string;
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    context: LocalPageContext,
  ): Promise<void>;
}

function escapeHtml(value: unknown) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function openBrowser(url: string) {
  const command: readonly [string, string[]] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function page(data: ReviewData, csrf: string, notice = "") {
  const protectionAction = data.publicPasswordProtected ? "remove" : "add";
  const protectionLabel = data.publicPasswordProtected
    ? "Remove public password"
    : "Protect public form";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Review ${escapeHtml(data.alias)} · Burnerform</title>
<style>
:root{color-scheme:light dark;font:16px system-ui,sans-serif;background:#111;color:#fff}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
main{width:min(680px,100%);border:1px solid #3a3a3a;border-radius:10px;padding:28px;background:#181818}
h1{margin:0 0 8px;font-size:2rem}p{color:#b9b9b9}dl{display:grid;grid-template-columns:max-content 1fr;gap:12px 20px;margin:28px 0}
dt{color:#b9b9b9}dd{margin:0;min-width:0;overflow-wrap:anywhere}
.secret{font:14px ui-monospace,monospace;padding:12px;background:#282828;border-radius:6px;color:#fff}
.notice{color:#ff8a55}a{color:#ff632b}button{border:0;border-radius:6px;padding:10px 14px;background:#d9470c;color:#fff;font:inherit;font-weight:650;cursor:pointer}
</style></head><body><main>
<h1>${escapeHtml(data.alias)}</h1>
<p>Review this form without exposing its local custody to the agent.</p>
${notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : ""}
<dl>
<dt>Status</dt><dd>${escapeHtml(data.status)}</dd>
<dt>Responses</dt><dd>${escapeHtml(data.responseCount)} / ${escapeHtml(data.maxResponses)}</dd>
<dt>Expires</dt><dd>${escapeHtml(new Date(data.expiresAt).toLocaleString())}</dd>
<dt>Public form</dt><dd><a href="${escapeHtml(data.publicUrl)}">${escapeHtml(data.publicUrl)}</a></dd>
<dt>Public password</dt><dd>${data.publicPassword ? `<div class="secret">${escapeHtml(data.publicPassword)}</div>` : "Not required"}</dd>
</dl>
<form method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="action" value="${protectionAction}">
<button type="submit">${protectionLabel}</button></form>
</main></body></html>`;
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 8_192) throw new Error("Request is too large.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function openLocalPage(options: LocalPageOptions) {
  const routeToken = encodeBase64Url(randomBytes(24));
  const csrf = encodeBase64Url(randomBytes(24));
  let expectedOrigin = "";
  const timer = { current: undefined as NodeJS.Timeout | undefined };
  const server = createServer(async (request, response) => {
    const host = request.headers.host;
    if (!host || host !== expectedOrigin.slice("http://".length))
      return send(response, 403, "Forbidden");
    const url = new URL(request.url ?? "/", expectedOrigin);
    if (url.pathname !== `/${routeToken}`)
      return send(response, 404, "Not found");
    await options.handle(request, response, {
      csrf,
      expectedOrigin,
      closeAfterResponse() {
        response.once("finish", () => {
          if (timer.current) clearTimeout(timer.current);
          server.close();
        });
      },
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error(options.startError);
  }
  server.unref();
  expectedOrigin = `http://127.0.0.1:${address.port}`;
  timer.current = setTimeout(() => server.close(), 10 * 60_000);
  timer.current.unref();
  (options.openBrowser ?? openBrowser)(`${expectedOrigin}/${routeToken}`);
}

export async function openLocalReview(
  service: LocalReviewService,
  alias: string,
  options: { openBrowser?: (url: string) => void } = {},
) {
  await openLocalPage({
    ...options,
    startError: "The local review server could not start.",
    async handle(request, response, { csrf, expectedOrigin }) {
      try {
        if (request.method === "GET") {
          const data = await service.getLocalReview(alias);
          return send(
            response,
            200,
            page(data, csrf),
            "text/html; charset=utf-8",
          );
        }
        if (
          request.method !== "POST" ||
          request.headers.origin !== expectedOrigin
        )
          return send(response, 403, "Forbidden");
        const form = new URLSearchParams(await readBody(request));
        if (form.get("csrf") !== csrf) return send(response, 403, "Forbidden");
        const action = form.get("action");
        if (action !== "add" && action !== "remove")
          return send(response, 400, "Invalid action");
        await service.updatePublicFormProtection(alias, action === "add");
        const data = await service.getLocalReview(alias);
        return send(
          response,
          200,
          page(data, csrf, "Public form access updated."),
          "text/html; charset=utf-8",
        );
      } catch {
        return send(response, 500, "Burnerform could not update this form.");
      }
    },
  });
  return { alias, opened: true as const, expiresInMinutes: 10 };
}

export async function openLocalRecovery(
  service: LocalRecoveryService,
  alias: string,
  options: { openBrowser?: (url: string) => void } = {},
) {
  await openLocalPage({
    ...options,
    startError: "The local recovery server could not start.",
    async handle(
      request,
      response,
      { csrf, expectedOrigin, closeAfterResponse },
    ) {
      try {
        const url = new URL(request.url ?? "/", expectedOrigin);
        if (request.method === "GET")
          return send(
            response,
            200,
            recoveryPage(alias, csrf),
            "text/html; charset=utf-8",
          );
        if (
          request.method !== "POST" ||
          request.headers.origin !== expectedOrigin
        )
          return send(response, 403, "Forbidden");
        const bytes = await readBytes(request, 128 * 1024);
        const headers = new Headers();
        const contentType = request.headers["content-type"];
        if (contentType) headers.set("content-type", contentType);
        const form = await new Request(url, {
          method: "POST",
          headers,
          body: bytes,
        }).formData();
        if (form.get("csrf") !== csrf) return send(response, 403, "Forbidden");
        const file = form.get("recovery");
        const password = form.get("password");
        if (!(file instanceof File) || typeof password !== "string")
          return send(
            response,
            400,
            "Recovery file and password are required.",
          );
        const recoveryFile: unknown = JSON.parse(await file.text());
        await service.restoreRecoveryData(alias, recoveryFile, password);
        closeAfterResponse();
        return send(
          response,
          200,
          recoveryPage(alias, csrf, "Access restored."),
          "text/html; charset=utf-8",
        );
      } catch {
        return send(
          response,
          400,
          recoveryPage(
            alias,
            csrf,
            "The recovery file or password is invalid.",
          ),
          "text/html; charset=utf-8",
        );
      }
    },
  });
  return { alias, opened: true as const, expiresInMinutes: 10 };
}

export async function openLocalRespondentAccess(
  service: LocalRespondentAccessService,
  publicUrl: string,
  options: { openBrowser?: (url: string) => void } = {},
) {
  await openLocalPage({
    ...options,
    startError: "The local access server could not start.",
    async handle(
      request,
      response,
      { csrf, expectedOrigin, closeAfterResponse },
    ) {
      try {
        if (request.method === "GET")
          return send(
            response,
            200,
            respondentAccessPage(publicUrl, csrf),
            "text/html; charset=utf-8",
          );
        if (
          request.method !== "POST" ||
          request.headers.origin !== expectedOrigin
        )
          return send(response, 403, "Forbidden");
        const form = new URLSearchParams(await readBody(request));
        if (form.get("csrf") !== csrf) return send(response, 403, "Forbidden");
        const password = form.get("password");
        if (!password) return send(response, 400, "Password is required.");
        await service.unlockPublicFormAccess(publicUrl, password);
        closeAfterResponse();
        return send(
          response,
          200,
          respondentAccessPage(publicUrl, csrf, "Public form unlocked."),
          "text/html; charset=utf-8",
        );
      } catch {
        return send(
          response,
          400,
          respondentAccessPage(publicUrl, csrf, "That password did not work."),
          "text/html; charset=utf-8",
        );
      }
    },
  });
  return { publicUrl, opened: true as const, expiresInMinutes: 10 };
}

function recoveryPage(alias: string, csrf: string, notice = "") {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Restore ${escapeHtml(alias)} · Burnerform</title>
<style>
:root{color-scheme:light dark;font:16px system-ui,sans-serif;background:#111;color:#fff}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
main{width:min(560px,100%);border:1px solid #3a3a3a;border-radius:10px;padding:28px;background:#181818}
h1{margin:0 0 8px;font-size:2rem}p{color:#b9b9b9}.notice{color:#ff8a55}
label{display:grid;gap:8px;margin:20px 0}input{width:100%;border:1px solid #444;border-radius:6px;padding:10px;background:#282828;color:#fff}
button{border:0;border-radius:6px;padding:10px 14px;background:#d9470c;color:#fff;font:inherit;font-weight:650;cursor:pointer}
</style></head><body><main>
<h1>Restore ${escapeHtml(alias)}</h1>
<p>Choose the encrypted recovery file and enter its separate password. Both stay in this local screen.</p>
${notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : ""}
<form method="post" enctype="multipart/form-data">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label>Recovery file<input required type="file" name="recovery" accept="application/json,.json"></label>
<label>Recovery-file password<input required type="password" name="password" autocomplete="off"></label>
<button type="submit">Restore access</button>
</form></main></body></html>`;
}

function respondentAccessPage(publicUrl: string, csrf: string, notice = "") {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Unlock public form · Burnerform</title>
<style>
:root{color-scheme:light dark;font:16px system-ui,sans-serif;background:#111;color:#fff}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
main{width:min(560px,100%);border:1px solid #3a3a3a;border-radius:10px;padding:28px;background:#181818}
h1{margin:0 0 8px;font-size:2rem}p{color:#b9b9b9;overflow-wrap:anywhere}.notice{color:#ff8a55}
label{display:grid;gap:8px;margin:20px 0}input{width:100%;border:1px solid #444;border-radius:6px;padding:10px;background:#282828;color:#fff}
button{border:0;border-radius:6px;padding:10px 14px;background:#d9470c;color:#fff;font:inherit;font-weight:650;cursor:pointer}
</style></head><body><main>
<h1>Unlock public form</h1><p>${escapeHtml(publicUrl)}</p>
<p>Enter the public-form password here. It stays in this local screen.</p>
${notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : ""}
<form method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label>Public form password<input required type="password" name="password" autocomplete="off"></label>
<button type="submit">Unlock form</button></form>
</main></body></html>`;
}

async function readBytes(request: IncomingMessage, maximum: number) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maximum) throw new Error("Request is too large.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function send(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
) {
  response.writeHead(status, {
    "content-type": contentType,
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  response.end(body);
}
