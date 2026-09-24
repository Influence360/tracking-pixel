# Contributing

This is the browser tracker companies embed on their own sites, so every change here ends up executing
on third-party pages. That shapes most of what follows.

Issues are welcome — bug reports, questions about behaviour, and "this documentation is wrong" all help.
For anything security-related, use [SECURITY.md](SECURITY.md) instead of a public issue.

## Build and test

```bash
npm ci
npm run build               # -> dist/influence360.js + dist/manifest-entry.json (hashes)
npm test                    # vitest (jsdom)
npm run typecheck
npm run format:check        # prettier
npm run verify:reproducible # builds twice, asserts identical sha256 — CI runs this
```

CI runs prettier, typecheck, tests and a build on every pull request. There are no runtime dependencies
and we intend to keep it that way: this file ships to every visitor of every embedding site, so its size
is a cost paid by other people.

## Invariants a change must not break

These are load-bearing. A patch that violates one will be asked to change, however good the underlying
idea:

- **Never throw into the host page.** The tracker swallows its own errors. Breaking someone else's
  checkout page because our beacon failed is the worst thing this code can do.
- **Never block rendering.** Beacons are fire-and-forget (`navigator.sendBeacon`, with a keepalive
  `fetch` fallback). No synchronous work on the critical path.
- **Keep the beacon CORS-safelisted.** The body goes out as `text/plain` specifically so the
  cross-origin request skips a preflight. Changing the content type doubles the request count and
  requires a matching collector change.
- **Keep the bundle deterministic.** No timestamps, absolute paths or random ids in the output. A
  published `sha384` is only meaningful if the build reproduces from source, and
  `npm run verify:reproducible` fails CI otherwise.
- **Bump the version and add a `CHANGELOG.md` entry for any change to the shipped bytes.** The version is
  the published path, and a published version is _never_ republished with different bytes — the deploy
  fails instead. Overwriting a pinned artifact silently breaks every page carrying that `integrity=`
  hash, because the browser then refuses to run the script.

## Where the layers live

- `src/types.ts` — the event wire-contract. The source of truth for the browser side.
- `src/tracker.ts` — the pure, testable core: cookie handling, ref capture, event building. New logic
  goes here, with unit tests.
- `src/influence360.ts` — the entry point. Bootstrap wiring only.
- `snippet/bootstrap.html` — the copy-paste stub.

## Changes to the wire-contract

`src/types.ts` is one half of a contract; the collector that receives these events is the other half, and
it lives in a separate, private repository. It validates strictly: a field added here that the collector
does not declare is rejected, not silently ignored.

So a PR that adds or renames a field on the wire **cannot be merged on its own** — it needs a coordinated
change on the collector side, which only maintainers can make. Please open an issue describing the
field and why you need it, rather than a PR, and we will tell you whether it can be supported. The same
applies to `bindingMessage()`, which must stay byte-identical to the message the collector reconstructs;
a single character of drift makes every wallet signature verify as false.

## Notes for maintainers

- **No `pull_request_target`, ever.** It runs with a privileged token against untrusted fork code. The PR
  workflow uses `pull_request`, which is unprivileged by design. Fork PRs also cannot obtain
  `id-token: write`, so they cannot reach AWS — that is deliberate, not an oversight to work around.
- **Third-party actions are pinned to a commit SHA**, not a tag. A tag is mutable; a SHA is not, and these
  workflows can publish to the CDN.
- **`"private": true` stays in `package.json` while we are not publishing to npm.** It has nothing to do
  with repository visibility — it only makes `npm publish` refuse. Removing it buys nothing today and
  makes an accidental publish of `@influence360/tracking-pixel` possible, which is effectively
  irreversible (npm blocks unpublishing after 72 hours). Remove it in the same change that deliberately
  starts publishing the package, not before.
- **This repository is public — nothing internal goes in it, including in comments.** No names of private
  repositories or internal documents, no infra identifiers (account ids, role ARNs, bucket names,
  internal hostnames), and nothing echoed into a build log, since run logs are world-readable too.
  Per-environment values are environment-scoped: infra identifiers as secrets (the only kind the run log
  masks), the public CDN and collector hosts as variables. When a comment exists to protect a
  cross-repo contract, keep the invariant and drop the pointer: say the collector must reconstruct the
  same bytes, without naming the class that does it. See `CLAUDE.md` for the full rule.
