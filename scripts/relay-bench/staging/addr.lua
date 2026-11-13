-- Each request from a visitor of its own, in the header the front believes:
-- CF-Connecting-IP through Caddy (as from cloudflared), X-Forwarded-For to
-- the relay directly.
local header = os.getenv("ADDR_HEADER") or "X-Forwarded-For"
request = function()
  wrk.headers[header] = "10." .. math.random(0, 255) .. "." .. math.random(0, 255) .. "." .. math.random(1, 254)
  return wrk.format(nil)
end
