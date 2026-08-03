import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

/**
 * Bundles src/influence360.ts into a single minified IIFE at dist/influence360.js — the artifact uploaded to
 * S3/CloudFront under an immutable versioned path (/v<version>/influence360.js) plus the rolling major
 * channel (/v1/influence360.js). The collector URL is baked in at build time and defaults to the
 * production collector; override via INFLUENCE360_COLLECT_URL.
 *
 * Also emits dist/manifest-entry.json — the integrity record for this build (sha256 + the sha384 that
 * customers paste into `integrity=`). scripts/publish.sh merges it into the bucket's public
 * manifest.json, so every published build has a verifiable hash. Keep the bundle deterministic: the
 * hash is only meaningful if a rebuild from the same commit produces the same bytes
 * (`npm run verify:reproducible`).
 */
const collectUrl =
  process.env.INFLUENCE360_COLLECT_URL ??
  'https://tracking.influence360.io/public/pixel/conversion';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));

await build({
  entryPoints: ['src/influence360.ts'],
  outfile: 'dist/influence360.js',
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2017'],
  legalComments: 'none',
  define: {
    __INFLUENCE360_COLLECT_URL__: JSON.stringify(collectUrl),
  },
});

const bytes = await readFile('dist/influence360.js');
/** An SRI-formatted digest (`<algo>-<base64>`) — the exact string an `integrity=` attribute takes. */
const digest = (algorithm) =>
  `${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}`;

// SOURCE_DATE_EPOCH (seconds, the reproducible-builds convention) wins when set, so a rebuild can
// reproduce the manifest entry too — not just the bundle.
const builtAtMs = process.env.SOURCE_DATE_EPOCH
  ? Number(process.env.SOURCE_DATE_EPOCH) * 1000
  : Date.now();

const major = pkg.version.split('.')[0];
const entry = {
  version: pkg.version,
  /** Immutable path — never overwritten. What a customer pins with `integrity=`. */
  path: `/v${pkg.version}/influence360.js`,
  /** Rolling major channel — overwritten by each release in this major. Not pinnable. */
  rollingPath: `/v${major}/influence360.js`,
  bytes: bytes.length,
  sha256: digest('sha256'),
  /** The SRI value for `integrity=` (sha384 is the SRI default and what the portal renders). */
  sha384: digest('sha384'),
  gitSha: process.env.GITHUB_SHA ?? null,
  builtAtMs,
  collectUrl,
};

await writeFile(
  'dist/manifest-entry.json',
  `${JSON.stringify(entry, null, 2)}\n`,
);

console.log(
  `built dist/influence360.js v${entry.version} (${entry.bytes} bytes, collector: ${collectUrl})\n` +
    `  ${entry.sha384}`,
);
