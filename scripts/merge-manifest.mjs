/**
 * Merges this build's integrity record (dist/manifest-entry.json) into the bucket's public
 * manifest.json — the machine-readable index of every published build.
 *
 * Usage: node scripts/merge-manifest.mjs <existing-manifest-or-missing> <out>
 *
 * The manifest is what the portal reads to render a pinned snippet's `integrity=`, and what a
 * customer (or their PCI script-monitoring tool) reads to verify the bytes they load. Newest build
 * first; re-publishing the same version replaces its entry rather than duplicating it.
 */
import { readFile, writeFile } from 'node:fs/promises';

const [existingPath, outPath] = process.argv.slice(2);
if (!existingPath || !outPath) {
  console.error(
    'usage: node scripts/merge-manifest.mjs <existing-manifest> <out>',
  );
  process.exit(1);
}

const entry = JSON.parse(await readFile('dist/manifest-entry.json', 'utf8'));

// A missing/unreadable existing manifest is the first publish, not an error.
let manifest = { artifact: 'influence360.js', channels: {}, builds: [] };
try {
  const parsed = JSON.parse(await readFile(existingPath, 'utf8'));
  if (Array.isArray(parsed?.builds)) {
    manifest = { ...manifest, ...parsed, channels: parsed.channels ?? {} };
  }
} catch {
  console.log(`no existing manifest at ${existingPath} — starting a new one`);
}

manifest.builds = [
  entry,
  ...manifest.builds.filter((b) => b?.version !== entry.version),
];
// Which version the rolling major channel currently serves, so the portal can show it in
// auto-update mode without guessing.
manifest.channels[entry.rollingPath] = entry.version;
manifest.updatedAtMs = entry.builtAtMs;

await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `manifest: ${manifest.builds.length} build(s), latest ${entry.version}`,
);
