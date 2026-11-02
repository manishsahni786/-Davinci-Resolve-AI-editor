-- Read-only inspection of the Resolve object available to internal scripts.

local context = {}
local unpackValues = unpack or table.unpack

local function safeCall(object, method, ...)
  if object == nil then
    return nil, "object is nil"
  end
  local arguments = { ... }
  local ok, result = pcall(function()
    return object[method](object, unpackValues(arguments))
  end)
  if ok then
    return result
  end
  return nil, tostring(result)
end

local function tableCount(value)
  if type(value) ~= "table" then
    return 0
  end
  local count = 0
  for _ in pairs(value) do
    count = count + 1
  end
  return count
end

local function copySelected(source, keys)
  local result = {}
  if type(source) ~= "table" then
    return result
  end
  for _, key in ipairs(keys) do
    result[key] = source[key]
  end
  return result
end

function context.getResolve()
  local resolveType = type(resolve)
  if resolve ~= nil and (resolveType == "userdata" or resolveType == "table") then
    return resolve, "predefined global 'resolve'"
  end

  if type(Resolve) == "function" then
    local ok, result = pcall(Resolve)
    if ok and result ~= nil then
      return result, "Resolve() function"
    end
    return nil, "Resolve() exists but returned nil. Internal menu scripts should use the predefined global 'resolve'."
  end

  return nil, "No usable Resolve object found. Globals: resolve=" .. resolveType .. ", Resolve=" .. type(Resolve)
end

