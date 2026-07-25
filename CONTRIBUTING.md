# Contributing to Burnerform

Thank you for improving Burnerform's public SDK, MCP server, core contracts, or
agent skill.

## Before opening a pull request

1. Install Node.js 24 and pnpm.
2. Run `pnpm install --frozen-lockfile`.
3. Keep changes within the public packages, skill, conformance fixtures, tests,
   or public documentation.
4. Run:

   ```sh
   pnpm format
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm conformance
   pnpm packages:check
   pnpm skill:check
   pnpm mcp:smoke
   ```

Protocol changes must include matching conformance fixtures and documentation.
Do not include credentials, form data, passwords, recovery material, private
keys, or local custody files.

## How public changes are accepted

The private service repository is the source of truth because public contracts
must stay synchronized with the hosted service.

Open your pull request against this public repository as usual. After review, a
maintainer ports the accepted patch into the private source, runs the complete
service and compatibility checks, then opens a generated synchronization pull
request back to this repository. The synchronization pull request records the
exact private source commit and preserves contributor attribution.

This round trip prevents the public packages and hosted service from silently
drifting apart.
