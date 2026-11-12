-- Each request from an address of its own, as many visitors behind Caddy.
request = function()
  wrk.headers["X-Forwarded-For"] = "10." .. math.random(0, 255) .. "." .. math.random(0, 255) .. "." .. math.random(1, 254)
  return wrk.format(nil)
end
