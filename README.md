# Burnerform

Public TypeScript packages, local MCP server, conformance fixtures, and agent
skill for [Burnerform](https://burnerform.com).

Burnerform lets humans and agents create encrypted forms, collect responses,
and burn the form when it is finished—without accounts or API keys.

## Packages

- [`@burnerform/core`](packages/core) — canonical schemas, API contracts, and
  browser-compatible cryptography.
- [`@burnerform/sdk`](packages/sdk) — TypeScript client and local encrypted
  custody for complete form lifecycles.
- [`@burnerform/mcp`](packages/mcp) — local stdio MCP server built on the SDK.
- [`skills/burnerform`](skills/burnerform) — installable Burnerform skill for
  supported coding agents.

## Install

```bash
pnpm add @burnerform/sdk
```

For MCP clients:

```bash
pnpm dlx @burnerform/mcp
```

See the [Burnerform documentation](https://burnerform.com/docs) for setup,
examples, custody, recovery, and lifecycle guidance.

## Development

Use Node.js 24 and pnpm 11.

```bash
pnpm install --frozen-lockfile
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm conformance
pnpm packages:check
pnpm skill:check
pnpm mcp:smoke
```

## Security

Responses are encrypted before upload. Secrets and passwords used by the SDK
and MCP server remain in local custody. Read the
[security and custody guide](docs/security-and-custody.mdx) and report suspected
vulnerabilities privately through the contact method on
[burnerform.com/security](https://burnerform.com/security).

## License

Apache-2.0.
