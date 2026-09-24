// @vitest-environment node
//
// Runs the real scripts/publish.sh against a stub `aws` that serves a fake bucket out of a directory,
// so the deploy's decisions — upload, skip, refuse — are asserted without AWS. The stub answers a
// missing key the way the real CLI does (an error naming the HTTP status), and can be told to fail any
// read with an arbitrary error instead.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

const BUCKET = 'a38be94d-test-tracking-pixel';
const VERSION = '9.8.7';
const SHA256 = 'sha256-built';
const IMMUTABLE_KEY = `v${VERSION}/influence360.js`;
const FORBIDDEN =
  'aws: [ERROR]: An error occurred (403) when calling the HeadObject operation: Forbidden';
const THROTTLED =
  'aws: [ERROR]: An error occurred (503) when calling the HeadObject operation: Slow Down';

const STUB_AWS = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, args.join(' ') + '\\n');
const bucketDir = process.env.STUB_BUCKET_DIR;
const opt = (name) => args[args.indexOf(name) + 1];
const fail = (message, code) => {
  process.stderr.write('\\n' + message + '\\n');
  process.exit(code);
};
const [service, op] = args;
if (service === 's3api' && op === 'head-object') {
  if (process.env.STUB_HEAD_ERROR) fail(process.env.STUB_HEAD_ERROR, 254);
  const file = path.join(bucketDir, opt('--key'));
  if (!fs.existsSync(file))
    fail('aws: [ERROR]: An error occurred (404) when calling the HeadObject operation: Not Found', 254);
  const meta = fs.existsSync(file + '.meta') ? JSON.parse(fs.readFileSync(file + '.meta', 'utf8')) : {};
  process.stdout.write(JSON.stringify({ ContentLength: 1, Metadata: meta }));
} else if (service === 's3' && op === 'cp') {
  const [src, dst] = args.filter((a, i) => i > 1 && !a.startsWith('--') && !args[i - 1].match(/^--(content-type|cache-control|metadata)$/));
  if (src.startsWith('s3://')) {
    const key = src.replace(/^s3:\\/\\/[^/]+\\//, '');
    if (process.env.STUB_GET_ERROR) fail(process.env.STUB_GET_ERROR.replace('<src>', src), 1);
    const file = path.join(bucketDir, key);
    if (!fs.existsSync(file))
      fail('fatal error: An error occurred (404) when calling the HeadObject operation: Key "' + key + '" does not exist', 1);
    fs.copyFileSync(file, dst);
  } else {
    const key = dst.replace(/^s3:\\/\\/[^/]+\\//, '');
    const file = path.join(bucketDir, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(src, file);
    if (args.includes('--metadata'))
      fs.writeFileSync(file + '.meta', JSON.stringify(Object.fromEntries(opt('--metadata').split(',').map((kv) => kv.split('=')))));
  }
} else if (service === 'cloudfront' && op === 'list-distributions') {
  // The account holds a distribution with no aliases, so a query calling contains() on a bare
  // Aliases.Items fails the way the real CLI does.
  if (!opt('--query').includes('contains(Aliases.Items || \`[]\`,'))
    fail('In function contains(), invalid type for value: None, expected one of: [\\'array\\', \\'string\\'], received: "null"', 255);
  process.stdout.write('E1STUB\\n');
} else if (service === 'cloudfront' && op === 'create-invalidation') {
  process.stdout.write('{}\\n');
} else {
  fail('stub aws: unexpected call ' + args.join(' '), 2);
}
`;

let root: string;
let bucketDir: string;
let logFile: string;

const repoFile = (rel: string) =>
  fileURLToPath(new URL(`../${rel}`, import.meta.url));

function putObject(key: string, body: string, meta?: Record<string, string>) {
  const file = join(bucketDir, key);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  if (meta) writeFileSync(`${file}.meta`, JSON.stringify(meta));
}

const objectBody = (key: string) => readFileSync(join(bucketDir, key), 'utf8');

function publish(env: Record<string, string> = {}) {
  const result = spawnSync('bash', ['scripts/publish.sh'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      S3_BUCKET: BUCKET,
      PUBLIC_HOST: 'cdn.example',
      STUB_BUCKET_DIR: bucketDir,
      STUB_LOG: logFile,
      ...env,
    },
  });
  const calls = existsSync(logFile)
    ? readFileSync(logFile, 'utf8').trim().split('\n')
    : [];
  return { ...result, output: result.stdout + result.stderr, calls };
}

/** Every upload: an `s3 cp` from a local file to the bucket. */
const writes = (calls: string[]) =>
  calls.filter((c) => /^s3 cp .*\sdist\/\S+ s3:\/\//.test(c));

const uploadsTo = (calls: string[], key: string) =>
  calls.filter(
    (c) => c.startsWith('s3 cp') && c.includes(`s3://${BUCKET}/${key} --`),
  );

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'publish-test-'));
  bucketDir = join(root, 'bucket');
  logFile = join(root, 'aws-calls.log');
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'dist'));
  mkdirSync(join(root, 'bin'));
  mkdirSync(bucketDir);
  for (const script of ['publish.sh', 'merge-manifest.mjs']) {
    copyFileSync(repoFile(`scripts/${script}`), join(root, 'scripts', script));
  }
  writeFileSync(join(root, 'bin', 'aws'), STUB_AWS);
  chmodSync(join(root, 'bin', 'aws'), 0o755);
  writeFileSync(join(root, 'dist', 'influence360.js'), 'new bytes');
  writeFileSync(
    join(root, 'dist', 'manifest-entry.json'),
    JSON.stringify({
      version: VERSION,
      path: `/${IMMUTABLE_KEY}`,
      rollingPath: '/v9/influence360.js',
      sha256: SHA256,
      sha384: 'sha384-built',
      builtAtMs: 1,
    }),
  );
});

