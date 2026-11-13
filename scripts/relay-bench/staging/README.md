# The 10k test on AWS's own hardware

What `docs/dev/scaling.md`, "On the box's own hardware", was measured with on
13 November 2026: a t4g.small like production's, set up as production runs —
the relay with its flags, memory cap and limits, Caddy with production's
Caddyfile and its logs — and a load generator beside it. Never production.

1. `up.sh` — the two machines, in a security group that lets them reach
   only each other; prints their ids and private addresses. Costs cents an
   hour.
2. Copy the relay's Linux build (`scripts/relay-bench/run.sh` says how),
   `dist/caddy-linux-arm64`, `deploy/limits.env` and `deploy/Caddyfile`
   (as `Caddyfile.prod`) to staging's `/opt/ajar/` over SSM, and run
   `setup-staging.sh <load generator's private address>` there: production's
   Caddyfile on internal certificates, believing the load generator's
   `CF-Connecting-IP` as cloudflared's would be.
3. On the load generator: `apt-get install wrk`, `code.rishwanth.dev` in
   `/etc/hosts` as staging's address, these files in `~/lg/`, a session in
   staging's accounts database (sqlite3, as `scripts/relay-bench/inside.sh`
   makes one), then `seed.sh` and `run.sh` (every endpoint) or `sub.sh` (the
   ones that tell fronts apart), with `U`, `ADDR_HEADER`, `TOKEN`, `OWNED`,
   `SEQ` set.
4. `swap-relay.sh <binary>` on staging tries another build on the same data.
5. `down.sh` — terminates both and deletes the group, found by tag; checks
   that nothing is left and that production is still running.

SSH to either machine over SSM, with production's key:

    ssh -i ~/.ssh/ajar-relay.pem -o ProxyCommand='sh -c "aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p --profile personal --region ap-south-1"' ubuntu@<instance id>
