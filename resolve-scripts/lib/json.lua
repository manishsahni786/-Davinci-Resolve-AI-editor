-- Minimal, dependency-free JSON encoder/decoder for Lua 5.1 / LuaJIT.
-- JSON null is represented by the sentinel json.null.

local json = {}
json.null = setmetatable({}, { __tostring = function() return "null" end })

local ESCAPES = {
  ['"'] = '\\"',
  ["\\"] = "\\\\",
  ["\b"] = "\\b",
  ["\f"] = "\\f",
  ["\n"] = "\\n",
  ["\r"] = "\\r",
  ["\t"] = "\\t"
}

local function escapeString(value)
  return '"' .. value:gsub('[%c\\"]', function(character)
    local mapped = ESCAPES[character]
    if mapped then
      return mapped
    end
    return string.format("\\u%04x", string.byte(character))
  end) .. '"'
end

local function isArray(value)
  local count = 0
  for key in pairs(value) do
    if type(key) ~= "number" or key < 1 or key % 1 ~= 0 then
      return false
    end
    count = count + 1
  end
  return count > 0, count
end

local function encodeValue(value, seen)
  if value == nil or value == json.null then
    return "null"
  end

  local valueType = type(value)
  if valueType == "string" then
    return escapeString(value)
  elseif valueType == "number" then
    if value ~= value or value == math.huge or value == -math.huge then
      return "null"
    end
    return string.format("%.14g", value)
  elseif valueType == "boolean" then
    return tostring(value)
  elseif valueType == "table" then
    if seen[value] then
      error("cannot encode a circular table")
    end
    seen[value] = true

    local array, count = isArray(value)
    if array then
      local parts = {}
      for index = 1, count do
        parts[index] = encodeValue(value[index], seen)
      end
      seen[value] = nil
      return "[" .. table.concat(parts, ",") .. "]"
    end

    local keys = {}
    for key in pairs(value) do
      if type(key) ~= "string" and type(key) ~= "number" then
        error("object keys must be strings or numbers")
      end
      keys[#keys + 1] = {
        original = key,
        rendered = tostring(key)
      }
    end
    table.sort(keys, function(left, right)
      return left.rendered < right.rendered
    end)

    local parts = {}
    for _, entry in ipairs(keys) do
      parts[#parts + 1] = escapeString(entry.rendered) .. ":" .. encodeValue(value[entry.original], seen)
    end
    seen[value] = nil
    if #parts == 0 then
      return "{}"
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end

  return "null"
end

function json.encode(value)
  return encodeValue(value, {})
end

local function utf8Character(code)
  if code < 0x80 then
    return string.char(code)
  elseif code < 0x800 then
    return string.char(
      0xC0 + math.floor(code / 0x40),
      0x80 + (code % 0x40)
    )
  elseif code < 0x10000 then
    return string.char(
      0xE0 + math.floor(code / 0x1000),
      0x80 + (math.floor(code / 0x40) % 0x40),
      0x80 + (code % 0x40)
    )
  end
  return string.char(
    0xF0 + math.floor(code / 0x40000),
    0x80 + (math.floor(code / 0x1000) % 0x40),
    0x80 + (math.floor(code / 0x40) % 0x40),
    0x80 + (code % 0x40)
  )
end

function json.decode(text)
  if type(text) ~= "string" then
    error("JSON input must be a string", 0)
  end

  local position = 1
  local length = #text

  local function fail(message)
    error(string.format("JSON error at byte %d: %s", position, message), 0)
  end

  local function skipWhitespace()
    while position <= length do
      local character = text:sub(position, position)
      if character == " " or character == "\n" or character == "\r" or character == "\t" then
        position = position + 1
      else
        return
      end
    end
  end

  local parseValue

  local function parseString()
    position = position + 1
    local parts = {}
    while position <= length do
      local character = text:sub(position, position)
      if character == '"' then
        position = position + 1
        return table.concat(parts)
      elseif character == "\\" then
        position = position + 1
        local escaped = text:sub(position, position)
        local simple = {
          ['"'] = '"',
          ["\\"] = "\\",
          ["/"] = "/",
          ["b"] = "\b",
          ["f"] = "\f",
          ["n"] = "\n",
          ["r"] = "\r",
          ["t"] = "\t"
        }
        if simple[escaped] then
          parts[#parts + 1] = simple[escaped]
          position = position + 1
        elseif escaped == "u" then
          local hex = text:sub(position + 1, position + 4)
          if #hex ~= 4 or hex:match("^%x%x%x%x$") == nil then
            fail("invalid unicode escape")
          end
          local code = tonumber(hex, 16)
          position = position + 5
          if code >= 0xD800 and code <= 0xDBFF and text:sub(position, position + 1) == "\\u" then
            local lowHex = text:sub(position + 2, position + 5)
            local low = tonumber(lowHex, 16)
            if low and low >= 0xDC00 and low <= 0xDFFF then
              code = 0x10000 + (code - 0xD800) * 0x400 + (low - 0xDC00)
              position = position + 6
            end
          end
          parts[#parts + 1] = utf8Character(code)
        else
          fail("invalid escape sequence")
        end
      else
        parts[#parts + 1] = character
        position = position + 1
      end
    end
    fail("unterminated string")
  end

  local function parseNumber()
    local remainder = text:sub(position)
    local raw = remainder:match("^-?%d+%.?%d*[eE]?[+-]?%d*")
    if not raw then
      fail("invalid number")
    end
    local number = tonumber(raw)
    if number == nil then
      fail("invalid number")
    end
    position = position + #raw
    return number
  end

  local function parseArray()
    position = position + 1
    local result = {}
    skipWhitespace()
    if text:sub(position, position) == "]" then
      position = position + 1
      return result
    end
    while true do
      result[#result + 1] = parseValue()
      skipWhitespace()
      local character = text:sub(position, position)
      if character == "]" then
        position = position + 1
        return result
      elseif character == "," then
        position = position + 1
        skipWhitespace()
      else
        fail("expected ',' or ']'")
      end
    end
  end

  local function parseObject()
    position = position + 1
    local result = {}
    skipWhitespace()
    if text:sub(position, position) == "}" then
      position = position + 1
      return result
    end
    while true do
      skipWhitespace()
      if text:sub(position, position) ~= '"' then
        fail("expected object key string")
      end
      local key = parseString()
      skipWhitespace()
      if text:sub(position, position) ~= ":" then
        fail("expected ':'")
      end
      position = position + 1
      skipWhitespace()
      result[key] = parseValue()
      skipWhitespace()
      local character = text:sub(position, position)
      if character == "}" then
        position = position + 1
        return result
      elseif character == "," then
        position = position + 1
      else
        fail("expected ',' or '}'")
      end
    end
  end

  parseValue = function()
    skipWhitespace()
    if position > length then
      fail("unexpected end of input")
    end
    local character = text:sub(position, position)
    if character == '"' then
      return parseString()
    elseif character == "{" then
      return parseObject()
    elseif character == "[" then
      return parseArray()
    elseif character == "t" and text:sub(position, position + 3) == "true" then
      position = position + 4
      return true
    elseif character == "f" and text:sub(position, position + 4) == "false" then
      position = position + 5
      return false
    elseif character == "n" and text:sub(position, position + 3) == "null" then
      position = position + 4
      return json.null
    elseif character == "-" or character:match("%d") then
      return parseNumber()
    end
    fail("unexpected character '" .. character .. "'")
  end

  local value = parseValue()
  skipWhitespace()
  if position <= length then
    fail("trailing data")
  end
  return value
end

return json
