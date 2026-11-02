-- Fusion preference channel for Resolve Free.
-- Internal Lua cannot use io, so responses are hex-encoded into Fusion prefs.
-- Node polls Fusion.prefs, decodes the hex, and validates the JSON.

local prefs = {}

prefs.KEYS = {
  responseId = "Global.AIVideoEditorBridgeResponseId",
  responseHex = "Global.AIVideoEditorBridgeResponseHex",
  processedId = "Global.AIVideoEditorBridgeProcessedId",
  diagnosticsHex = "Global.AIVideoEditorBridgeDiagnosticsHex",
  diagnosticsAt = "Global.AIVideoEditorBridgeDiagnosticsAt"
}

local function fusionObject()
  if type(fusion) == "userdata" or type(fusion) == "table" then
    return fusion
  end
  return nil
end

function prefs.available()
  local object = fusionObject()
  return object ~= nil
    and type(object.SetPrefs) == "function"
    and type(object.SavePrefs) == "function"
end

function prefs.get(key)
  local object = fusionObject()
  if object == nil or type(object.GetPrefs) ~= "function" then
    return nil
  end
  local ok, value = pcall(object.GetPrefs, object, key)
  if not ok then
    return nil
  end
  return value
end

function prefs.set(key, value)
  local object = fusionObject()
  if object == nil or type(object.SetPrefs) ~= "function" then
    return nil, "Fusion SetPrefs is unavailable"
  end
  local ok, errorMessage = pcall(object.SetPrefs, object, key, value)
  if not ok then
    return nil, tostring(errorMessage)
  end
  return true
end

function prefs.save()
  local object = fusionObject()
  if object == nil or type(object.SavePrefs) ~= "function" then
    return nil, "Fusion SavePrefs is unavailable"
  end
  local ok, errorMessage = pcall(object.SavePrefs, object)
  if not ok then
    return nil, tostring(errorMessage)
  end
  return true
end

function prefs.hex(value)
  if type(value) ~= "string" then
    value = tostring(value)
  end
  local parts = {}
  for index = 1, #value do
    parts[index] = string.format("%02x", string.byte(value, index))
  end
  return table.concat(parts)
end

function prefs.unhex(value)
  if type(value) ~= "string" or #value % 2 ~= 0 then
    return nil
  end
  local parts = {}
  for index = 1, #value, 2 do
    local byte = tonumber(value:sub(index, index + 1), 16)
    if byte == nil then
      return nil
    end
    parts[#parts + 1] = string.char(byte)
  end
  return table.concat(parts)
end

function prefs.publishResponse(requestId, responseJson, markProcessed)
  if not prefs.available() then
    return nil, "Fusion preferences are unavailable; cannot publish a response."
  end
  local ok, errorMessage = pcall(function()
    fusion:SetPrefs(prefs.KEYS.responseId, prefs.hex(requestId))
    fusion:SetPrefs(prefs.KEYS.responseHex, prefs.hex(responseJson))
    if markProcessed then
      fusion:SetPrefs(prefs.KEYS.processedId, requestId)
    end
    fusion:SavePrefs()
  end)
  if not ok then
    return nil, tostring(errorMessage)
  end
  return true
end

function prefs.processedId()
  local value = prefs.get(prefs.KEYS.processedId)
  if type(value) ~= "string" or value == "" then
    return nil
  end
  return value
end

function prefs.publishDiagnostics(jsonText)
  if not prefs.available() then
    return nil, "Fusion preferences are unavailable; cannot publish diagnostics."
  end
  local ok, errorMessage = pcall(function()
    fusion:SetPrefs(prefs.KEYS.diagnosticsHex, prefs.hex(jsonText))
    fusion:SetPrefs(prefs.KEYS.diagnosticsAt, tostring((os and os.time and os.time()) or ""))
    fusion:SavePrefs()
  end)
  if not ok then
    return nil, tostring(errorMessage)
  end
  return true
end

return prefs
