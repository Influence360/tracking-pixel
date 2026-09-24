# tracking-pixel

Influence360 conversion **pixel** — the client-side tracker companies embed on their site to
report conversions. It is the browser half of the tracking pipeline; the other half is the Influence360
collector API it posts to.

Licensed under [Apache-2.0](LICENSE). Security reports: [SECURITY.md](SECURITY.md). Contributing:
[CONTRIBUTING.md](CONTRIBUTING.md).

## What it does, and what it does not

If you are evaluating whether to put this on your site, this is the part that matters. ~4 KB minified,
**zero runtime dependencies**.

It does:

- Read a referral id from the landing URL and store it in a **first-party cookie on your own domain**
  (`_influence360_ref_id`), so a later conversion can be credited to the creator who sent the visitor.
- Send a fire-and-forget beacon to the collector when you call `track(...)` on a conversion page.
- Optionally bind a connected wallet to that referral when you call `identify(...)` (web3 only).

It does not:

- **Read cookies, storage or page content it did not write.** No form fields, no keystrokes, no
  clipboard, no DOM scraping, no session recording.
- **Fingerprint the device.** No canvas, font, or hardware probing.
- **Load anything else.** No third-party scripts, no tag manager, no remote config — the bundle you pin
  is all of it.
- **Block rendering, or throw into your page.** Beacons are `sendBeacon`/keepalive `fetch`, and the
  tracker swallows its own errors by design: a failure on our side must never break your checkout.
- **Track across sites.** The cookie is first-party to your domain and is not readable by us anywhere
  else.

Two things worth knowing before you deploy it:

- The **public token in the snippet is not a secret** — it identifies your company, is visible in page
  source by design, and grants no read access.
- Conversion **values sent from the browser are user-editable** — anyone can call `track()` with a
  different amount. For payouts that depend on an amount, use the server-to-server postback instead. The
  portal warns about this at the point of copying the snippet.

You can verify that the file you load is the file we published: every build is listed in
[manifest.json](https://tracking-pixel.influence360.io/manifest.json) with its SHA-384, versioned paths
are immutable, builds are reproducible from this source, and each carries sigstore provenance from CI.
See [Hosting](#hosting).

## Artifacts

- **Bootstrap stub** ([`snippet/bootstrap.html`](snippet/bootstrap.html)) — the tiny `<script>` the
  company pastes (the portal renders it with their real `PUBLIC_TOKEN`). It queues `influence360(...)` calls and
  async-loads the real library; nothing blocks page render.
- **`influence360.js`** (built from [`src/`](src/)) — the tracker: captures the ref id from the landing
  URL, persists a first-party `_influence360_ref_id` cookie, and on `track(...)` fires a fire-and-forget beacon
  to the collector. Built to `dist/influence360.js`, served from S3/CloudFront under versioned paths
  (see [Hosting](#hosting)).

Distributed as a **CDN-hosted snippet, not an npm package** (works on any stack; we ship fixes
centrally). A typed npm wrapper is a possible fast-follow.

## Public API

```js
influence360('init', 'PUBLIC_TOKEN', { collectUrl }); // on every page — captures the click id
influence360('track', 'PURCHASE', { dedupKey, orderValue }); // on a conversion success page (PURCHASE→orderValue, DEPOSIT→depositValue, SUBSCRIPTION→qualifyingPlan)
```

## Wire-contract

[`src/types.ts`](src/types.ts) (`CollectEvent`) is the single source of truth for the body POSTed to
the collector's `POST /public/pixel/conversion` — keep the two in sync. The beacon is
sent as `text/plain` (a CORS-safelisted content type) so the cross-origin request skips preflight;
**the collector must accept a `text/plain` body and parse it as JSON.**

## Build / test

```bash
npm ci
npm run build              # → dist/influence360.js (minified IIFE) + dist/manifest-entry.json (hashes)
npm run verify:reproducible # builds twice, asserts identical sha256 (what CI runs)
npm test                   # vitest (jsdom)
npm run typecheck
npm run format:check
```

The collector URL is baked in at build time and defaults to the production collector; set
`INFLUENCE360_COLLECT_URL` to build against a different one.

## Hosting

`dist/influence360.js` is published to an S3 bucket fronted by CloudFront as three objects, served from
`tracking-pixel.influence360.io`:

| Path                          | Cache                     | What it is                                                                                |
| ----------------------------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| `/v<version>/influence360.js` | 1 year, `immutable`       | An exact build. **Never overwritten** — safe to pin with `integrity=`.                    |
| `/v<major>/influence360.js`   | 5 min / 1 day at the edge | Rolling auto-update channel (`/v1/…`). Not pinnable.                                      |
| `/manifest.json`              | 60 s                      | Every published build with `sha256`, `sha384` (the SRI value), size, git SHA, build time. |

The version comes from `package.json`; `CHANGELOG.md` is the human-readable history. Cut `/v2/` for a
breaking API change rather than busting cache on a stable URL.

Customers who pin get two guarantees: the object never changes, and the bytes are attested — see
[CHANGELOG.md](CHANGELOG.md) for the `gh attestation verify` command.

## Deploy

`.github/workflows/build-and-deploy.yml` builds (with the per-env collector URL baked in), verifies the
build is reproducible, attests its provenance to sigstore, then runs
[`scripts/publish.sh`](scripts/publish.sh) to upload the three objects, merge the build into
`manifest.json` and invalidate the two mutable paths:

Both environments run on every push to `main` (and on a manual `workflow_dispatch`, which takes no
inputs — it just re-runs the pair):

- **staging** — deploys immediately; the `staging` environment has no required reviewers.
- **prod** — the same commit is parked awaiting the `prod` environment's required reviewers, so promoting
  to prod is a one-click approval on the run that already deployed to staging.

Because prod is queued on every push, approvals can pile up. **Approving an older waiting run rebuilds
that commit** — if its version differs it publishes that version and rolls `/v{major}/` back to older
code. Cancel superseded waiting runs before approving.

**Publishing a version whose bytes differ from what is already published fails the job** rather than
overwriting it — an overwritten pinned object silently breaks every customer's `integrity=` attribute
(their browser refuses to run the script). Bump the version in `package.json` to ship a change;
re-publishing identical bytes is a safe no-op.

AWS access is GitHub OIDC with role chaining — no long-lived credentials exist in this repo, and the
publishing role is assumed only by a run of the workflow above.

### Deploy configuration

Every per-environment value is **environment-scoped**, never a literal in the workflow file — this repo
is public, so anything written there is published with it. The infra identifiers are environment
**secrets** rather than variables: the runner prints each step's resolved `env:` and `with:` values in
the world-readable log, and only secrets are masked there.

| Name                       | Kind     | What it is                                            |
| -------------------------- | -------- | ----------------------------------------------------- |
| `AWS_GITHUB_ROLE_ARN`      | secret   | First hop — the role the OIDC token assumes           |
| `TARGET_ROLE_ARN`          | secret   | Second hop — the role that owns the target bucket     |
| `S3_BUCKET`                | secret   | Bucket the three objects are published to             |
| `PUBLIC_HOST`              | variable | CDN host, used to find the distribution to invalidate |
| `INFLUENCE360_COLLECT_URL` | variable | Collector baked into the bundle at build time         |

The `Check deploy config` step fails the job if any is empty, before anything is built or uploaded — an
unset `INFLUENCE360_COLLECT_URL` would otherwise fall back to the **production** collector and publish
that bundle to whichever CDN the job targets. It logs only the collector and the CDN host: build logs on
a public repo are world-readable, so the bucket name is deliberately kept out of them.
