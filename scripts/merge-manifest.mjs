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

// Only a missing file is the first publish. One that exists but does not parse, or has no `builds`
// array, is refused: starting over from it would republish an index that has lost every older build.
let manifest = { artifact: 'influence360.js', channels: {}, builds: [] };
let existing;
try {
  existing = await readFile(existingPath, 'utf8');
} catch (err) {
  if (err?.code !== 'ENOENT') throw err;
  console.log(`no existing manifest at ${existingPath} — starting a new one`);
}
if (existing !== undefined) {
  let parsed;
  try {
    parsed = JSON.parse(existing);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed?.builds)) {
    console.error(
      `::error::the published manifest is not a valid index (no builds array) — refusing to replace it with one that drops every older build`,
    );
    process.exit(1);
  }
  manifest = { ...manifest, ...parsed, channels: parsed.channels ?? {} };
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
