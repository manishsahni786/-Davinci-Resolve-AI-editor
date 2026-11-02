-- Lua-side tests for the dependency-free JSON implementation.
-- Run with: npm run lua:test

local source = debug.getinfo(1, "S").source or ""
local testDir = source:match("^@(.*)[\\/][^\\/]+$") or "."
local root = testDir:match("^(.*)[\\/][^\\/]+$") or "."
local json = dofile(root .. "\\lib\\json.lua")

local passed = 0
local function check(condition, message)
  if not condition then
    error("FAIL: " .. message, 0)
  end
  passed = passed + 1
end

local decoded = json.decode('{"text":"hello","n":12.5,"ok":true,"arr":[1,2,3]}')
check(decoded.text == "hello", "string decode")
check(decoded.n == 12.5, "number decode")
check(decoded.ok == true, "boolean decode")
check(decoded.arr[3] == 3, "array decode")

local encoded = json.encode(decoded)
local roundTrip = json.decode(encoded)
check(roundTrip.text == "hello", "string round trip")
check(roundTrip.arr[1] == 1, "array round trip")

local unicode = json.decode('"caf\\u00e9 \\ud83d\\ude00"')
check(unicode == "café 😀", "unicode escape and surrogate pair")

local nullValue = json.decode('{"none":null}')
check(nullValue.none == json.null, "null sentinel")

local nested = json.decode('{"a":{"b":[true,false,null]}}')
check(nested.a.b[1] == true and nested.a.b[2] == false and nested.a.b[3] == json.null, "nested values")

check(json.encode({}) == "{}", "empty object")
check(json.encode({ 1, 2 }) == "[1,2]", "array encode")

local ok = pcall(json.decode, '{"broken":')
check(not ok, "invalid JSON must fail")

local escaped = json.encode({ text = 'line\n"quote"' })
local escapedRoundTrip = json.decode(escaped)
check(escapedRoundTrip.text == 'line\n"quote"', "escaping round trip")

print("Lua JSON tests passed: " .. tostring(passed))
