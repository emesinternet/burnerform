import { z } from "zod";
import {
  managementOverviewSchema,
  passwordRequiredResponseSchema,
  publicFormResponseSchema,
  responsePageSchema,
  sharedReaderResponseSchema,
} from "./responses";
import { random128IdSchema } from "./requests";

export const API_V1 = "v1" as const;
export const API_V1_CLIENT_RANGE = ">=0.3.0 <1.0.0" as const;

export function isApiV1ClientVersionSupported(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [, major, minor] = match.map(Number);
  return major === 0 && minor >= 3;
}

export const API_V1_ERROR_CODES = [
  "access_denied",
  "burn_confirmation_required",
  "creation_disabled",
  "form_closed",
  "internal_error",
  "invalid_confirmation",
  "invalid_creator_public_key",
  "invalid_cursor",
  "invalid_envelope",
  "invalid_expiration",
  "invalid_request",
  "invalid_response_limit",
  "idempotency_conflict",
  "proxy_identity_unavailable",
  "rate_limited",
  "request_too_large",
  "response_limit_below_count",
  "response_too_large",
  "schema_too_large",
  "unauthorized",
  "unavailable",
  "unsupported_client",
] as const;
export const apiV1ErrorCodeSchema = z.enum(API_V1_ERROR_CODES);
export type ApiV1ErrorCode = z.infer<typeof apiV1ErrorCodeSchema>;

export type ApiV1ErrorReference = {
  cause: string;
  retry: string;
  status: string;
};

export const API_V1_ERRORS = {
  access_denied: {
    status: "401",
    cause: "A form or response password is missing or incorrect.",
    retry: "Ask for the correct password, then retry.",
  },
  burn_confirmation_required: {
    status: "409",
    cause:
      "The requested expiration is in the past, which would burn the form.",
    retry: "Choose a future expiration or use the burn endpoint.",
  },
  creation_disabled: {
    status: "503",
    cause: "New form creation is temporarily unavailable.",
    retry: "Retry later with the same idempotency key.",
  },
  form_closed: {
    status: "409",
    cause: "The form reached its response or storage limit while submitting.",
    retry: "Do not retry unless the creator raises the response limit.",
  },
  idempotency_conflict: {
    status: "409",
    cause: "An idempotency key was reused with a different request.",
    retry: "Reuse the original request or generate a new idempotency key.",
  },
  internal_error: {
    status: "500",
    cause: "Burnerform could not complete the request.",
    retry:
      "Retry later with the same idempotency key when the operation supports one.",
  },
  invalid_confirmation: {
    status: "400",
    cause: "The burn confirmation text does not match the required value.",
    retry: 'Send the exact confirmation "LET IT BURN".',
  },
  invalid_creator_public_key: {
    status: "400",
    cause: "The creator public key cannot be imported as a raw P-256 key.",
    retry: "Generate a valid P-256 key pair and rebuild the request.",
  },
  invalid_cursor: {
    status: "400",
    cause: "The response pagination cursor is malformed or expired.",
    retry: "Start again without a cursor.",
  },
  invalid_envelope: {
    status: "400",
    cause: "The encrypted response does not match the form key.",
    retry: "Reload the form schema and encrypt a new response envelope.",
  },
  invalid_expiration: {
    status: "400",
    cause: "The expiration is outside the allowed lifetime.",
    retry: "Choose a valid future expiration and retry.",
  },
  invalid_request: {
    status: "400",
    cause: "The JSON body or one of its values does not match the API schema.",
    retry: "Correct the request using the OpenAPI schema, then retry.",
  },
  invalid_response_limit: {
    status: "400",
    cause: "The response limit is outside the allowed range.",
    retry: "Choose a value from 1 through 10,000.",
  },
  proxy_identity_unavailable: {
    status: "503",
    cause:
      "Burnerform cannot establish a trusted network identity for rate limiting.",
    retry: "Retry later. Contact the operator if the error persists.",
  },
  rate_limited: {
    status: "429",
    cause: "The request exceeded an active rate limit.",
    retry: "Wait for Retry-After, then retry with the same idempotency key.",
  },
  request_too_large: {
    status: "413",
    cause: "The complete request body exceeds the route limit.",
    retry: "Reduce the request payload before retrying.",
  },
  response_limit_below_count: {
    status: "409",
    cause:
      "The new response limit is lower than the responses already collected.",
    retry: "Choose a limit equal to or above the current response count.",
  },
  response_too_large: {
    status: "413",
    cause: "The encrypted response envelope exceeds the form response limit.",
    retry: "Reduce answer content, then encrypt and submit a new envelope.",
  },
  schema_too_large: {
    status: "413",
    cause: "The form schema exceeds the maximum encoded size.",
    retry: "Reduce the form fields or copy before creating it.",
  },
  unauthorized: {
    status: "401",
    cause:
      "The management key or shared-response session is missing or invalid.",
    retry:
      "Use the correct management key or unlock shared response access again.",
  },
  unavailable: {
    status: "404 or 503",
    cause:
      "The form is gone, closed, expired, full, or temporarily unavailable.",
    retry:
      "Retry only for a temporary service failure. Burnerform does not reveal form state.",
  },
  unsupported_client: {
    status: "400",
    cause: "The declared Burnerform client version is not supported by API v1.",
    retry: "Upgrade the client and retry.",
  },
} satisfies Record<ApiV1ErrorCode, ApiV1ErrorReference>;

