// Caddy, plus the one plugin this deployment needs: per-address rate limits,
// which the packaged binary cannot do. Everything it is built from is pinned in
// go.mod and go.sum beside this file. Why it exists, and how it reaches the
// server, is in docs/dev/operations.md.
package main

import (
	caddycmd "github.com/caddyserver/caddy/v2/cmd"

	_ "github.com/caddyserver/caddy/v2/modules/standard"
	_ "github.com/mholt/caddy-ratelimit"
)

func main() {
	caddycmd.Main()
}
