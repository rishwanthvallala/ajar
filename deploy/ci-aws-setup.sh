#!/usr/bin/env bash
# Once, by hand: let GitHub Actions deploy to the relay. Read it, then:
#
#     ./deploy/ci-aws-setup.sh             set up; run again any time, it changes nothing twice
#     ./deploy/ci-aws-setup.sh --rotate    the same, with a new CI key
#
# With the AWS profile `personal` (AWS_PROFILE to change it), as ~/.ssh/config
# reaches ajar-relay with. In the AWS account it makes:
#
#   - GitHub as an OpenID Connect identity provider, so GitHub keeps no AWS
#     keys: a job trades its own short-lived token for the role below.
#   - the role ajar-deploy-github. Only a workflow on this repository's main
#     branch can take it, and it can do two things: open an SSH session over
#     SSM to the relay instance, and read one parameter, the CI key.
#   - the parameter /ajar/deploy/ci-ssh-key: an SSH key made here for CI
#     alone, its private half encrypted in Parameter Store and nowhere else.
#
# On the relay, it adds that key's public half to ubuntu's authorized_keys —
# the line ending `ajar-ci-deploy`, which --rotate replaces; no other line is
# touched. CI then reaches the relay as a deploy from a laptop does.
#
# In this repository it writes two files to commit: deploy/ci-deploy.pub, the
# public key, and deploy/known_hosts, the relay's host key as this machine
# knows it, which CI checks the relay against. Once they are on main, a run
# that passes deploys.
#
# To undo it all: delete the role, the provider and the parameter, remove the
# `ajar-ci-deploy` line from the relay's ~ubuntu/.ssh/authorized_keys, and
# delete the two files.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE=${AWS_PROFILE:-personal}
REGION=ap-south-1
INSTANCE=i-0ffebdae47c7b633d
REPO=rishwanthvallala/ajar
ROLE=ajar-deploy-github
PARAM=/ajar/deploy/ci-ssh-key
HOST=ajar-relay
aws() { command aws --profile "$PROFILE" "$@"; }
say() { printf '  %s\n' "$*"; }

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
PROVIDER="arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com"

if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER" >/dev/null 2>&1; then
  say "GitHub is already an identity provider"
else
  aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com >/dev/null
  say "made GitHub an identity provider"
fi

trust=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "$PROVIDER" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": { "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:$REPO:ref:refs/heads/main"
    } }
  }]
}
EOF
)
policy=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SshToTheRelayOverSsm",
      "Effect": "Allow",
      "Action": "ssm:StartSession",
      "Resource": [
        "arn:aws:ec2:$REGION:$ACCOUNT:instance/$INSTANCE",
        "arn:aws:ssm:$REGION::document/AWS-StartSSHSession"
      ],
      "Condition": { "BoolIfExists": { "ssm:SessionDocumentAccessCheck": "true" } }
    },
    {
      "Sid": "EndItsOwnSessions",
      "Effect": "Allow",
      "Action": ["ssm:TerminateSession", "ssm:ResumeSession"],
      "Resource": "arn:aws:ssm:$REGION:$ACCOUNT:session/\${aws:userid}-*"
    },
    {
      "Sid": "ReadTheDeployKey",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:$REGION:$ACCOUNT:parameter$PARAM"
    }
  ]
}
EOF
)
if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "$trust"
  say "the role $ROLE was there; its trust is as above"
else
  aws iam create-role --role-name "$ROLE" --max-session-duration 3600 \
    --description "GitHub Actions on $REPO main: deploy to the relay over SSM" \
    --assume-role-policy-document "$trust" >/dev/null
  say "made the role $ROLE"
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name deploy-over-ssm --policy-document "$policy"
say "it can open ssh to $INSTANCE over SSM and read $PARAM, and nothing else"

if [ ! -s deploy/ci-deploy.pub ] || [ "${1:-}" = "--rotate" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  ssh-keygen -q -t ed25519 -N "" -C ajar-ci-deploy -f "$tmp/key"
  aws ssm put-parameter --region "$REGION" --name "$PARAM" --type SecureString \
    --value "file://$tmp/key" --overwrite >/dev/null
  cp "$tmp/key.pub" deploy/ci-deploy.pub
  say "made a CI key: the private half is in $PARAM, the public in deploy/ci-deploy.pub"
fi

key=$(cat deploy/ci-deploy.pub)
ssh "$HOST" "f=\$HOME/.ssh/authorized_keys; grep -qxF '$key' \"\$f\" || { grep -v ' ajar-ci-deploy\$' \"\$f\" > \"\$f.new\"; echo '$key' >> \"\$f.new\"; chmod 600 \"\$f.new\"; mv \"\$f.new\" \"\$f\"; }"
say "the relay takes the CI key"

ssh-keygen -F "$INSTANCE" | grep -v '^#' > deploy/known_hosts || true
if [ ! -s deploy/known_hosts ]; then
  rm -f deploy/known_hosts
  echo "  this machine has no host key for $INSTANCE: ssh $HOST once, then run this again" >&2
  exit 1
fi
say "wrote deploy/known_hosts, the relay's host key"

cat <<EOF

  done. Commit the two files and deploy once from here, which records the
  commit the relay runs; from then on a run that passes on main deploys:

      git add deploy/ci-deploy.pub deploy/known_hosts && git commit -m "deploy: from CI"
      git push --no-verify origin main
EOF