export const apiV1ErrorSchema = z
  .object({
    error: z
      .object({
        code: apiV1ErrorCodeSchema,
        message: z.string().min(1).max(500),
        retry: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict();
export type ApiV1Error = z.infer<typeof apiV1ErrorSchema>;

export const apiV1CreateFormResponseSchema = z
  .object({
    formId: random128IdSchema,
    expiresAt: z.iso.datetime(),
    replayed: z.boolean(),
  })
  .strict();
export type ApiV1CreateFormResponse = z.infer<
  typeof apiV1CreateFormResponseSchema
>;

export const apiV1DiscoveryLinksSchema = z
  .object({
    self: z.string().startsWith("/api/v1/forms/"),
    access: z.string().startsWith("/api/v1/forms/"),
    responses: z.string().startsWith("/api/v1/forms/"),
  })
  .strict();

export const apiV1PublicFormResponseSchema = z.discriminatedUnion(
  "passwordRequired",
  [
    passwordRequiredResponseSchema.extend({
      apiVersion: z.literal(API_V1),
      links: apiV1DiscoveryLinksSchema,
    }),
    publicFormResponseSchema.extend({
      apiVersion: z.literal(API_V1),
      links: apiV1DiscoveryLinksSchema,
    }),
  ],
);
export type ApiV1PublicFormResponse = z.infer<
  typeof apiV1PublicFormResponseSchema
>;

export const apiV1RespondentAccessResponseSchema = z
  .object({
    token: z.string().min(1).max(4096),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export const apiV1SubmissionResponseSchema = z
  .object({
    responseId: z.string().uuid(),
    replayed: z.boolean(),
  })
  .strict();

export const apiV1ExpirationResponseSchema = z
  .object({ expiresAt: z.iso.datetime() })
  .strict();

export const apiV1ResponseLimitResponseSchema = z
  .object({ maxResponses: z.number().int().min(1).max(10_000) })
  .strict();

export const apiV1RespondentAccessUpdateResponseSchema = z
  .object({ passwordRequired: z.boolean() })
  .strict();

export const apiV1PasswordRotationResponseSchema = z
  .object({ rotated: z.literal(true) })
  .strict();

export const apiV1BurnResponseSchema = z
  .object({ burned: z.literal(true), replayed: z.boolean() })
  .strict();

export const apiV1ManagementOverviewSchema = managementOverviewSchema;
export const apiV1ResponsePageSchema = responsePageSchema;
export const apiV1SharedReaderResponseSchema = sharedReaderResponseSchema;
