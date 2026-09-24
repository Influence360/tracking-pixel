#!/usr/bin/env bash
#
# GitHub OIDC → first-hop role → target role, exporting the final credentials to later steps.
# Shared by the staging and prod deploy jobs (.github/workflows/build-and-deploy.yml).
#
# This replaces aws-actions/configure-aws-credentials for one reason: that action unconditionally logs
# `Authenticated as assumedRoleId AROA…:<session>` for every hop, and an IAM unique id ENCODES the
# account id (it base32-decodes to it). This repo's run logs are world-readable, so that line publishes
# both account ids on every run however well the role ARNs themselves are masked. Here nothing STS
# returns is ever printed: every response is captured, and every credential is masked before it is
# written to $GITHUB_ENV.
#
# Required env: AWS_GITHUB_ROLE_ARN, TARGET_ROLE_ARN (environment secrets), AWS_REGION, and the
# ACTIONS_ID_TOKEN_REQUEST_* pair the runner provides when the job has `id-token: write`.
set -euo pipefail

: "${AWS_GITHUB_ROLE_ARN:?AWS_GITHUB_ROLE_ARN is required}"
: "${TARGET_ROLE_ARN:?TARGET_ROLE_ARN is required}"
: "${AWS_REGION:?AWS_REGION is required}"
: "${ACTIONS_ID_TOKEN_REQUEST_URL:?no OIDC token endpoint — the job needs permissions: id-token: write}"
: "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?no OIDC token endpoint — the job needs permissions: id-token: write}"

# An STS or S3 error message can quote an ARN or account id; the ARNs are secrets (already masked), the
# bare account ids derived from them are not, so mask those before the first AWS call.
for arn in "$AWS_GITHUB_ROLE_ARN" "$TARGET_ROLE_ARN"; do
  account=$(cut -d: -f5 <<<"$arn")
  if [ -n "$account" ]; then echo "::add-mask::${account}"; fi
done

# Session name must stay `GitHubActions`: the target role's trust policy names the first hop's
# assumed-role session by it.
SESSION_NAME=GitHubActions

token=$(curl -fsS -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
  "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=sts.amazonaws.com" |
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).value)')
echo "::add-mask::${token}"

# Prints `KEY=value` lines for the three credential variables, from an STS `Credentials` object.
creds_to_env() {
  node -e '
    const c = JSON.parse(require("fs").readFileSync(0, "utf8"));
    for (const [k, v] of [
      ["AWS_ACCESS_KEY_ID", c.AccessKeyId],
      ["AWS_SECRET_ACCESS_KEY", c.SecretAccessKey],
      ["AWS_SESSION_TOKEN", c.SessionToken],
    ]) {
      if (!v) { console.error(`STS returned no ${k}`); process.exit(1); }
      console.log(`${k}=${v}`);
    }
  '
}

# Masks each value, then exports the pairs into the current shell.
mask_and_export() {
  local line
  while IFS= read -r line; do
    echo "::add-mask::${line#*=}"
    export "${line?}"
  done
}

# 1. OIDC token → first-hop role. AssumeRoleWithWebIdentity is unsigned, so no credentials are needed.
hop1=$(aws sts assume-role-with-web-identity \
  --role-arn "$AWS_GITHUB_ROLE_ARN" \
  --role-session-name "$SESSION_NAME" \
  --web-identity-token "$token" \
  --query Credentials --output json | creds_to_env)
mask_and_export <<<"$hop1"
unset token hop1

# 2. First hop → target role, tagged so CloudTrail shows which run made the call.
hop2=$(aws sts assume-role \
  --role-arn "$TARGET_ROLE_ARN" \
  --role-session-name "$SESSION_NAME" \
  --tags "Key=Repository,Value=${GITHUB_REPOSITORY}" \
  "Key=Commit,Value=${GITHUB_SHA}" \
  "Key=RunId,Value=${GITHUB_RUN_ID}" \
  --query Credentials --output json | creds_to_env)
mask_and_export <<<"$hop2"

# 3. Hand the target-role credentials to the steps that follow (values are masked above).
{
  echo "$hop2"
  echo "AWS_DEFAULT_REGION=${AWS_REGION}"
} >>"$GITHUB_ENV"
unset hop2

echo "AWS credentials configured for the target role"
