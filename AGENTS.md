# AGENTS.md: Fork Horse

Fork Horse (a code name) is a multi-agent collaboration layer for Git, built on Cloudflare Workers and Artifacts. It deploys together with a pinned, unmodified Cloudflare OS. Every owner deploys their own copy to their own Cloudflare account. There is no central service.

## Layout

| Path | What it is | Rules |
|---|---|---|
| `cloudflare-os/` | Upstream Cloudflare OS, as a git submodule at a reviewed commit | **Never edit.** Move the pin only in a dedicated PR that names the old and new commits and says what was checked. Upstream's own `cloudflare-os/AGENTS.md` describes upstream conventions: read it as reference, don't follow it as this repo's contract. |
| `scripts/`, `deployment.jsonc`, `packages/custom-gatekeeper`, `packages/error-reporter`, `docs/` | Deployment tooling from cloudflare-os-starter | Keep changes small and commented. `deployment.jsonc` stays a template. |
| `deployment.local.jsonc` | An owner's real deployment values (gitignored) | `scripts/deploy.ts` reads it when present. Never commit it. |
| `brand.json` | The single source of every user-visible name, domain and tagline | Never hardcode the product name elsewhere. |
| `packages/forkhorse-*` | Fork Horse itself: core Worker and supervisor Durable Object, MCP server, dashboard, gatekeeper, check runner | Each package has its own README, tests and typecheck. |

## Working rules

1. **Public-safe always.** No secrets, tokens, account-specific values, personal names or emails, or local machine paths in tracked files. Use `deployment.local.jsonc` and Worker secrets.
2. **Tokens.** Artifacts tokens are repo-scoped and short-lived; mint them only after authorizing the caller. The canonical repo's write token never leaves the promote path. Never `--force` push a canonical repo. Send a git-style `User-Agent` on raw git HTTP requests.
3. **Real or labeled.** Nothing mocked may be presented as live. Fixtures are fine in tests.
4. **Task packets.** Work arrives as packets that name scope, allowed paths and acceptance checks. Stay inside the packet. Report results with evidence: commands run and their output.
5. **Tests.** `pnpm test`, `pnpm lint` and the touched package's own tests must pass before you hand work back.
6. **Test data.** Use the `idiot.tax` domain for any fictional email address.
7. **Worker runtime tests.** Packages deployed to Cloudflare Workers must test under workerd. Node-only tests do not satisfy runtime acceptance.
