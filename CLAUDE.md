# CLAUDE.md — tracking-pixel

Guidance for Claude Code in this repo.

## What this is

The **browser-side conversion pixel**: a tiny tracker companies embed to report conversions to the
Influence360 collector API. Plain TypeScript bundled to a single minified IIFE (`dist/influence360.js`)
and served as a static asset from S3/CloudFront. **No framework, no runtime deps** — it ships to every
visitor's browser, so keep it small.

## Layout

- `src/types.ts` — the `CollectEvent` **wire-contract**: the source of truth for the pixel side, and it
  must stay in sync with the collector's request DTO.
- `src/tracker.ts` — pure, testable core: cookie helpers, `captureClick`, `buildEvent`, `Tracker`.
- `src/influence360.ts` — browser entry point: drains `window.influence360.q` and wires the global. Bundled to `dist/influence360.js`.
- `snippet/bootstrap.html` — the copy-paste stub the **portal** renders (with the company's PUBLIC_TOKEN).
- `build.mjs` — esbuild bundle; bakes the collector URL via `--define` (`INFLUENCE360_COLLECT_URL`) and
  emits `dist/manifest-entry.json` (sha256 + the sha384 customers pin with `integrity=`).
- `scripts/publish.sh` — the deploy: immutable `/v<version>/`, rolling `/v<major>/`, merged
  `manifest.json`, CloudFront invalidation. Refuses to overwrite an already-published version, and
  fails closed: only a 404 reads as "not published yet" — any other S3 error ends the deploy.
  `test/publish.test.ts` runs it against a stub `aws`.
- `scripts/assume-role.sh` — GitHub OIDC → first-hop role → target role, credentials masked and
  exported to `$GITHUB_ENV`. Prints nothing STS returns.
- `scripts/merge-manifest.mjs`, `scripts/check-reproducible.mjs` — manifest merge and the
  build-twice-and-compare check.

## Conventions

- TypeScript, ES2020, `strict`. Prettier (`singleQuote`, `trailingComma: all`) — `npm run format`.
- **Tracking must never throw into the host page** — `Tracker.send` swallows all errors.
- **Never block the page** — fire-and-forget via `navigator.sendBeacon`, keepalive `fetch` fallback.
- Keep the beacon a **CORS-safelisted** request (`text/plain` body) to avoid preflight. If you change
  the content type, the collector must add CORS handling.
- Put logic in `tracker.ts` (unit-tested with vitest/jsdom), keep `influence360.ts` to bootstrap wiring only.
- **Every user-visible change needs a `package.json` version bump + a `CHANGELOG.md` entry.** The version
  is the published path (`/v<version>/influence360.js`), and the deploy refuses to republish a version
  with different bytes — an overwritten pinned object breaks customers' `integrity=` attributes.
- **Keep the bundle deterministic.** No build timestamps, absolute paths or random ids in the output;
  `npm run verify:reproducible` fails CI otherwise, and a non-reproducible build makes the published
  hash unverifiable.
- **This repo is public — nothing internal goes in it, including in comments.** Everything here is
  world-readable: the tree, the full git history, and **the Actions run logs**. So:
  - No names of private repos, internal design docs, internal class or service names, and no
    `§`-references to documents a reader outside the company cannot open. Describe the counterpart by
    its role instead — "the collector", not the repo that implements it. When a comment exists to
    protect a cross-repo contract, **keep the invariant and drop the pointer**: say that the collector
    must reconstruct the same bytes, without naming the class that does it.
  - No infra identifiers: account ids, role ARNs, bucket names, distribution ids, internal hostnames.
    Per-environment values are environment-scoped and read at step level. The infra identifiers (both
    role ARNs, the bucket) are environment **secrets**, not variables: the runner prints every step's
    resolved `env:` and `with:` in the step header before the step runs, so a variable there is published
    and `::add-mask::` cannot reach it in time — only secrets are masked from the first line. The
    production CDN and collector hosts are the exception — customers embed them, they are the public
    contract — and stay variables.
  - **Never echo an infra value into a build log.** `Check deploy config` and `publish.sh` deliberately
    print only the collector URL and the CDN host, and every `aws s3 cp` runs with `--only-show-errors`
    (its default `upload: … to s3://<bucket>/…` line is a leak). AWS roles are assumed by
    `scripts/assume-role.sh`, not `configure-aws-credentials`, which logs the assumed role's unique id
    (`AROA…`) — and a unique id decodes to the account id. Logging `S3_BUCKET` would publish the bucket
    name on every run.
  - Non-public reasoning ("we decided X because of customer Y", ticket-tracker context, roadmap) belongs
    in the internal plan doc, not in this repo.

## Build / test

```bash
npm ci
npm run build          # → dist/influence360.js;  INFLUENCE360_COLLECT_URL=... npm run build  to retarget the collector
npm test               # vitest (jsdom)
npm run typecheck
npm run format:check
```

CI (`.github/workflows/run-tests-on-pr.yml`) runs prettier + typecheck + tests + build; the `tests`
job is the required status check on `main`.
