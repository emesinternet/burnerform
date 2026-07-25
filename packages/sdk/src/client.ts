import type { z } from "zod";
import { BURNERFORM_CLIENT_VERSION } from "@burnerform/core";
import {
  API_V1,
  API_V1_CLIENT_RANGE,
  apiV1BurnResponseSchema,
  apiV1CreateFormResponseSchema,
  apiV1ExpirationResponseSchema,
  apiV1ManagementOverviewSchema,
  apiV1PasswordRotationResponseSchema,
  apiV1PublicFormResponseSchema,
  apiV1RespondentAccessResponseSchema,
  apiV1RespondentAccessUpdateResponseSchema,
  apiV1ResponseLimitResponseSchema,
  apiV1ResponsePageSchema,
  apiV1SharedReaderResponseSchema,
  apiV1SubmissionResponseSchema,
} from "@burnerform/core/contracts/api-v1";
import type { CreateFormRequest } from "@burnerform/core/contracts/requests";
import type { ResponseEnvelope } from "@burnerform/core/crypto";
import type { WrappedSecret } from "@burnerform/core/crypto/wrapped-secret";
import { apiErrorFrom } from "./errors";

export interface BurnerformClientOptions {
  baseUrl: string | URL;
  fetch?: typeof globalThis.fetch;
  clientVersion?: string;
  timeoutMs?: number;
}

export interface BurnerformRequestOptions {
  signal?: AbortSignal;
}

type JsonRequest = {
  method?: "DELETE" | "GET" | "PATCH" | "POST";
  body?: unknown;
  bearer?: string;
  managementKey?: string;
  signal?: AbortSignal;
};

export class BurnerformClient {
  readonly baseUrl: URL;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly clientVersion: string;
  private readonly timeoutMs: number;

