-- Saves: a 2 KB main.py into one of 500 pads, different each time.
local pad = string.rep("x", 2000)
request = function()
  wrk.headers["X-Forwarded-For"] = "10." .. math.random(0, 255) .. "." .. math.random(0, 255) .. "." .. math.random(1, 254)
  wrk.headers["Content-Type"] = "application/json"
  local body = '{"writes":[{"path":"main.py","content":"' .. pad .. string.format("%012d", math.random(1, 999999999)) .. '"}]}'
  return wrk.format("PUT", "/api/pad/bench-w-" .. math.random(1, 500), nil, body)
end
