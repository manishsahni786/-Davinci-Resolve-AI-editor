-- AI Video Editor bridge processor.
-- Run from: Workspace > Scripts > Utility > AI Video Editor Bridge
-- It processes ONE queued request and publishes ONE response through Fusion prefs.
-- Resolve Free sandboxes io, so no files are written by this script.

local scriptDir = ...
if type(scriptDir) ~= "string" or scriptDir == "" then
  scriptDir = AIVE_SCRIPT_DIR
end
if type(scriptDir) ~= "string" or scriptDir == "" then
  local source = debug and debug.getinfo and debug.getinfo(1, "S").source or ""
  scriptDir = source:match("^@(.*)[\\/][^\\/]+$") or "."
end

local paths = dofile(scriptDir .. "\\lib\\paths.lua")
paths.setRoot(scriptDir)
local json = dofile(scriptDir .. "\\lib\\json.lua")
local context = dofile(scriptDir .. "\\lib\\resolve-context.lua")
local prefs = dofile(scriptDir .. "\\lib\\prefs.lua")

local function utcNow()
  return os.date("!%Y-%m-%dT%H:%M:%SZ")
end

local function publishError(code, message, details, requestId)
  local payload = {
    code = code,
    message = message,
    details = details,
    requestId = requestId,
    at = utcNow()
  }
  local encodedOk, encoded = pcall(json.encode, payload)
  if not encodedOk then
    encoded = tostring(message)
  end
  if prefs.available() then
    prefs.recordError(encoded)
  end
  print("AI Video Editor bridge error: " .. tostring(message))
end

local function failEarly(code, message, details, requestId)
  publishError(code, message, details, requestId)
end

if not prefs.available() then
  print("AI Video Editor bridge: Fusion preferences are unavailable; cannot publish a response.")
  return
end

local config, configError = paths.loadConfig()
if not config then
  failEarly("CONFIG_ERROR", configError)
  return
end

local validConfig, validationError = paths.validateConfig(config)
if not validConfig then
  failEarly("CONFIG_INVALID", validationError)
  return
end

local requestPath = paths.join(config.requestsDir, "next.request.lua")
local chunk, loadError = loadfile(requestPath)
if not chunk then
  local jsonPath = paths.join(config.requestsDir, "next.request.json")
  if paths.fileExists(jsonPath) then
    failEarly(
      "REQUEST_FILE_MISSING",
      "Queued request is missing next.request.lua. Re-queue it from Node.",
      nil,
      nil
    )
  else
    prefs.setStage("no-request")
    print("AI Video Editor bridge: no queued request.")
  end
  if loadError then
    print("AI Video Editor bridge: request load error: " .. tostring(loadError))
  end
  return
end

local loaded, requestText = pcall(chunk)
if not loaded or type(requestText) ~= "string" then
  failEarly("INVALID_REQUEST_WRAPPER", "Invalid Lua request wrapper.", tostring(requestText))
  return
end

local decoded, request = pcall(json.decode, requestText)
if not decoded or type(request) ~= "table" then
  failEarly("INVALID_REQUEST_JSON", "Invalid request JSON.", tostring(request))
  return
end

local requestId = request.id
local command = request.command
if type(requestId) ~= "string" or requestId == "" or requestId:match("^[A-Za-z0-9._-]+$") == nil then
  failEarly("INVALID_REQUEST_ID", "Request is missing a valid id.")
  return
end
if type(command) ~= "string" or command == "" then
  failEarly("INVALID_REQUEST_COMMAND", "Request is missing a command.", nil, requestId)
  return
end
if request.protocolVersion ~= "1.0" then
  failEarly(
    "UNSUPPORTED_PROTOCOL",
    "Unsupported protocol version: " .. tostring(request.protocolVersion),
    nil,
    requestId
  )
  return
end
if request.payload ~= nil and type(request.payload) ~= "table" then
  failEarly("INVALID_REQUEST_PAYLOAD", "Request payload must be an object.", nil, requestId)
  return
end

prefs.setStage("request-loaded")