  constructor(options: BurnerformClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.clientVersion = options.clientVersion ?? BURNERFORM_CLIENT_VERSION;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0)
      throw new TypeError("timeoutMs must be a positive number.");
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: JsonRequest = {},
  ): Promise<T> {
    const headers = new Headers({
      accept: "application/json",
      "x-burnerform-client-version": this.clientVersion,
    });
    if (options.body !== undefined)
      headers.set("content-type", "application/json");
    if (options.bearer)
      headers.set("authorization", `Bearer ${options.bearer}`);
    if (options.managementKey)
      headers.set("x-burner-management-key", options.managementKey);
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const response = await this.fetcher(new URL(path, this.baseUrl), {
      method: options.method ?? "GET",
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
    });
    if (!response.ok) throw await apiErrorFrom(response);
    const apiVersion = response.headers.get("burnerform-api-version");
    if (apiVersion !== API_V1)
      throw new Error(`Unsupported Burnerform API version: ${apiVersion}`);
    const supportedClientRange = response.headers.get(
      "burnerform-supported-client-range",
    );
    if (!supportedClientRange)
      throw new Error("Burnerform did not advertise a supported client range.");
    if (supportedClientRange !== API_V1_CLIENT_RANGE)
      throw new Error(
        `Unsupported Burnerform client compatibility range: ${supportedClientRange}`,
      );
    return schema.parse(await response.json());
  }

  createForm(input: CreateFormRequest, options: BurnerformRequestOptions = {}) {
    return this.request("/api/v1/forms", apiV1CreateFormResponseSchema, {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  getPublicForm(
    formId: string,
    respondentToken?: string,
    options: BurnerformRequestOptions = {},
  ) {
    return this.request(
      `/api/v1/forms/${encodeURIComponent(formId)}`,
      apiV1PublicFormResponseSchema,
      { bearer: respondentToken, signal: options.signal },
    );
  }

  unlockPublicForm(
    formId: string,
    password: string,
    options: BurnerformRequestOptions = {},
  ) {
    return this.request(
      `/api/v1/forms/${encodeURIComponent(formId)}/access`,
      apiV1RespondentAccessResponseSchema,
      { method: "POST", body: { password }, signal: options.signal },
    );
  }

  submitResponse(
    formId: string,
    envelope: ResponseEnvelope,
    respondentToken?: string,
    options: BurnerformRequestOptions = {},
  ) {
    return this.request(
      `/api/v1/forms/${encodeURIComponent(formId)}/responses`,
      apiV1SubmissionResponseSchema,
      {
        method: "POST",
        body: { envelope },
        bearer: respondentToken,
        signal: options.signal,
      },
    );
  }

  getManagementOverview(
    formId: string,
    managementKey: string,
    options: BurnerformRequestOptions = {},
  ) {
    return this.request(
      `/api/v1/manage/${encodeURIComponent(formId)}`,
      apiV1ManagementOverviewSchema,
      { managementKey, signal: options.signal },
    );
  }

  listEncryptedResponses(
    formId: string,
    input: { cursor?: string; limit?: number },
    authorization: { managementKey?: string; readToken?: string },
    options: BurnerformRequestOptions = {},
  ) {
    return this.request(
      `/api/v1/manage/${encodeURIComponent(formId)}/responses/query`,
      apiV1ResponsePageSchema,
      {
        method: "POST",
        body: input,
        managementKey: authorization.managementKey,
        bearer: authorization.readToken,
        signal: options.signal,
      },
    );
  }

  unlockSharedResponses(
    formId: string,
    password: string,
    options: BurnerformRequestOptions = {},
  ) {
    return this.request(
      `/api/v1/manage/${encodeURIComponent(formId)}/responses/access`,
      apiV1SharedReaderResponseSchema,
      { method: "POST", body: { password }, signal: options.signal },
    );
  }

  updateExpiration(
    formId: string,
    managementKey: string,
    expiresAt: string,
    idempotencyKey: string,
    options: BurnerformRequestOptions = {},
  ) {
    return this.request(
      `/api/v1/manage/${encodeURIComponent(formId)}/expiration`,
      apiV1ExpirationResponseSchema,
      {
        method: "PATCH",
        managementKey,
        body: { expiresAt, idempotencyKey },
        signal: options.signal,
      },
    );
  }

  updateResponseLimit(
    formId: string,
    managementKey: string,
    maxResponses: number,
    idempotencyKey: string,
    options: BurnerformRequestOptions = {},
  ) {
    return this.request(
      `/api/v1/manage/${encodeURIComponent(formId)}/response-limit`,
      apiV1ResponseLimitResponseSchema,
      {
        method: "PATCH",
        managementKey,
        body: { maxResponses, idempotencyKey },
        signal: options.signal,
      },
    );
  }

  updatePublicPassword(
    formId: string,
    managementKey: string,
    password: string | null,
    idempotencyKey: string,
    options: BurnerformRequestOptions = {},
  ) {
    return this.request(
      `/api/v1/manage/${encodeURIComponent(formId)}/respondent-access`,
      apiV1RespondentAccessUpdateResponseSchema,
      {
        method: "PATCH",
        managementKey,
        body: { password, idempotencyKey },
        signal: options.signal,
      },
    );
  }

  rotateResponsePassword(
    formId: string,
    managementKey: string,
    input: {
      currentPassword: string;
      newPassword: string;
      wrappedResponsePrivateKey: WrappedSecret;
      idempotencyKey: string;
    },
    options: BurnerformRequestOptions = {},
  ) {
    return this.request(
      `/api/v1/manage/${encodeURIComponent(formId)}/response-password`,
      apiV1PasswordRotationResponseSchema,
      { method: "POST", managementKey, body: input, signal: options.signal },
    );
  }

  burnForm(
    formId: string,
    managementKey: string,
    idempotencyKey: string,
    options: BurnerformRequestOptions = {},
  ) {
    return this.request(
      `/api/v1/manage/${encodeURIComponent(formId)}`,
      apiV1BurnResponseSchema,
      {
        method: "DELETE",
        managementKey,
        body: { confirmation: "LET IT BURN", idempotencyKey },
        signal: options.signal,
      },
    );
  }
}
