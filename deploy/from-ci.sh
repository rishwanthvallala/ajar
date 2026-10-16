#!/usr/bin/env bash
# The deploy, from GitHub Actions: .github/workflows/ci.yml runs this once
# every check is green on main. It is deploy.sh, as from a laptop, after three
# things a laptop already has:
#
#   ssh to the relay    over SSM, with the CI key from Parameter Store, and
#                       the relay's host key from deploy/known_hosts
#   the packages        the pad's 1 GB of runtime packages, which are not in
#                       git and partly need the Java build to make: taken from
#                       the relay, which serves exactly the ones deployed
#   a reason to trust   that taking them is right: nothing that makes the
#     them              packages has changed since the commit the relay runs,
#                       and every package the code pins is among them
#
# When the last two do not hold, it deploys nothing and says to deploy from a
# machine that builds the packages — a few times a month at most. Set up once
# with deploy/ci-aws-setup.sh; see docs/dev/operations.md, "Deploying from CI".
set -euo pipefail
cd "$(dirname "$0")/.."

HOST=ajar-relay
INSTANCE=i-0ffebdae47c7b633d

# Not deployed, and why. A warning, not a failure: main is still green, and
# what to do is in the message.
pass() {
  echo "::warning title=not deployed from CI::$1 — deploy this one from a machine that builds the packages: ./deploy/deploy.sh ajar-relay"
  exit 0
}

# ------------------------------------------------------------------ ssh

mkdir -p ~/.ssh
chmod 700 ~/.ssh
aws ssm get-parameter --name /ajar/deploy/ci-ssh-key --with-decryption \
  --query Parameter.Value --output text > ~/.ssh/ajar-relay.pem
chmod 600 ~/.ssh/ajar-relay.pem
cat > ~/.ssh/config <<EOF
Host $HOST
  HostName $INSTANCE
  User ubuntu
  IdentityFile ~/.ssh/ajar-relay.pem
  IdentitiesOnly yes
  UserKnownHostsFile $PWD/deploy/known_hosts
  StrictHostKeyChecking yes
  ServerAliveInterval 30
  ProxyCommand sh -c "aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p"
EOF

if ! ssh -o BatchMode=yes -o ConnectTimeout=60 "$HOST" true; then
  pass "the relay does not take the CI key: deploy/ci-aws-setup.sh, run by hand, authorizes it"
fi

# ------------------------------------------------------- what may be used

deployed=$(ssh "$HOST" "cat /srv/ajar/deployed 2>/dev/null" || true)
[ -n "$deployed" ] || pass "the relay does not say which commit it runs"
case "$deployed" in
  *-dirty) pass "the relay runs $deployed, from a tree with changes not in git" ;;
esac
git cat-file -e "$deployed^{commit}" 2>/dev/null || pass "the relay runs $deployed, which is not in this history"
git merge-base --is-ancestor "$deployed" HEAD || pass "the relay runs $deployed, which is not behind this commit"

# What makes the packages, rather than names them: the Java build, the trim,
# the recording of what is downloaded, and the service worker's own pin.
changed=$(git diff --name-only "$deployed" HEAD -- \
  pad/scripts/build-java.mjs pad/scripts/java pad/scripts/webc-trim pad/scripts/fetch-packages.mjs pad/public/sw.js)
[ -z "$changed" ] || pass "what makes the packages changed since $deployed: $(echo "$changed" | tr '\n' ' ')"

# ---------------------------------------------------------------- packages

echo "  the packages, from the relay"
mkdir -p pad/public/packages
rsync -a --delete --checksum "$HOST:/srv/ajar/pad/packages/" pad/public/packages/

# Every package the code pins, at that version, is one the relay has: a pin
# changed in runtime.ts or toolchains.ts needs fetch-packages.mjs, which this
# does not run.
if ! missing=$(python3 - <<'PY'
import json, re, sys
pins = set()
for path in ("pad/src/runtime.ts", "pad/src/toolchains.ts", "pad/public/sw.js"):
    text = open(path, encoding="utf-8").read()
    pins |= set(re.findall(r"""["'`]([a-z0-9_-]+/[a-z0-9_.-]+)@=([0-9][^"'`\s]*)["'`]""", text))
have = {}
for name in ("registry.json", "own.json"):
    data = json.load(open(f"pad/public/packages/{name}", encoding="utf-8"))
    for package, answer in data.get("answers", data).items():
        for version in answer["data"]["getPackage"]["versions"]:
            have.setdefault(package, set()).add(version["version"])
missing = sorted(f"{p}@={v}" for p, v in pins if v not in have.get(p, set()))
print(" ".join(missing))
sys.exit(1 if missing else 0)
PY
); then
  pass "the code pins packages the relay does not have: $missing"
fi

# ------------------------------------------------------------------ deploy

./deploy/deploy.sh "$HOST"
