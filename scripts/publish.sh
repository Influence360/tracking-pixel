#!/usr/bin/env bash
#
# Publishes the built pixel to the S3 bucket fronted by CloudFront and updates the public manifest.
# Shared by the staging and prod deploy jobs (.github/workflows/build-and-deploy.yml) so the two
# cannot drift.
#
# Three objects, three cache policies:
#   v<version>/influence360.js  immutable, 1y   — what customers pin with integrity=. NEVER overwritten.
#   v<major>/influence360.js    rolling, 5m/1d  — the auto-update channel, overwritten each release.
#   manifest.json               60s             — the index of published builds + their hashes.
#
# Overwriting a pinned object would silently invalidate every `integrity=` referencing it (the
# customer's browser then refuses to run the script), so a version whose bytes differ from what is
# already published is a hard failure, not an overwrite. Re-publishing identical bytes is a no-op, so
# re-running a deploy is safe.
#
# Every read of the bucket fails CLOSED. "Is it already published?" is answered "no" only when S3 says
# 404; a 403, a throttle, a 5xx or a network error ends the deploy, because reading any of them as "not
# there" would upload over a pinned object (step 2) or republish a manifest that has lost every older
# build (step 4). A genuinely missing key answers 404 rather than 403 only because the deploy role holds
# s3:ListBucket on the bucket — without it, every first publish of a version fails here, loudly.
#
# Required env: S3_BUCKET, PUBLIC_HOST. Requires: aws, node, jq-free (node parses the JSON).
set -euo pipefail

: "${S3_BUCKET:?S3_BUCKET is required}"
: "${PUBLIC_HOST:?PUBLIC_HOST is required}"

read_entry() { node -p "require('./dist/manifest-entry.json').$1"; }

AWS_ERR=$(mktemp)
trap 'rm -f "$AWS_ERR"' EXIT

# Runs an aws call that may legitimately find nothing: returns 0 when it succeeded (stdout passes
# through), 3 when S3 answered 404, and ends the deploy on any other failure. The AWS CLI exits non-zero
# for every error class alike, so the HTTP status in the message is the only thing telling them apart.
# The error is printed with the bucket name replaced: it is a masked secret, but the mask is only as good
# as the value being stored as one.
aws_unless_missing() {
  local status=0 err
  "$@" 2>"$AWS_ERR" || status=$?
  [ "$status" -eq 0 ] && return 0
  grep -q 'An error occurred (404)' "$AWS_ERR" && return 3
  err=$(tr '\n' ' ' <"$AWS_ERR")
  echo "::error::aws $2 $3 failed (exit ${status}), refusing to treat it as not-published: ${err//"$S3_BUCKET"/<bucket>}" >&2
  exit 1
}

VERSION=$(read_entry version)
SHA256=$(read_entry sha256)
SHA384=$(read_entry sha384)
IMMUTABLE_KEY="v${VERSION}/influence360.js"
# rollingPath is '/vN/influence360.js' — strip the leading slash to get the S3 key.
ROLLING_PATH=$(read_entry rollingPath)
ROLLING_KEY="${ROLLING_PATH#/}"
CONTENT_TYPE="application/javascript; charset=utf-8"

# Only public values are logged: this repo's build logs are world-readable, so the bucket name stays out
# of them (the CDN host is the customer-facing URL, so it is fine). S3_BUCKET is also a masked secret, but
# every `aws s3 cp` still runs with --only-show-errors: its default `upload: … to s3://<bucket>/…` line is
# exactly the leak, and the mask is only as good as the value being stored as a secret.
echo "publishing influence360.js v${VERSION} to ${PUBLIC_HOST}"
echo "  ${SHA384}"

########################################################################################################
# 1. Read everything the deploy depends on BEFORE writing anything, so a failed read ends the deploy
#    with the bucket untouched rather than half-published (rolling channel updated, manifest not).

# 1a. Is the pinned version already published? Only exit 3 (a 404) means "no"; any other non-zero
#     status — including a failed redirect that never ran aws — ends the deploy.
head_status=0
aws_unless_missing aws s3api head-object --bucket "$S3_BUCKET" --key "$IMMUTABLE_KEY" \
  >dist/published-head.json || head_status=$?
