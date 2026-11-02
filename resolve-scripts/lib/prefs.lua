-- Fusion preference channel for Resolve Free.
-- Internal Lua cannot use io, so responses are hex-encoded into Fusion prefs.
-- Node polls Fusion.prefs, decodes the hex, and validates the JSON.

local prefs = {}
local fusionOverride = nil

function prefs.setFusion(value)
  fusionOverride = value
end

prefs.KEYS = {
  responseId = "Global.AIVideoEditorBridgeResponseId",
  responseHex = "Global.AIVideoEditorBridgeResponseHex",
  processedId = "Global.AIVideoEditorBridgeProcessedId",
  stage = "Global.AIVEBridgeStage",
  error = "Global.AIVEBridgeError",
  errorAt = "Global.AIVEBridgeErrorAt",
  diagnosticsHex = "Global.AIVideoEditorBridgeDiagnosticsHex",
  diagnosticsAt = "Global.AIVideoEditorBridgeDiagnosticsAt"
}

local MAX_PROCESSED_IDS = 20

local function fusionObject()
  if fusionOverride ~= nil then
    return fusionOverride
  end
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
  local object = fusionObject()
  local ok, errorMessage = pcall(function()
    local processed = prefs.processedIds()
    if markProcessed and not prefs.hasProcessed(requestId, processed) then
      processed[#processed + 1] = requestId
      while #processed > MAX_PROCESSED_IDS do
        table.remove(processed, 1)
      end
    end
    object:SetPrefs(prefs.KEYS.responseId, prefs.hex(requestId))
    object:SetPrefs(prefs.KEYS.responseHex, prefs.hex(responseJson))
    object:SetPrefs(prefs.KEYS.processedId, table.concat(processed, ","))
    object:SetPrefs(prefs.KEYS.stage, "response-published")
    object:SetPrefs(prefs.KEYS.error, "")
    object:SavePrefs()
  end)
  if not ok then
    return nil, tostring(errorMessage)
  end
  return true
end

function prefs.processedIds()
  local result = {}
  local value = prefs.get(prefs.KEYS.processedId)
  if type(value) ~= "string" or value == "" then
    return result
  end
  for item in value:gmatch("[^,]+") do
    if item ~= "" then
      result[#result + 1] = item
    end
  end
  return result
end

function prefs.hasProcessed(requestId, processed)
  processed = processed or prefs.processedIds()
  for _, value in ipairs(processed) do
    if value == requestId then
      return true
    end
  end
  return false
end

function prefs.processedId()
  local value = prefs.get(prefs.KEYS.processedId)
  if type(value) ~= "string" or value == "" then
    return nil
  end
  return value
end

function prefs.responseId()
  return prefs.get(prefs.KEYS.responseId)
end

function prefs.responseJsonFor(requestId)
  if prefs.responseId() ~= prefs.hex(requestId) then
    return nil
  end
  return prefs.unhex(prefs.get(prefs.KEYS.responseHex))
end

function prefs.setStage(stage)
  local object = fusionObject()
  local ok, errorMessage = pcall(function()
    object:SetPrefs(prefs.KEYS.stage, tostring(stage))
    object:SavePrefs()
  end)
  if not ok then
    return nil, tostring(errorMessage)
  end
  return true
end

function prefs.recordError(message)
  local object = fusionObject()
  local ok, errorMessage = pcall(function()
    object:SetPrefs(prefs.KEYS.error, tostring(message))
    object:SetPrefs(prefs.KEYS.errorAt, tostring((os and os.time and os.time()) or ""))
    object:SetPrefs(prefs.KEYS.stage, "error")
    object:SavePrefs()
  end)
  if not ok then
    return nil, tostring(errorMessage)
  end
  return true
end

function prefs.publishDiagnostics(jsonText)
  if not prefs.available() then
    return nil, "Fusion preferences are unavailable; cannot publish diagnostics."
  end
  local object = fusionObject()
  local ok, errorMessage = pcall(function()
    object:SetPrefs(prefs.KEYS.diagnosticsHex, prefs.hex(jsonText))
    object:SetPrefs(prefs.KEYS.diagnosticsAt, tostring((os and os.time and os.time()) or ""))
    object:SetPrefs(prefs.KEYS.stage, "diagnostics-published")
    object:SetPrefs(prefs.KEYS.error, "")
    object:SavePrefs()
  end)
  if not ok then
    return nil, tostring(errorMessage)
  end
  return true
end

return prefs
