import {
  apiV1ErrorSchema,
  type ApiV1ErrorCode,
} from "@burnerform/core/contracts/api-v1";

export class BurnerformApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiV1ErrorCode,
    public readonly correlationId?: string,
  ) {
    super(code);
    this.name = "BurnerformApiError";
  }
}

export async function apiErrorFrom(
  response: Response,
): Promise<BurnerformApiError> {
  let code: ApiV1ErrorCode = "internal_error";
  try {
    const parsed = apiV1ErrorSchema.safeParse(await response.json());
    if (parsed.success) code = parsed.data.error.code;
  } catch {
    // A non-JSON upstream failure is still represented as a typed API error.
  }
  return new BurnerformApiError(
    response.status,
    code,
    response.headers.get("x-correlation-id") ?? undefined,
  );
}