if [ "$head_status" -eq 0 ]; then
  published_sha=$(node -e '
    const meta = require("./dist/published-head.json").Metadata ?? {};
    process.stdout.write(meta.sha256 ?? "");
  ')
  if [ -z "$published_sha" ]; then
    echo "::error::${IMMUTABLE_KEY} already exists without a sha256 tag — refusing to overwrite a pinned object. Bump the version in package.json."
    exit 1
  fi
  if [ "$published_sha" != "$SHA256" ]; then
    echo "::error::${IMMUTABLE_KEY} is already published with different bytes (published ${published_sha}, built ${SHA256}). Overwriting it would break every customer pinning that integrity hash. Bump the version in package.json."
    exit 1
  fi
  upload_pinned=false
elif [ "$head_status" -eq 3 ]; then
  upload_pinned=true
else
  echo "::error::could not check whether ${IMMUTABLE_KEY} is published (status ${head_status})" >&2
  exit 1
fi

# 1b. The published manifest, merged with this build. Only a 404 is "nothing published yet";
#     merge-manifest.mjs then starts a new index from this build.
rm -f dist/published-manifest.json
manifest_status=0
aws_unless_missing aws s3 cp --only-show-errors "s3://${S3_BUCKET}/manifest.json" \
  dist/published-manifest.json || manifest_status=$?
if [ "$manifest_status" -eq 3 ]; then
  rm -f dist/published-manifest.json
  echo "  no published manifest yet"
elif [ "$manifest_status" -ne 0 ]; then
  echo "::error::could not read the published manifest (status ${manifest_status})" >&2
  exit 1
fi
node scripts/merge-manifest.mjs dist/published-manifest.json dist/manifest.json

# 1c. The distribution to invalidate. A distribution with no aliases has no Aliases.Items at all, and
#     contains() on null is a type error.
DIST_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?contains(Aliases.Items || \`[]\`, '${PUBLIC_HOST}')].Id | [0]" \
  --output text)
if [ -z "$DIST_ID" ] || [ "$DIST_ID" = "None" ]; then
  echo "::error::No CloudFront distribution found for alias ${PUBLIC_HOST}"
  exit 1
fi
# A denied invalidation's error quotes the distribution ARN, id included.
echo "::add-mask::${DIST_ID}"

########################################################################################################
# 2. Immutable pinned object — write once, verify on re-run.
if [ "$upload_pinned" = true ]; then
  aws s3 cp --only-show-errors dist/influence360.js "s3://${S3_BUCKET}/${IMMUTABLE_KEY}" \
    --content-type "$CONTENT_TYPE" \
    --cache-control "public, max-age=31536000, immutable" \
    --metadata "sha256=${SHA256},sha384=${SHA384},version=${VERSION}"
  echo "  published ${IMMUTABLE_KEY}"
else
  echo "  ${IMMUTABLE_KEY} already published with identical bytes — skipping"
fi

########################################################################################################
# 3. Rolling major channel — the default snippet; auto-updates within the major.
aws s3 cp --only-show-errors dist/influence360.js "s3://${S3_BUCKET}/${ROLLING_KEY}" \
  --content-type "$CONTENT_TYPE" \
  --cache-control "public, max-age=300, s-maxage=86400" \
  --metadata "sha256=${SHA256},sha384=${SHA384},version=${VERSION}"

########################################################################################################
# 4. Public manifest (merged in 1b).
aws s3 cp --only-show-errors dist/manifest.json "s3://${S3_BUCKET}/manifest.json" \
  --content-type "application/json; charset=utf-8" \
  --cache-control "public, max-age=60"

########################################################################################################
# 5. Invalidate only the mutable objects. The pinned path is immutable, so it is never in the way.
echo "  invalidating /${ROLLING_KEY} and /manifest.json"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" \
  --paths "/${ROLLING_KEY}" "/manifest.json" >/dev/null

########################################################################################################
# 6. Publish the hashes where a human can read them (the manifest is the machine-readable copy).
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### influence360.js v${VERSION} → ${PUBLIC_HOST}"
    echo
    echo "| | |"
    echo "|---|---|"
    echo "| Pinned URL | \`https://${PUBLIC_HOST}/${IMMUTABLE_KEY}\` |"
    echo "| Rolling URL | \`https://${PUBLIC_HOST}/${ROLLING_KEY}\` |"
    echo "| Integrity | \`${SHA384}\` |"
    echo "| sha256 | \`${SHA256}\` |"
    echo "| Manifest | \`https://${PUBLIC_HOST}/manifest.json\` |"
  } >>"$GITHUB_STEP_SUMMARY"
fi
