# Changelog

All notable changes to `influence360.js`. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [semver](https://semver.org/).

The version here drives the published paths and is the release's identity:

- `https://tracking-pixel.influence360.io/v<version>/influence360.js` — immutable, safe to pin with
  `integrity=`. Never overwritten.
- `https://tracking-pixel.influence360.io/v<major>/influence360.js` — rolling channel, auto-updates
  within the major. Not pinnable.
- `https://tracking-pixel.influence360.io/manifest.json` — every published build with its `sha256`
  and the `sha384` used for `integrity=`.

**A published version is never republished with different bytes** — the deploy fails instead
(`scripts/publish.sh`). Ship a fix as a new version.

## [Unreleased]

## [1.0.0] — 2026-08-03

First release under the versioned, hash-pinnable distribution scheme. The tracker itself is
unchanged; what changed is how it is published and verified.

### Added

- Immutable per-version path (`/v1.0.0/influence360.js`) alongside the rolling `/v1/` channel, so a
  customer can pin an exact build with Subresource Integrity.
- Public `manifest.json` listing every published build with `sha256`, `sha384` (the SRI value),
  byte size, git SHA, build time and the baked collector URL.
- `integrity` + `crossorigin` support in the bootstrap stub (`snippet/bootstrap.html`) — the portal
  renders the pinned variant with the live hash from the manifest.
- Build provenance: each published artifact carries a sigstore attestation from the GitHub Actions
  build, verifiable with
  `gh attestation verify influence360.js --repo Influence360/tracking-pixel`.
- `npm run verify:reproducible` — builds twice and asserts identical hashes, so a published hash is
  reproducible from source rather than merely asserted.

### Changed

- Pinned objects are served `Cache-Control: public, max-age=31536000, immutable`; the rolling channel
  keeps `max-age=300, s-maxage=86400`.
