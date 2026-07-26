# @burnerform/sdk

The official TypeScript client for accountless Burnerform creation, encrypted
response submission, local custody, recovery, and lifecycle management.

Install it from npm with `pnpm add @burnerform/sdk`. See
https://burnerform.com/docs for the complete API, security, and custody model.

Requests time out after 30 seconds by default. Pass an `AbortSignal` through a
method's final options argument to support caller cancellation. Successful
responses must advertise the expected API version and supported client range.

API failures reject with `BurnerformApiError`. It exposes the HTTP `status`,
typed `code`, public `description`, safe `retry` guidance, and optional
`correlationId`. Branch on `code`; do not parse the human-readable fields to
control behavior.
