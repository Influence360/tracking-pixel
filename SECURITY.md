# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it through GitHub's private vulnerability reporting: go to the
[Security tab](https://github.com/Influence360/tracking-pixel/security/advisories/new) and open a draft
advisory. Only the maintainers can see it, and it stays private until we publish a fix.

What helps most, in rough order of usefulness:

- The published version affected — the `version` field in
  [manifest.json](https://tracking-pixel.influence360.io/manifest.json), or the URL your page loads.
- What an attacker gains, concretely.
- A reproduction: a page that triggers it, or the sequence of `influence360(...)` calls.

**We will acknowledge your report within 3 business days.** We are a small team, so we would rather give
you a firm acknowledgement window than promise a fix window we might miss — we will tell you our
assessment and intended timeline in that first reply.

We do not run a paid bug bounty. We will credit you in the advisory and the changelog unless you ask us
not to.

## Scope

In scope — this repository, and the artifacts built from it:

- `influence360.js`, at any published version.
- The bootstrap snippet in [`snippet/bootstrap.html`](snippet/bootstrap.html).
- The build and publish pipeline in [`.github/workflows`](.github/workflows) and
  [`scripts/`](scripts) — including anything that would let a third party publish bytes under our CDN
  paths, or make a published artifact differ from what this source builds.

Out of scope here, but still very much wanted — report these the same way:

- The collector API the pixel posts to, and everything behind it.
- The Influence360 web application.

## What this script is designed to do, and not do

Useful context when judging whether a behaviour is a bug:

- It reads a referral id from the landing URL and stores it in a first-party cookie on **the site that
  embeds it**, then sends conversion beacons to the collector. It does not read cookies or storage it did
  not write, does not fingerprint the device, and does not collect form fields, keystrokes or page
  content.
- The public token in the snippet **is not a secret**. It identifies a company, is visible in page source
  by design, and confers no ability to read data. A report that amounts to "the token is visible" is
  working as intended; a report that it can be used to _read_ anything is a vulnerability.
- Conversion values sent from the browser are **user-editable by design** — anyone can open devtools and
  call `track()` with a different amount. That is why value-gated conversions should use the
  server-to-server postback instead. Browser-reported amounts being forgeable is a documented property,
  not a finding; a way to forge them **through the postback** would be.
- The tracker is built never to throw into the host page and never to block rendering. A case where it
  does either is a bug worth reporting even if it is not a security issue.

## Verifying what you are running

Every published build is listed in [manifest.json](https://tracking-pixel.influence360.io/manifest.json)
with its `sha256` and the `sha384` used for Subresource Integrity. Versioned paths are immutable and are
never republished with different bytes, so you can pin one and check it:

```bash
curl -s https://tracking-pixel.influence360.io/v1.0.0/influence360.js \
  | openssl dgst -sha384 -binary | openssl base64 -A
```

Builds are also reproducible from source (`npm run verify:reproducible`) and carry
[sigstore](https://www.sigstore.dev/) build provenance from the GitHub Actions workflow that published
them. If a hash you compute does not match the manifest, treat that as a security report.
