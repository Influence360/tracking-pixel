/**
 * Reproducible-build check: builds twice and asserts the bundle hashes match.
 *
 * A published sha384 is only worth something if a third party rebuilding from the same commit gets
 * the same bytes — that is what makes the provenance attestation (and the customer's `integrity=`)
 * verifiable rather than a claim. esbuild is deterministic today; this pins it so a future flag or
 * dependency bump that injects a timestamp/path into the bundle fails CI instead of silently making
 * our hashes unverifiable.
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const buildOnce = async () => {
  execFileSync('node', ['build.mjs'], { stdio: 'inherit' });
  const { sha256, bytes } = JSON.parse(
    await readFile('dist/manifest-entry.json', 'utf8'),
  );
  return { sha256, bytes };
};

const first = await buildOnce();
const second = await buildOnce();

if (first.sha256 !== second.sha256) {
  console.error(
    `build is not reproducible:\n  1st: ${first.sha256} (${first.bytes} bytes)\n  2nd: ${second.sha256} (${second.bytes} bytes)`,
  );
  process.exit(1);
}

console.log(`build is reproducible: ${first.sha256}`);