function context.collect(options)
  options = options or {}
  local info = {
    generatedAt = os.date("!%Y-%m-%dT%H:%M:%SZ"),
    scriptFile = options.scriptFile or "unknown",
    luaVersion = _VERSION,
    globals = {
      bmd = type(bmd),
      resolve = type(resolve),
      Resolve = type(Resolve),
      fusion = type(fusion),
      fu = type(fu)
    },
    environment = {
      resolveScriptApi = os.getenv("RESOLVE_SCRIPT_API"),
      resolveScriptLib = os.getenv("RESOLVE_SCRIPT_LIB"),
      io = type(io),
      os = type(os),
      loadfile = type(loadfile),
      dofile = type(dofile),
      ffi = type(ffi),
      package = type(package),
      require = type(require),
      packagePath = type(package) == "table" and package.path or nil,
      packageCpath = type(package) == "table" and package.cpath or nil
    },
    connected = false,
    errors = {}
  }

  local function record(message)
    info.errors[#info.errors + 1] = message
  end

  local resolveObject, source = context.getResolve()
  info.resolvedVia = source

  if resolveObject == nil then
    record(source)
    return info
  end

  local versionList, versionError = safeCall(resolveObject, "GetVersion")
  if versionError then
    record("GetVersion: " .. versionError)
  end

  local versionString = safeCall(resolveObject, "GetVersionString")
  local productName = safeCall(resolveObject, "GetProductName")
  local isStudio = safeCall(resolveObject, "IsStudio")
  local currentPage = safeCall(resolveObject, "GetCurrentPage")

  info.version = {
    list = versionList,
    string = versionString,
    productName = productName,
    isStudio = isStudio
  }
  info.currentPage = currentPage
  info.connected = versionList ~= nil or versionString ~= nil

  local projectManager, managerError = safeCall(resolveObject, "GetProjectManager")
  if managerError then
    record("GetProjectManager: " .. managerError)
  end
  if projectManager == nil then
    return info
  end

  local projectList = safeCall(projectManager, "GetProjectListInCurrentFolder")
  info.projectManager = {
    currentFolder = safeCall(projectManager, "GetCurrentFolder"),
    projectCount = tableCount(projectList),
    projects = projectList
  }

  local project, projectError = safeCall(projectManager, "GetCurrentProject")
  if projectError then
    record("GetCurrentProject: " .. projectError)
  end
  if project == nil then
    info.project = nil
    return info
  end

  local projectSettings = safeCall(project, "GetSettings")
  local timelineCount = safeCall(project, "GetTimelineCount")
  local timeline, timelineError = safeCall(project, "GetCurrentTimeline")

  info.project = {
    name = safeCall(project, "GetName"),
    uniqueId = safeCall(project, "GetUniqueId"),
    timelineCount = timelineCount,
    settings = copySelected(projectSettings, {
      "timelineFrameRate",
      "timelineResolutionWidth",
      "timelineResolutionHeight",
      "timelinePlaybackFrameRate",
      "colorScienceMode"
    })
  }

  if timelineError then
    record("GetCurrentTimeline: " .. timelineError)
  end

  if timeline ~= nil then
    local timelineSettings = safeCall(timeline, "GetSettings")
    info.timeline = {
      name = safeCall(timeline, "GetName"),
      uniqueId = safeCall(timeline, "GetUniqueId"),
      startFrame = safeCall(timeline, "GetStartFrame"),
      endFrame = safeCall(timeline, "GetEndFrame"),
      startTimecode = safeCall(timeline, "GetStartTimecode"),
      videoTracks = safeCall(timeline, "GetTrackCount", "video"),
      audioTracks = safeCall(timeline, "GetTrackCount", "audio"),
      subtitleTracks = safeCall(timeline, "GetTrackCount", "subtitle"),
      settings = copySelected(timelineSettings, {
        "useCustomSettings",
        "timelineFrameRate",
        "timelineResolutionWidth",
        "timelineResolutionHeight",
        "timelineOutputResolutionWidth",
        "timelineOutputResolutionHeight"
      })
    }
  end

  local mediaPool, mediaPoolError = safeCall(project, "GetMediaPool")
  if mediaPoolError then
    record("GetMediaPool: " .. mediaPoolError)
  end
  if mediaPool ~= nil then
    local rootFolder = safeCall(mediaPool, "GetRootFolder")
    local clips = nil
    if rootFolder ~= nil then
      clips = safeCall(rootFolder, "GetClipList")
      if type(clips) ~= "table" then
        clips = safeCall(rootFolder, "GetClips")
      end
    end
    info.mediaPool = {
      rootFolderName = rootFolder and safeCall(rootFolder, "GetName") or nil,
      clipCount = tableCount(clips),
      clips = clips
    }
  end

  local renderFormats = safeCall(project, "GetRenderFormats")
  local currentFormatAndCodec = safeCall(project, "GetCurrentRenderFormatAndCodec")
  local renderPresets = safeCall(project, "GetRenderPresetList")
  info.render = {
    formats = renderFormats,
    currentFormatAndCodec = currentFormatAndCodec,
    presets = renderPresets
  }

  info.timelines = {}
  if type(timelineCount) == "number" and timelineCount > 0 then
    for index = 1, math.min(timelineCount, 50) do
      local item = safeCall(project, "GetTimelineByIndex", index)
      if item ~= nil then
        info.timelines[#info.timelines + 1] = {
          index = index,
          name = safeCall(item, "GetName"),
          uniqueId = safeCall(item, "GetUniqueId")
        }
      end
    end
  end

  return info
end

function context.ping()
  local info = context.collect({ scriptFile = "ping" })
  local project = info.project or {}
  local timeline = info.timeline or {}
  local version = info.version or {}

  return {
    message = "pong",
    resolveConnected = info.connected,
    isStudio = version.isStudio == true,
    version = version.string or "unknown",
    projectName = project.name,
    timelineName = timeline.name,
    page = info.currentPage,
    scriptContext = info.resolvedVia or "unknown",
    globals = info.globals,
    errors = info.errors
  }
end

function context.health(config, paths)
  return {
    connected = context.getResolve() ~= nil,
    requestsDir = config.requestsDir,
    responsesDir = config.responsesDir,
    archiveDir = config.archiveDir,
    logsDir = config.logsDir,
    requestsDirExists = paths.directoryExists(config.requestsDir),
    responsesDirExists = paths.directoryExists(config.responsesDir),
    archiveDirExists = paths.directoryExists(config.archiveDir),
    logsDirExists = paths.directoryExists(config.logsDir),
    fusionPrefsAvailable = (type(fusion) == "userdata" or type(fusion) == "table")
      and type(fusion.SetPrefs) == "function"
      and type(fusion.SavePrefs) == "function",
    protocolVersion = config.protocolVersion or "1.0"
  }
end

return context