if prefs.hasProcessed(requestId) then
  local existing = prefs.responseJsonFor(requestId)
  if existing then
    local replayed, replayError = prefs.publishResponse(requestId, existing, true)
    if replayed then
      prefs.setStage("already-processed-replayed")
      print("AI Video Editor bridge: replayed already-processed request " .. requestId)
    else
      failEarly("RESPONSE_PUBLISH_FAILED", replayError, nil, requestId)
    end
  else
    failEarly(
      "REQUEST_ALREADY_PROCESSED",
      "Request was already processed and its response is no longer cached.",
      nil,
      requestId
    )
  end
  return
end

local startedAt = utcNow()
local startedClock = os.clock()

local function writeResponse(status, result, errorInfo, meta)
  local completedAt = utcNow()
  local response = {
    protocolVersion = "1.0",
    id = requestId,
    command = command,
    ok = status == "success",
    status = status,
    startedAt = startedAt,
    completedAt = completedAt,
    durationMs = math.max(0, math.floor((os.clock() - startedClock) * 1000)),
    source = "resolve",
    result = result,
    error = errorInfo,
    meta = meta
  }

  local encoded = json.encode(response)
  local published, publishError = prefs.publishResponse(requestId, encoded, true)
  if not published then
    failEarly("RESPONSE_PUBLISH_FAILED", publishError, nil, requestId)
    return nil
  end

  print(string.format(
    "AI Video Editor bridge: %s -> %s (%d ms)",
    command,
    status,
    response.durationMs
  ))
  return response
end

local function metaFrom(result)
  if type(result) ~= "table" then
    return {}
  end

  local version = result.version
  local isStudio = result.isStudio
  if type(version) == "table" then
    isStudio = isStudio or version.isStudio
    version = version.string
  end

  return {
    resolveVersion = version or result.resolveVersion,
    isStudio = isStudio,
    projectName = result.projectName or (result.project and result.project.name),
    timelineName = result.timelineName or (result.timeline and result.timeline.name),
    scriptContext = result.scriptContext or "internal-lua"
  }
end

local function runInspection(handler)
  local ok, result, failure = pcall(handler, request.payload or {})
  if not ok then
    return "error", nil, {
      code = "INSPECTION_FAILED",
      message = tostring(result)
    }
  end
  if failure then
    return "error", result, failure
  end
  return "success", result, nil
end

prefs.setStage("command:" .. command)

if command == "diagnostics.ping" then
  local result = context.ping()
  if result.resolveConnected then
    writeResponse("success", result, nil, metaFrom(result))
  else
    writeResponse("error", result, {
      code = "RESOLVE_UNAVAILABLE",
      message = "The Lua script ran but could not obtain the Resolve API object.",
      details = result.errors
    }, metaFrom(result))
  end
elseif command == "diagnostics.snapshot" then
  local result = context.collect({ scriptFile = "bridge.lua" })
  if result.connected then
    writeResponse("success", result, nil, metaFrom(result))
  else
    writeResponse("error", result, {
      code = "RESOLVE_UNAVAILABLE",
      message = "The Lua script ran but could not obtain the Resolve API object.",
      details = result.errors
    }, metaFrom(result))
  end
elseif command == "bridge.echo" then
  local result = {
    echoed = request.payload or {},
    scriptContext = "internal-lua"
  }
  writeResponse("success", result, nil, metaFrom(result))
elseif command == "bridge.health" then
  local result = context.health(config, paths)
  writeResponse("success", result, nil, metaFrom(result))
elseif command == "project.inspect" then
  local status, result, errorInfo = runInspection(context.inspectProject)
  writeResponse(status, result, errorInfo, metaFrom(result))
elseif command == "media.inspect" then
  local status, result, errorInfo = runInspection(context.inspectMedia)
  writeResponse(status, result, errorInfo, metaFrom(result))
elseif command == "timeline.inspect" then
  local status, result, errorInfo = runInspection(context.inspectTimeline)
  writeResponse(status, result, errorInfo, metaFrom(result))
elseif command == "render.inspect" then
  local status, result, errorInfo = runInspection(context.inspectRender)
  writeResponse(status, result, errorInfo, metaFrom(result))
else
  prefs.setStage("unsupported-command")
  writeResponse("unsupported", nil, {
    code = "UNSUPPORTED_COMMAND",
    message = "Command is not implemented in Milestone 2: " .. command
  }, nil)
end