describe('publish.sh — the pinned object', () => {
  it('uploads the pinned object when S3 answers 404', () => {
    const run = publish();

    expect(run.status, run.output).toBe(0);
    expect(objectBody(IMMUTABLE_KEY)).toBe('new bytes');
  });

  it('skips the upload when the published bytes are identical', () => {
    putObject(IMMUTABLE_KEY, 'new bytes', { sha256: SHA256 });

    const run = publish();

    expect(run.status, run.output).toBe(0);
    expect(uploadsTo(run.calls, IMMUTABLE_KEY)).toEqual([]);
    expect(run.output).toContain('already published with identical bytes');
  });

  it('refuses to overwrite a pinned object with different bytes', () => {
    putObject(IMMUTABLE_KEY, 'old bytes', { sha256: 'sha256-old' });

    const run = publish();

    expect(run.status).toBe(1);
    expect(run.output).toContain('already published with different bytes');
    expect(objectBody(IMMUTABLE_KEY)).toBe('old bytes');
  });

  it.each([
    ['a 403', FORBIDDEN],
    ['a throttle', THROTTLED],
  ])(
    'fails the deploy, and uploads nothing, when head-object returns %s',
    (_, error) => {
      putObject(IMMUTABLE_KEY, 'old bytes', { sha256: 'sha256-old' });

      const run = publish({ STUB_HEAD_ERROR: error });

      expect(run.status).toBe(1);
      expect(run.output).toContain('refusing to treat it as not-published');
      expect(run.calls.filter((c) => c.startsWith('s3 cp'))).toEqual([]);
      expect(objectBody(IMMUTABLE_KEY)).toBe('old bytes');
    },
  );
});

describe('publish.sh — the manifest', () => {
  const olderBuild = { version: '9.8.6', sha256: 'sha256-older' };

  it('keeps every older build when merging into the published manifest', () => {
    putObject(
      'manifest.json',
      JSON.stringify({ artifact: 'influence360.js', builds: [olderBuild] }),
    );

    const run = publish();

    expect(run.status, run.output).toBe(0);
    const published = JSON.parse(objectBody('manifest.json'));
    expect(published.builds.map((b: { version: string }) => b.version)).toEqual(
      [VERSION, '9.8.6'],
    );
  });

  it('starts a new manifest when S3 answers 404', () => {
    const run = publish();

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('no published manifest yet');
    const published = JSON.parse(objectBody('manifest.json'));
    expect(published.builds.map((b: { version: string }) => b.version)).toEqual(
      [VERSION],
    );
  });

  it('fails the deploy, and keeps the published manifest, when the download fails for any other reason', () => {
    const existing = JSON.stringify({ builds: [olderBuild] });
    putObject('manifest.json', existing);

    const run = publish({
      STUB_GET_ERROR:
        'download failed: <src> to dist/published-manifest.json An error occurred (AccessDenied) when calling the GetObject operation: Access Denied',
    });

    expect(run.status).toBe(1);
    // Every read runs before the first write, so nothing — not even the rolling channel — is published.
    expect(writes(run.calls)).toEqual([]);
    expect(objectBody('manifest.json')).toBe(existing);
    // The error is printed, but never with the bucket name in it.
    expect(run.output).toContain('AccessDenied');
    expect(run.output).toContain('s3://<bucket>/manifest.json');
    expect(run.output).not.toContain(BUCKET);
  });

  it('fails the deploy, and keeps the published manifest, when it is not a valid index', () => {
    putObject('manifest.json', '{"builds": [');

    const run = publish();

    expect(run.status).toBe(1);
    expect(run.output).toContain('not a valid index');
    expect(writes(run.calls)).toEqual([]);
    expect(objectBody('manifest.json')).toBe('{"builds": [');
  });
});

describe('publish.sh — the invalidation', () => {
  it('finds the distribution when another one in the account has no aliases', () => {
    const run = publish();

    expect(run.status, run.output).toBe(0);
    expect(
      run.calls.filter((c) => c.startsWith('cloudfront create-invalidation')),
    ).toHaveLength(1);
  });
});
