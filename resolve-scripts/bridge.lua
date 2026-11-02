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

local config, configError = paths.loadConfig()
if not config then
  print("AI Video Editor bridge: " .. tostring(configError))
  return
end

local validConfig, validationError = paths.validateConfig(config)
if not validConfig then
  print("AI Video Editor bridge: " .. tostring(validationError))
  return
end

if not prefs.available() then
  print("AI Video Editor bridge: Fusion preferences are unavailable; cannot publish a response.")
  return
end

local requestPath = paths.join(config.requestsDir, "next.request.lua")
local chunk, loadError = loadfile(requestPath)
if not chunk then
  local jsonPath = paths.join(config.requestsDir, "next.request.json")
  if paths.fileExists(jsonPath) then
    print("AI Video Editor bridge: queued request is missing next.request.lua. Re-queue it from Node.")
  else
    print("AI Video Editor bridge: no queued request.")
  end
  if loadError then
    print("AI Video Editor bridge: request load error: " .. tostring(loadError))
  end
  return
end

local loaded, requestText = pcall(chunk)
if not loaded or type(requestText) ~= "string" then
  print("AI Video Editor bridge: invalid request wrapper: " .. tostring(requestText))
  return
end

local decoded, request = pcall(json.decode, requestText)
if not decoded or type(request) ~= "table" then
  print("AI Video Editor bridge: invalid request JSON: " .. tostring(request))
  return
end

local requestId = request.id
local command = request.command
if type(requestId) ~= "string" or requestId == "" or requestId:match("^[A-Za-z0-9._-]+$") == nil then
  print("AI Video Editor bridge: request is missing a valid id.")
  return
end
if type(command) ~= "string" or command == "" then
  print("AI Video Editor bridge: request is missing a command.")
  return
end

if prefs.processedId() == requestId then
  print("AI Video Editor bridge: request already processed: " .. requestId)
  return
end

local startedAt = os.date("!%Y-%m-%dT%H:%M:%SZ")
local startedClock = os.clock()

local function writeResponse(status, result, errorInfo, meta)
  local completedAt = os.date("!%Y-%m-%dT%H:%M:%SZ")
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
    print("AI Video Editor bridge: cannot publish response: " .. tostring(publishError))
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
    resolveVersion = version,
    isStudio = isStudio,
    projectName = result.projectName or (result.project and result.project.name),
    timelineName = result.timelineName or (result.timeline and result.timeline.name),
    scriptContext = result.scriptContext or "internal-lua"
  }
end

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
else
  writeResponse("unsupported", nil, {
    code = "UNSUPPORTED_COMMAND",
    message = "Command is not implemented in Milestone 1: " .. command
  }, nil)
end
