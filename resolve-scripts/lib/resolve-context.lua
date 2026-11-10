-- Read-only inspection of the Resolve object available to internal scripts.

local context = {}
local unpackValues = unpack or table.unpack
local resolveOverride = nil
local ARRAY_METATABLE = { __jsontype = "array" }

local function emptyArray()
  return setmetatable({}, ARRAY_METATABLE)
end

function context.setResolve(value)
  resolveOverride = value
end

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

local function isInternalKey(key)
  return type(key) == "string" and key:sub(1, 2) == "__"
end

local function arrayItems(value)
  if type(value) ~= "table" then
    return emptyArray()
  end
  local keys = {}
  for key in pairs(value) do
    if type(key) == "number" and key >= 1 and key % 1 == 0 then
      keys[#keys + 1] = key
    end
  end
  table.sort(keys)
  local items = emptyArray()
  for _, key in ipairs(keys) do
    items[#items + 1] = value[key]
  end
  return items
end

local function sortedEntries(value)
  if type(value) ~= "table" then
    return {}
  end
  local keys = {}
  for key in pairs(value) do
    if not isInternalKey(key) then
      keys[#keys + 1] = key
    end
  end
  table.sort(keys, function(left, right)
    return tostring(left) < tostring(right)
  end)
  local entries = {}
  for _, key in ipairs(keys) do
    entries[#entries + 1] = { key = key, value = value[key] }
  end
  return entries
end

local function tableCount(value)
  if type(value) ~= "table" then
    return 0
  end
  local count = 0
  for key in pairs(value) do
    if not isInternalKey(key) then
      count = count + 1
    end
  end
  return count
end

local function clampInteger(value, fallback, minimum, maximum)
  local number = tonumber(value)
  if number == nil then
    return fallback
  end
  number = math.floor(number)
  if number < minimum then
    return minimum
  end
  if number > maximum then
    return maximum
  end
  return number
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
  if resolveOverride ~= nil then
    return resolveOverride, "injected test Resolve object"
  end
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
    errors = emptyArray()
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
    projectCount = #arrayItems(projectList),
    projects = arrayItems(projectList)
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
    local clipItems = arrayItems(clips)
    local clipNames = emptyArray()
    for index = 1, math.min(#clipItems, 50) do
      clipNames[index] = safeCall(clipItems[index], "GetName")
    end
    info.mediaPool = {
      rootFolderName = rootFolder and safeCall(rootFolder, "GetName") or nil,
      clipCount = #clipItems,
      clips = clipNames
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

  info.timelines = emptyArray()
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

local function hasMethod(object, method)
  if object == nil then
    return false
  end
  local ok, value = pcall(function()
    return object[method]
  end)
  return ok and type(value) == "function"
end

local function recordCall(session, object, method, ...)
  local value, callError = safeCall(object, method, ...)
  if callError then
    session.errors[#session.errors + 1] = method .. ": " .. callError
  end
  return value
end

local function optionalCall(session, object, method, ...)
  if not hasMethod(object, method) then
    return nil
  end
  return recordCall(session, object, method, ...)
end

local function createSession()
  local session = {
    connected = false,
    errors = emptyArray()
  }
  local resolveObject, source = context.getResolve()
  session.source = source
  if resolveObject == nil then
    session.errors[#session.errors + 1] = source
    session.failure = {
      code = "RESOLVE_UNAVAILABLE",
      message = "The internal Resolve object is unavailable."
    }
    return session
  end

  session.resolve = resolveObject
  session.version = recordCall(session, resolveObject, "GetVersionString")
  session.isStudio = recordCall(session, resolveObject, "IsStudio")
  session.manager = recordCall(session, resolveObject, "GetProjectManager")
  if session.manager == nil then
    session.failure = {
      code = "PROJECT_MANAGER_UNAVAILABLE",
      message = "Could not obtain the Resolve ProjectManager."
    }
    return session
  end

  session.project = recordCall(session, session.manager, "GetCurrentProject")
  if session.project == nil then
    session.failure = {
      code = "PROJECT_UNAVAILABLE",
      message = "No project is open in Resolve."
    }
    return session
  end

  session.projectName = recordCall(session, session.project, "GetName")
  session.connected = true
  return session
end

local function baseResult(session)
  return {
    connected = session.connected,
    resolveVersion = session.version,
    isStudio = session.isStudio == true,
    projectName = session.projectName,
    scriptContext = session.source,
    errors = session.errors
  }
end

local function createManagerSession()
  local session = {
    connected = false,
    errors = emptyArray()
  }
  local resolveObject, source = context.getResolve()
  session.source = source
  if resolveObject == nil then
    session.errors[#session.errors + 1] = source
    session.failure = {
      code = "RESOLVE_UNAVAILABLE",
      message = "The internal Resolve object is unavailable."
    }
    return session
  end

  session.resolve = resolveObject
  session.version = recordCall(session, resolveObject, "GetVersionString")
  session.isStudio = recordCall(session, resolveObject, "IsStudio")
  session.manager = recordCall(session, resolveObject, "GetProjectManager")
  if session.manager == nil then
    session.failure = {
      code = "PROJECT_MANAGER_UNAVAILABLE",
      message = "Could not obtain the Resolve ProjectManager."
    }
    return session
  end

  session.connected = true
  session.project = recordCall(session, session.manager, "GetCurrentProject")
  if session.project ~= nil then
    session.projectName = recordCall(session, session.project, "GetName")
  end
  return session
end

local function trimmed(value)
  if type(value) ~= "string" then
    return nil
  end
  return value:match("^%s*(.-)%s*$")
end

local function validName(value)
  local name = trimmed(value)
  if name == nil or name == "" or #name > 120 then
    return nil
  end
  if name == "." or name == ".." or name:find('[<>:"/\\|%?%*]') ~= nil then
    return nil
  end
  return name
end

local function validBinPath(value)
  if value == nil then
    return ""
  end
  local path = trimmed(value)
  if path == nil or path == "" then
    return ""
  end
  local segments = 0
  for segment in path:gmatch("[^/]+") do
    if validName(segment) == nil then
      return nil
    end
    segments = segments + 1
  end
  if segments == 0 or segments > 32 or path:sub(1, 1) == "/" or path:sub(-1) == "/" then
    return nil
  end
  return path
end

local function joinBinPath(parentPath, name)
  if parentPath == nil or parentPath == "" then
    return name
  end
  return parentPath .. "/" .. name
end

local function projectNames(session)
  return arrayItems(recordCall(session, session.manager, "GetProjectListInCurrentFolder"))
end

local function containsProject(session, name)
  for _, item in ipairs(projectNames(session)) do
    if item == name then
      return true
    end
  end
  return false
end

local function projectSummary(project, session)
  return {
    name = recordCall(session, project, "GetName"),
    uniqueId = recordCall(session, project, "GetUniqueId"),
    timelineCount = recordCall(session, project, "GetTimelineCount"),
    currentPage = recordCall(session, session.resolve, "GetCurrentPage")
  }
end

local function findFolder(mediaPool, path, session)
  local current = recordCall(session, mediaPool, "GetRootFolder")
  if current == nil then
    return nil, {
      code = "MEDIA_POOL_UNAVAILABLE",
      message = "Could not obtain the media pool root folder."
    }
  end
  if path == nil or path == "" then
    return current, nil
  end

  for segment in path:gmatch("[^/]+") do
    local nextFolder = nil
    local subfolders = arrayItems(recordCall(session, current, "GetSubFolderList"))
    for _, subfolder in ipairs(subfolders) do
      if recordCall(session, subfolder, "GetName") == segment then
        nextFolder = subfolder
        break
      end
    end
    if nextFolder == nil then
      return nil, {
        code = "BIN_NOT_FOUND",
        message = "Media pool bin not found: " .. path
      }
    end
    current = nextFolder
  end
  return current, nil
end

local function folderSummary(folder, path, session)
  return {
    name = recordCall(session, folder, "GetName"),
    uniqueId = recordCall(session, folder, "GetUniqueId"),
    path = path
  }
end

local function stringMap(value)
  local result = {}
  if type(value) ~= "table" then
    return result
  end
  for key, item in pairs(value) do
    if not isInternalKey(key) then
      result[tostring(key)] = item
    end
  end
  return result
end

local function clipSummary(clip, session)
  local frames = recordCall(session, clip, "GetClipProperty", "Frames")
  local fps = recordCall(session, clip, "GetClipProperty", "FPS")
  local frameCount = tonumber(frames)
  local frameRate = tonumber(fps)
  return {
    name = recordCall(session, clip, "GetName"),
    uniqueId = recordCall(session, clip, "GetUniqueId"),
    mediaId = recordCall(session, clip, "GetMediaId"),
    type = recordCall(session, clip, "GetClipProperty", "Type"),
    filePath = recordCall(session, clip, "GetClipProperty", "File Path"),
    duration = recordCall(session, clip, "GetClipProperty", "Duration"),
    frames = frames,
    durationSeconds = frameCount and frameRate and frameRate > 0 and frameCount / frameRate or nil,
    resolution = recordCall(session, clip, "GetClipProperty", "Resolution"),
    fps = fps
  }
end

local function timelineSummary(timeline, session)
  return {
    name = recordCall(session, timeline, "GetName"),
    uniqueId = recordCall(session, timeline, "GetUniqueId"),
    startFrame = recordCall(session, timeline, "GetStartFrame"),
    endFrame = recordCall(session, timeline, "GetEndFrame"),
    startTimecode = recordCall(session, timeline, "GetStartTimecode"),
    videoTracks = recordCall(session, timeline, "GetTrackCount", "video"),
    audioTracks = recordCall(session, timeline, "GetTrackCount", "audio"),
    subtitleTracks = optionalCall(session, timeline, "GetTrackCount", "subtitle"),
    settings = copySelected(recordCall(session, timeline, "GetSettings"), {
      "useCustomSettings",
      "timelineFrameRate",
      "timelineResolutionWidth",
      "timelineResolutionHeight",
      "timelineOutputResolutionWidth",
      "timelineOutputResolutionHeight"
    })
  }
end

local function timelineItemSummary(item, session)
  local mediaItem = optionalCall(session, item, "GetMediaPoolItem")
  local mediaPoolItemName = nil
  local mediaPoolItemUniqueId = nil
  local mediaPoolItemMediaId = nil
  if mediaItem ~= nil then
    mediaPoolItemName = recordCall(session, mediaItem, "GetName")
    mediaPoolItemUniqueId = recordCall(session, mediaItem, "GetUniqueId")
    mediaPoolItemMediaId = recordCall(session, mediaItem, "GetMediaId")
  end
  return {
    name = recordCall(session, item, "GetName"),
    start = recordCall(session, item, "GetStart"),
    finish = recordCall(session, item, "GetEnd"),
    duration = recordCall(session, item, "GetDuration"),
    sourceStartFrame = optionalCall(session, item, "GetSourceStartFrame"),
    sourceEndFrame = optionalCall(session, item, "GetSourceEndFrame"),
    mediaPoolItemName = mediaPoolItemName,
    mediaPoolItemUniqueId = mediaPoolItemUniqueId,
    mediaPoolItemMediaId = mediaPoolItemMediaId,
    trackType = optionalCall(session, item, "GetTrackType"),
    trackIndex = optionalCall(session, item, "GetTrackIndex")
  }
end

local function listTimelines(project, session)
  local count = recordCall(session, project, "GetTimelineCount")
  local timelines = emptyArray()
  if type(count) ~= "number" then
    return timelines
  end
  for index = 1, math.min(count, 100) do
    local timeline = recordCall(session, project, "GetTimelineByIndex", index)
    if timeline ~= nil then
      timelines[#timelines + 1] = {
        index = index,
        name = recordCall(session, timeline, "GetName"),
        uniqueId = recordCall(session, timeline, "GetUniqueId")
      }
    end
  end
  return timelines
end

local function markerList(timeline, session)
  local markers = optionalCall(session, timeline, "GetMarkers")
  local result = emptyArray()
  if type(markers) ~= "table" then
    return result
  end
  for frame, marker in pairs(markers) do
    if type(frame) == "number" then
      local entry = { frame = frame }
      if type(marker) == "table" then
        for key, value in pairs(marker) do
          if not isInternalKey(key) then
            entry[tostring(key)] = value
          end
        end
      end
      result[#result + 1] = entry
    end
  end
  table.sort(result, function(left, right)
    return left.frame < right.frame
  end)
  return result
end

function context.inspectProject(options)
  options = options or {}
  local session = createSession()
  local result = baseResult(session)
  if session.failure then
    result.failure = session.failure
    return result, session.failure
  end

  local settings = recordCall(session, session.project, "GetSettings")
  local timelineCount = recordCall(session, session.project, "GetTimelineCount")
  local projectList = recordCall(session, session.manager, "GetProjectListInCurrentFolder")
  local projectItems = arrayItems(projectList)

  result.project = {
    name = session.projectName,
    uniqueId = recordCall(session, session.project, "GetUniqueId"),
    timelineCount = timelineCount,
    currentPage = recordCall(session, session.resolve, "GetCurrentPage"),
    settings = copySelected(settings, {
      "timelineFrameRate",
      "timelineResolutionWidth",
      "timelineResolutionHeight",
      "timelinePlaybackFrameRate",
      "colorScienceMode"
    })
  }
  result.projectManager = {
    currentFolder = recordCall(session, session.manager, "GetCurrentFolder"),
    projectCount = #projectItems,
    projects = projectItems
  }
  result.timelineCount = timelineCount
  return result, nil
end

function context.inspectMedia(options)
  options = options or {}
  local session = createSession()
  local result = baseResult(session)
  if session.failure then
    result.failure = session.failure
    return result, session.failure
  end

  local mediaPool = recordCall(session, session.project, "GetMediaPool")
  if mediaPool == nil then
    result.failure = {
      code = "MEDIA_POOL_UNAVAILABLE",
      message = "Could not obtain the project MediaPool."
    }
    return result, result.failure
  end

  local includeClips = options.includeClips ~= false
  local maxClips = clampInteger(options.maxClips, 100, 1, 500)
  local maxFolders = 100
  local state = {
    bins = emptyArray(),
    folderCount = 0,
    clipCount = 0,
    emittedClips = 0,
    truncated = false
  }

  local function inspectFolder(folder, path)
    if folder == nil or state.folderCount >= maxFolders then
      state.truncated = true
      return
    end
    state.folderCount = state.folderCount + 1
    local name = recordCall(session, folder, "GetName") or "Bin"
    local clips = arrayItems(recordCall(session, folder, "GetClipList"))
    local bin = {
      name = name,
      path = path,
      clipCount = #clips,
      clips = emptyArray()
    }
    state.clipCount = state.clipCount + #clips

    if includeClips then
      for index = 1, #clips do
        if state.emittedClips >= maxClips then
          bin.truncated = true
          state.truncated = true
          break
        end
        bin.clips[#bin.clips + 1] = clipSummary(clips[index], session)
        state.emittedClips = state.emittedClips + 1
      end
    end

    state.bins[#state.bins + 1] = bin

    local subfolders = arrayItems(recordCall(session, folder, "GetSubFolderList"))
    for _, subfolder in ipairs(subfolders) do
      if state.folderCount >= maxFolders then
        state.truncated = true
        break
      end
      local subName = recordCall(session, subfolder, "GetName") or "Bin"
      inspectFolder(subfolder, path .. "/" .. subName)
    end
  end

  local rootFolder = recordCall(session, mediaPool, "GetRootFolder")
  if rootFolder ~= nil then
    inspectFolder(rootFolder, "")
  end

  result.mediaPool = {
    rootFolderName = rootFolder and recordCall(session, rootFolder, "GetName") or nil,
    folderCount = state.folderCount,
    clipCount = state.clipCount,
    emittedClips = state.emittedClips,
    truncated = state.truncated,
    bins = state.bins
  }
  return result, nil
end

function context.inspectTimeline(options)
  options = options or {}
  local session = createSession()
  local result = baseResult(session)
  if session.failure then
    result.failure = session.failure
    return result, session.failure
  end

  local timeline
  local requestedIndex = tonumber(options.timelineIndex)
  if requestedIndex then
    timeline = recordCall(session, session.project, "GetTimelineByIndex", math.floor(requestedIndex))
  else
    timeline = recordCall(session, session.project, "GetCurrentTimeline")
  end
  if timeline == nil then
    result.failure = {
      code = "TIMELINE_UNAVAILABLE",
      message = requestedIndex
        and ("No timeline exists at index " .. tostring(requestedIndex) .. ".")
        or "No current timeline is open."
    }
    return result, result.failure
  end

  local includeClips = options.includeClips ~= false
  local maxClips = clampInteger(options.maxClips, 200, 1, 500)
  local summary = timelineSummary(timeline, session)
  local tracks = { video = emptyArray(), audio = emptyArray(), subtitle = emptyArray() }
  local emittedClips = 0
  local truncated = false

  for _, trackType in ipairs({ "video", "audio", "subtitle" }) do
    local trackCount = summary[trackType .. "Tracks"]
    if type(trackCount) ~= "number" then
      trackCount = 0
    end
    for trackIndex = 1, math.min(trackCount, 100) do
      local items = arrayItems(recordCall(
        session,
        timeline,
        "GetItemListInTrack",
        trackType,
        trackIndex
      ))
      local track = {
        index = trackIndex,
        itemCount = #items,
        items = emptyArray(),
        truncated = false
      }
      if includeClips then
        for index = 1, #items do
          if emittedClips >= maxClips then
            track.truncated = true
            truncated = true
            break
          end
          track.items[#track.items + 1] = timelineItemSummary(items[index], session)
          emittedClips = emittedClips + 1
        end
      end
      tracks[trackType][#tracks[trackType] + 1] = track
    end
  end

  result.timeline = summary
  result.timelineName = summary.name
  result.tracks = tracks
  result.markers = markerList(timeline, session)
  result.emittedClips = emittedClips
  result.truncated = truncated
  result.timelines = listTimelines(session.project, session)
  return result, nil
end

function context.inspectRender(options)
  options = options or {}
  local session = createSession()
  local result = baseResult(session)
  if session.failure then
    result.failure = session.failure
    return result, session.failure
  end

  local current = recordCall(session, session.project, "GetCurrentRenderFormatAndCodec")
  local formats = recordCall(session, session.project, "GetRenderFormats")
  local presets = recordCall(session, session.project, "GetRenderPresetList")
  local settings = optionalCall(session, session.project, "GetRenderSettings")

  result.render = {
    currentFormatAndCodec = current,
    formats = stringMap(formats),
    presets = stringMap(presets),
    settings = copySelected(settings, {
      "SelectAllFrames",
      "TargetDir",
      "CustomName",
      "ExportVideo",
      "ExportAudio",
      "VideoQuality",
      "AudioQuality"
    })
  }

  if options.includeCodecs ~= false then
    local format = type(current) == "table" and current.format or nil
    if format then
      result.render.codecs = stringMap(recordCall(
        session,
        session.project,
        "GetRenderCodecs",
        format
      ))
    end
  end

  if options.includeJobs == true then
    local jobs = arrayItems(optionalCall(session, session.project, "GetRenderJobList"))
    local jobList = emptyArray()
    for index = 1, math.min(#jobs, 50) do
      local job = jobs[index]
      if type(job) == "table" then
        local jobId = job.JobId or job.jobId
        local entry = {
          jobId = jobId,
          name = job.JobName or job.jobName,
          status = job.JobStatus or job.jobStatus
        }
        if jobId ~= nil then
          entry.details = optionalCall(session, session.project, "GetRenderJobStatus", jobId)
        end
        jobList[#jobList + 1] = entry
      end
    end
    result.render.jobs = jobList
  end

  return result, nil
end

function context.createProject(options)
  options = options or {}
  local session = createManagerSession()
  local result = baseResult(session)
  if session.failure then
    result.failure = session.failure
    return result, session.failure
  end

  local name = validName(options.name)
  if name == nil then
    result.failure = {
      code = "INVALID_PROJECT_NAME",
      message = "Project name is empty or contains unsupported characters."
    }
    return result, result.failure
  end
  if containsProject(session, name) then
    result.failure = {
      code = "PROJECT_ALREADY_EXISTS",
      message = "A project with this name already exists: " .. name
    }
    return result, result.failure
  end

  local project
  local mediaPath = trimmed(options.mediaPath)
  if mediaPath ~= nil and mediaPath ~= "" then
    project = recordCall(session, session.manager, "CreateProject", name, mediaPath)
  else
    project = recordCall(session, session.manager, "CreateProject", name)
  end
  if project == nil then
    result.failure = {
      code = "PROJECT_CREATE_FAILED",
      message = "Resolve did not create the project: " .. name
    }
    return result, result.failure
  end

  result.project = projectSummary(project, session)
  result.projectName = result.project.name
  result.projectManager = {
    currentFolder = recordCall(session, session.manager, "GetCurrentFolder"),
    projects = projectNames(session)
  }
  return result, nil
end

function context.openProject(options)
  options = options or {}
  local session = createManagerSession()
  local result = baseResult(session)
  if session.failure then
    result.failure = session.failure
    return result, session.failure
  end

  local name = validName(options.name)
  if name == nil then
    result.failure = {
      code = "INVALID_PROJECT_NAME",
      message = "Project name is empty or contains unsupported characters."
    }
    return result, result.failure
  end
  if not containsProject(session, name) then
    result.failure = {
      code = "PROJECT_NOT_FOUND",
      message = "Project not found in the current folder: " .. name
    }
    return result, result.failure
  end

  local savedCurrent = false
  if options.saveCurrent == true and session.project ~= nil then
    savedCurrent = recordCall(session, session.manager, "SaveProject") == true
  end

  local project = recordCall(session, session.manager, "LoadProject", name)
  if project == nil then
    result.failure = {
      code = "PROJECT_OPEN_FAILED",
      message = "Resolve did not open the project: " .. name
    }
    return result, result.failure
  end

  result.project = projectSummary(project, session)
  result.projectName = result.project.name
  result.savedCurrent = savedCurrent
  result.projectManager = {
    currentFolder = recordCall(session, session.manager, "GetCurrentFolder"),
    projects = projectNames(session)
  }
  return result, nil
end

function context.saveProject()
  local session = createSession()
  local result = baseResult(session)
  if session.failure then
    result.failure = session.failure
    return result, session.failure
  end

  local saved = recordCall(session, session.manager, "SaveProject")
  if saved ~= true then
    result.failure = {
      code = "PROJECT_SAVE_FAILED",
      message = "Resolve did not save the current project: " .. tostring(session.projectName)
    }
    return result, result.failure
  end

  result.saved = true
  result.project = projectSummary(session.project, session)
  return result, nil
end

function context.createBin(options)
  options = options or {}
  local session = createSession()
  local result = baseResult(session)
  if session.failure then
    result.failure = session.failure
    return result, session.failure
  end

  local name = validName(options.name)
  if name == nil then
    result.failure = {
      code = "INVALID_BIN_NAME",
      message = "Bin name is empty or contains unsupported characters."
    }
    return result, result.failure
  end
  local parentPath = validBinPath(options.parentPath)
  if parentPath == nil then
    result.failure = {
      code = "INVALID_BIN_PATH",
      message = "Parent bin path is invalid."
    }
    return result, result.failure
  end

  local mediaPool = recordCall(session, session.project, "GetMediaPool")
  if mediaPool == nil then
    result.failure = {
      code = "MEDIA_POOL_UNAVAILABLE",
      message = "Could not obtain the project MediaPool."
    }
    return result, result.failure
  end

  local parent, folderFailure = findFolder(mediaPool, parentPath, session)
  if parent == nil then
    result.failure = folderFailure
    return result, result.failure
  end

  for _, subfolder in ipairs(arrayItems(recordCall(session, parent, "GetSubFolderList"))) do
    if recordCall(session, subfolder, "GetName") == name then
      result.failure = {
        code = "BIN_ALREADY_EXISTS",
        message = "A bin with this name already exists: " .. joinBinPath(parentPath, name)
      }
      return result, result.failure
    end
  end

  local folder = recordCall(session, mediaPool, "AddSubFolder", parent, name)
  if folder == nil then
    result.failure = {
      code = "BIN_CREATE_FAILED",
      message = "Resolve did not create the media pool bin: " .. name
    }
    return result, result.failure
  end

  local binPath = joinBinPath(parentPath, name)
  result.bin = folderSummary(folder, binPath, session)
  result.binPath = binPath
  return result, nil
end

function context.importMedia(options)
  options = options or {}
  local session = createSession()
  local result = baseResult(session)
  if session.failure then
    result.failure = session.failure
    return result, session.failure
  end

  local filePaths = options.filePaths
  if type(filePaths) ~= "table" or #filePaths == 0 then
    result.failure = {
      code = "INVALID_MEDIA_PATHS",
      message = "At least one media file path is required."
    }
    return result, result.failure
  end
  if #filePaths > 100 then
    result.failure = {
      code = "TOO_MANY_MEDIA_PATHS",
      message = "At most 100 media paths can be imported per request."
    }
    return result, result.failure
  end

  local clipInfos = {}
  for index, filePath in ipairs(filePaths) do
    local path = trimmed(filePath)
    if path == nil or path == "" then
      result.failure = {
        code = "INVALID_MEDIA_PATH",
        message = "Media path at index " .. tostring(index) .. " is invalid."
      }
      return result, result.failure
    end
    clipInfos[index] = { FilePath = path }
  end

  local mediaPool = recordCall(session, session.project, "GetMediaPool")
  if mediaPool == nil then
    result.failure = {
      code = "MEDIA_POOL_UNAVAILABLE",
      message = "Could not obtain the project MediaPool."
    }
    return result, result.failure
  end

  local targetPath = nil
  if options.binPath ~= nil then
    targetPath = validBinPath(options.binPath)
    if targetPath == nil then
      result.failure = {
        code = "INVALID_BIN_PATH",
        message = "Target bin path is invalid."
      }
      return result, result.failure
    end
  end

  local targetFolder = nil
  if targetPath ~= nil then
    local folderFailure
    targetFolder, folderFailure = findFolder(mediaPool, targetPath, session)
    if targetFolder == nil then
      result.failure = folderFailure
      return result, result.failure
    end
  end

  local originalFolder = recordCall(session, mediaPool, "GetCurrentFolder")
  if targetFolder ~= nil then
    if recordCall(session, mediaPool, "SetCurrentFolder", targetFolder) ~= true then
      result.failure = {
        code = "BIN_SELECT_FAILED",
        message = "Could not select the target media pool bin: " .. targetPath
      }
      return result, result.failure
    end
  end

  -- 21.1 changed import calling conventions. Try the documented dict form first,
  -- then ProjectManager.AddItemListToMediaPool (MediaStorageItemInfo dicts),
  -- then the deprecated plain-path array form. Record which attempt succeeded.
  local mediaItems = {}
  local plainPaths = {}
  for index, filePath in ipairs(filePaths) do
    mediaItems[index] = { media = filePath }
    plainPaths[index] = filePath
  end

  local attempts = emptyArray()
  local imported = recordCall(session, mediaPool, "ImportMedia", clipInfos)
  if imported ~= nil then
    attempts[#attempts + 1] = "MediaPool.ImportMedia(clipInfo)"
  else
    local projectManager = session.manager
    if projectManager ~= nil then
      imported = optionalCall(session, projectManager, "AddItemListToMediaPool", mediaItems)
      if imported ~= nil then
        attempts[#attempts + 1] = "ProjectManager.AddItemListToMediaPool"
      end
    end
    if imported == nil then
      imported = recordCall(session, mediaPool, "ImportMedia", plainPaths)
      if imported ~= nil then
        attempts[#attempts + 1] = "MediaPool.ImportMedia(paths)"
      end
    end
  end

  local restored = false
  if targetFolder ~= nil and originalFolder ~= nil then
    restored = recordCall(session, mediaPool, "SetCurrentFolder", originalFolder) == true
  end

  if imported == nil then
    result.failure = {
      code = "MEDIA_IMPORT_FAILED",
      message = "Resolve did not import the requested media.",
      details = { attempts = attempts }
    }
    return result, result.failure
  end

  local items = arrayItems(imported)
  if #items == 0 then
    result.failure = {
      code = "NO_MEDIA_IMPORTED",
      message = "The import call returned no media pool items."
    }
    return result, result.failure
  end

  local clips = emptyArray()
  for index = 1, #items do
    clips[#clips + 1] = clipSummary(items[index], session)
  end

  result.imported = {
    count = #clips,
    clips = clips,
    binPath = targetPath,
    method = attempts[1],
    currentFolderRestored = restored
  }
  return result, nil
end

local TRACK_TYPES = { video = true, audio = true, subtitle = true }

local function validTrackType(value)
  if type(value) == "string" and TRACK_TYPES[value] then
    return value
  end
  return nil
end

local function idString(value)
  if type(value) ~= "string" then
    return nil
  end
  local id = trimmed(value)
  if id == nil or id == "" or #id > 64 then
    return nil
  end
  return id
end

-- Resolves media pool items by uniqueId or mediaId by walking every folder.
-- Returns nil plus a missing-ids list when any id cannot be matched.
local function findClipInFolder(folder, session)
  local clips = arrayItems(recordCall(session, folder, "GetClipList"))
  local byId = {}
  for _, clip in ipairs(clips) do
    local uniqueId = recordCall(session, clip, "GetUniqueId")
    local mediaId = recordCall(session, clip, "GetMediaId")
    if type(uniqueId) == "string" and uniqueId ~= "" then
      byId[uniqueId] = clip
    elseif type(uniqueId) == "number" then
      byId[tostring(uniqueId)] = clip
    end
    if type(mediaId) == "string" and mediaId ~= "" then
      byId[mediaId] = clip
    elseif type(mediaId) == "number" then
      byId[tostring(mediaId)] = clip
    end
  end
  return byId
end

local function resolveMediaItems(session, mediaPool, mediaIds)
  local wanted = {}
  for index, rawId in ipairs(mediaIds) do
    local id = idString(rawId)
    if id == nil then
      return nil, "Media id at index " .. tostring(index) .. " is invalid."
    end
    wanted[index] = id
  end

  local rootFolder = recordCall(session, mediaPool, "GetRootFolder")
  if rootFolder == nil then
    return nil, "Could not obtain the media pool root folder."
  end

  -- Depth-first walk; Resolve Free does not expose a flat clip iterator.
  local byId = {}
  local queue = { { folder = rootFolder, depth = 0 } }
  while #queue > 0 do
    local entry = table.remove(queue)
    if entry.depth <= 32 then
      for id, clip in pairs(findClipInFolder(entry.folder, session)) do
        byId[id] = byId[id] or clip
      end
      local subfolders = arrayItems(recordCall(session, entry.folder, "GetSubFolderList"))
      for _, subfolder in ipairs(subfolders) do
        queue[#queue + 1] = { folder = subfolder, depth = entry.depth + 1 }
      end
    end
  end

  local items = {}
  local missing = {}
  for index, id in ipairs(wanted) do
    local clip = byId[id]
    if clip ~= nil then
      items[#items + 1] = clip
    else
      missing[#missing + 1] = id
    end
  end
  if #missing > 0 then
    return nil, missing
  end
  return items
end

-- Resolves one timeline item from track coordinates (1-based, Resolve order).
local function findTimelineItem(session, timeline, trackType, trackIndex, itemIndex)
  local items = arrayItems(recordCall(
    session,
    timeline,
    "GetItemListInTrack",
    trackType,
    trackIndex
  ))
  for index, item in ipairs(items) do
    if index == itemIndex then
      return item, #items
    end
  end
  return nil, #items
end

function context.createTimeline(options)
  options = options or {}
  local session = createSession()
  local result = baseResult(session)
  if session.failure then
    result.failure = session.failure
    return result, session.failure
  end

  local mediaPool = recordCall(session, session.project, "GetMediaPool")
  if mediaPool == nil then
    result.failure = {
      code = "MEDIA_POOL_UNAVAILABLE",
      message = "Could not obtain the project MediaPool."
    }
    return result, result.failure
  end

  local name = nil
  if options.name ~= nil then
    name = validName(options.name)
    if name == nil then
      result.failure = {
        code = "INVALID_TIMELINE_NAME",
        message = "Timeline name is empty or contains unsupported characters."
      }
      return result, result.failure
    end
  end

  local mediaIds = options.mediaIds or {}
  if type(mediaIds) ~= "table" then
    result.failure = {
      code = "VALIDATION_ERROR",
      message = "mediaIds must be an array of clip ids."
    }
    return result, result.failure
  end
  if #mediaIds > 100 then
    result.failure = {
      code = "TOO_MANY_MEDIA_IDS",
      message = "At most 100 media ids can be used per timeline create."
    }
    return result, result.failure
  end

  -- Resolve requires a timeline name for both empty and clip-based create APIs.
  local timelineName = name or "Timeline"

  local timeline
  if #mediaIds == 0 then
    timeline = recordCall(session, mediaPool, "CreateEmptyTimeline", timelineName)
  else
    local items, resolveError = resolveMediaItems(session, mediaPool, mediaIds)
    if items == nil then
      result.failure = {
        code = "TIMELINE_CLIP_NOT_FOUND",
        message = "One or more media ids did not match media pool clips.",
        details = { missingIds = resolveError }
      }
      return result, result.failure
    end
    timeline = recordCall(session, mediaPool, "CreateTimelineFromClips", timelineName, items)
  end

  if timeline == nil then
    result.failure = {
      code = "TIMELINE_CREATE_FAILED",
      message = "Resolve did not create the timeline."
    }
    return result, result.failure
  end

  result.timeline = timelineSummary(timeline, session)
  result.timelineName = result.timeline.name
  result.timelines = listTimelines(session.project, session)
  result.created = true
  return result, nil
end

function context.appendClips(options)
  options = options or {}
  local session = createSession()
  local result = baseResult(session)
  if session.failure then
    result.failure = session.failure
    return result, session.failure
  end

  local timeline = recordCall(session, session.project, "GetCurrentTimeline")
  if timeline == nil then
    result.failure = {
      code = "TIMELINE_UNAVAILABLE",
      message = "No current timeline is open."
    }
    return result, result.failure
  end

  local mediaPool = recordCall(session, session.project, "GetMediaPool")
  if mediaPool == nil then
    result.failure = {
      code = "MEDIA_POOL_UNAVAILABLE",
      message = "Could not obtain the project MediaPool."
    }
    return result, result.failure
  end

  local mediaIds = options.mediaIds
  if type(mediaIds) ~= "table" or #mediaIds == 0 then
    result.failure = {
      code = "VALIDATION_ERROR",
      message = "mediaIds must be a non-empty array of clip ids."
    }
    return result, result.failure
  end
  if #mediaIds > 100 then
    result.failure = {
      code = "TOO_MANY_MEDIA_IDS",
      message = "At most 100 media ids can be appended per request."
    }
    return result, result.failure
  end

  local items, resolveError = resolveMediaItems(session, mediaPool, mediaIds)
  if items == nil then
    result.failure = {
      code = "TIMELINE_CLIP_NOT_FOUND",
      message = "One or more media ids did not match media pool clips.",
      details = { missingIds = resolveError }
    }
    return result, result.failure
  end

  local appended = recordCall(session, mediaPool, "AppendToTimeline", items)
  local appendedItems = arrayItems(appended)
  if #appendedItems == 0 then
    result.failure = {
      code = "APPEND_FAILED",
      message = "Resolve did not append any clips to the timeline."
    }
    return result, result.failure
  end

  local appendedSummaries = emptyArray()
  for index = 1, #appendedItems do
    appendedSummaries[#appendedSummaries + 1] = timelineItemSummary(appendedItems[index], session)
  end

  result.appended = {
    count = #appendedSummaries,
    items = appendedSummaries,
    timelineName = recordCall(session, timeline, "GetName")
  }
  return result, nil
end

local function rangeFrameValue(value)
  local number = tonumber(value)
  if number == nil or number < 0 or number ~= math.floor(number) then
    return nil
  end
  return number
end

-- Validates source-range segments. Every segment is described with an
-- exclusive end frame, which is also what AppendToTimeline expects on the live
-- Resolve Free 21.1 build, so no off-by-one conversion happens here.
local function validateRangeSegments(segments)
  if type(segments) ~= "table" or #segments == 0 then
    return nil, {
      code = "VALIDATION_ERROR",
      message = "segments must be a non-empty array of { mediaId, startFrame, endFrameExclusive }."
    }
  end
  if #segments > 1000 then
    return nil, {
      code = "TOO_MANY_SEGMENTS",
      message = "At most 1000 source ranges can be inserted per request."
    }
  end
  local normalized = {}
  for index, segment in ipairs(segments) do
    if type(segment) ~= "table" then
      return nil, {
        code = "VALIDATION_ERROR",
        message = "Segment at index " .. tostring(index) .. " is not an object.",
        details = { index = index }
      }
    end
    local mediaId = idString(segment.mediaId)
    if mediaId == nil then
      return nil, {
        code = "VALIDATION_ERROR",
        message = "Segment at index " .. tostring(index) .. " has an invalid mediaId.",
        details = { index = index }
      }
    end
    local startFrame = rangeFrameValue(segment.startFrame)
    local endFrameExclusive = rangeFrameValue(segment.endFrameExclusive)
    if startFrame == nil or endFrameExclusive == nil or endFrameExclusive <= startFrame then
      return nil, {
        code = "INVALID_SOURCE_RANGE",
        message = "Segment at index " .. tostring(index) .. " has an invalid source frame range.",
        details = { index = index, startFrame = segment.startFrame, endFrameExclusive = segment.endFrameExclusive }
      }
    end
    local trackIndex = nil
    if segment.trackIndex ~= nil then
      trackIndex = rangeFrameValue(segment.trackIndex)
      if trackIndex == nil or trackIndex < 1 or trackIndex > 100 then
        return nil, {
          code = "INVALID_TRACK_INDEX",
          message = "Segment at index " .. tostring(index) .. " has an invalid trackIndex.",
          details = { index = index }
        }
      end
    end
    local recordFrame = nil
    if segment.recordFrame ~= nil then
      recordFrame = rangeFrameValue(segment.recordFrame)
      if recordFrame == nil then
        return nil, {
          code = "INVALID_TIMELINE_POSITION",
          message = "Segment at index " .. tostring(index) .. " has an invalid recordFrame.",
          details = { index = index }
        }
      end
    end
    normalized[#normalized + 1] = {
      mediaId = mediaId,
      startFrame = startFrame,
      endFrameExclusive = endFrameExclusive,
      trackIndex = trackIndex,
      recordFrame = recordFrame,
      -- Linked source audio is placed on A1 when the caller asks for it; the
      -- default stays video-only so older callers keep their verified behaviour.
      includeAudio = segment.includeAudio == true
    }
  end
  return normalized, nil
end

-- Resolve does not create tracks on demand: AppendToTimeline with a trackIndex
-- above GetTrackCount returns an empty/invalid item and places nothing (live
-- Resolve Free 21.1 behaviour), so raise the count first. AddTrack must
-- actually increase GetTrackCount; a truthy return alone is not enough (live
-- multi-track failure 0b634dca returned an empty V2 item).
local function ensureTrackCount(session, timeline, trackType, requiredTracks)
  local existing = recordCall(session, timeline, "GetTrackCount", trackType)
  if type(existing) ~= "number" then
    existing = 1
  end
  local addedCount = 0
  if existing < requiredTracks and session.resolve ~= nil then
    -- AddTrack is more reliable on the Edit page.
    recordCall(session, session.resolve, "OpenPage", "edit")
  end
  local attempts = 0
  while existing < requiredTracks and attempts < requiredTracks + 2 do
    attempts = attempts + 1
    local before = existing
    local added = recordCall(session, timeline, "AddTrack", trackType)
    local reported = recordCall(session, timeline, "GetTrackCount", trackType)
    if type(reported) == "number" and reported > before then
      existing = reported
      addedCount = addedCount + 1
    else
      return nil, {
        code = "TRACK_CREATE_FAILED",
        message = "Could not add " .. trackType .. " track " .. tostring(before + 1)
          .. " needed for the requested source ranges"
          .. " (AddTrack returned " .. tostring(added)
          .. ", GetTrackCount stayed at " .. tostring(reported) .. ").",
        details = {
          trackType = trackType,
          requiredTracks = requiredTracks,
          existingTracks = before,
          reportedTracks = reported,
          addTrackResult = added,
          tracksAdded = addedCount
        }
      }
    end
  end
  return addedCount, nil
end

-- Appends validated source ranges sequentially. Stops on the first failure and
-- returns the exact partial state; it never reports success for an incomplete
-- sequence.
local function appendRangeSegments(session, mediaPool, timeline, segments)
  local normalized, validationFailure = validateRangeSegments(segments)
  if normalized == nil then
    return nil, validationFailure
  end

  local mediaIds = {}
  for index, segment in ipairs(normalized) do
    mediaIds[index] = segment.mediaId
  end
  local items, missing = resolveMediaItems(session, mediaPool, mediaIds)
  if items == nil then
    return nil, {
      code = "TIMELINE_CLIP_NOT_FOUND",
      message = "One or more media ids did not match media pool clips.",
      details = { missingIds = missing }
    }
  end

  local appendedSummaries = emptyArray()
  local segmentReports = emptyArray()
  local expectedTotal = 0
  local actualTotal = 0
  local actualTotalKnown = true
  local expectedAudioItems = 0

  local requiredTracks = 1
  for _, segment in ipairs(normalized) do
    if segment.trackIndex ~= nil and segment.trackIndex > requiredTracks then
      requiredTracks = segment.trackIndex
    end
  end
  local tracksAdded, trackFailure = ensureTrackCount(session, timeline, "video", requiredTracks)
  if tracksAdded == nil then
    return nil, trackFailure
  end

  local needsAudio = false
  for _, segment in ipairs(normalized) do
    if segment.includeAudio == true then
      needsAudio = true
    end
  end
  local audioTracksAdded = 0
  if needsAudio then
    local added, audioTrackFailure = ensureTrackCount(session, timeline, "audio", 1)
    if added == nil then
      return nil, audioTrackFailure
    end
    audioTracksAdded = added
  end

  for index, segment in ipairs(normalized) do
    -- Linked audio only lands on A1; a silent source must stay video-only
    -- instead of failing the insert. Unknown channel counts keep audio on.
    local includeAudio = segment.includeAudio == true
    if includeAudio then
      local channels = optionalCall(session, items[index], "GetClipProperty", "Audio Ch")
      local channelCount = tonumber(channels)
      if channelCount ~= nil and channelCount <= 0 then
        includeAudio = false
      end
    end

    local clipInfo = {
      mediaPoolItem = items[index],
      startFrame = segment.startFrame,
      -- Live Resolve Free 21.1 evidence: AppendToTimeline endFrame is exclusive
      -- (start 1200 / end 1799 produced 599 frames), so pass it unchanged.
      endFrame = segment.endFrameExclusive
    }
    if not includeAudio then
      -- Video-only placement: omit linked audio so multi-track inserts do not
      -- depend on matching audio-track layout.
      clipInfo.mediaType = 1
    end
    if segment.trackIndex ~= nil then
      clipInfo.trackIndex = segment.trackIndex
    end
    if segment.recordFrame ~= nil then
      clipInfo.recordFrame = segment.recordFrame
    end

    local appended = recordCall(session, mediaPool, "AppendToTimeline", { clipInfo })
    local appendedItems = arrayItems(appended)
    local item = appendedItems[1]
    local expectedDuration = segment.endFrameExclusive - segment.startFrame
    local actualDuration = item ~= nil and recordCall(session, item, "GetDuration") or nil
    local actualStart = item ~= nil and recordCall(session, item, "GetStart") or nil

    if #appendedItems == 0 or item == nil or type(actualDuration) ~= "number" then
      segmentReports[#segmentReports + 1] = {
        index = index,
        mediaId = segment.mediaId,
        startFrame = segment.startFrame,
        endFrameExclusive = segment.endFrameExclusive,
        endFrameSent = segment.endFrameExclusive,
        trackIndex = segment.trackIndex,
        recordFrame = segment.recordFrame,
        actualStart = actualStart,
        expectedDurationFrames = expectedDuration,
        actualDurationFrames = actualDuration,
        includeAudio = includeAudio,
        videoTracks = recordCall(session, timeline, "GetTrackCount", "video"),
        audioTracks = recordCall(session, timeline, "GetTrackCount", "audio")
      }
      return {
        appended = { count = #appendedSummaries, items = appendedSummaries, timelineName = recordCall(session, timeline, "GetName") },
        segments = segmentReports,
        expectedDurationFrames = expectedTotal + expectedDuration,
        actualDurationFrames = actualTotalKnown and actualTotal or nil,
        partial = true,
        tracksAdded = tracksAdded,
        videoTracks = recordCall(session, timeline, "GetTrackCount", "video"),
        audioTracks = recordCall(session, timeline, "GetTrackCount", "audio")
      }, {
        code = "SEGMENT_APPEND_FAILED",
        message = "Resolve did not append a usable source range at index " .. tostring(index)
          .. " (often means trackIndex is above GetTrackCount).",
        details = {
          failedIndex = index,
          mediaId = segment.mediaId,
          appendedCount = #appendedSummaries,
          trackIndex = segment.trackIndex,
          videoTracks = recordCall(session, timeline, "GetTrackCount", "video"),
          tracksAdded = tracksAdded
        }
      }
    end

    expectedTotal = expectedTotal + expectedDuration
    actualTotal = actualTotal + actualDuration
    if includeAudio then
      expectedAudioItems = expectedAudioItems + 1
    end

    appendedSummaries[#appendedSummaries + 1] = timelineItemSummary(item, session)
    segmentReports[#segmentReports + 1] = {
      index = index,
      mediaId = segment.mediaId,
      startFrame = segment.startFrame,
      endFrameExclusive = segment.endFrameExclusive,
      endFrameSent = segment.endFrameExclusive,
      trackIndex = segment.trackIndex,
      recordFrame = segment.recordFrame,
      actualStart = actualStart,
      expectedDurationFrames = expectedDuration,
      actualDurationFrames = actualDuration,
      includeAudio = includeAudio
    }

    if math.abs(actualDuration - expectedDuration) > 0.5 then
      return {
        appended = { count = #appendedSummaries, items = appendedSummaries, timelineName = recordCall(session, timeline, "GetName") },
        segments = segmentReports,
        expectedDurationFrames = expectedTotal,
        actualDurationFrames = actualTotal,
        partial = true,
        tracksAdded = tracksAdded,
        videoTracks = recordCall(session, timeline, "GetTrackCount", "video"),
        audioTracks = recordCall(session, timeline, "GetTrackCount", "audio")
      }, {
        code = "TIMELINE_DURATION_MISMATCH",
        message = "Resolve inserted a different duration for source range at index " .. tostring(index) .. ".",
        details = {
          failedIndex = index,
          mediaId = segment.mediaId,
          expectedDurationFrames = expectedDuration,
          actualDurationFrames = actualDuration
        }
      }
    end
  end

  -- Audio items are counted on A1 because linked placement is the only audio
  -- layout the bridge requests. A shortfall means Resolve silently dropped the
  -- linked audio even though the video items were accepted.
  local audioItemCount = 0
  if needsAudio then
    audioItemCount = #arrayItems(optionalCall(session, timeline, "GetItemListInTrack", "audio", 1))
  end

  local summary = {
    appended = { count = #appendedSummaries, items = appendedSummaries, timelineName = recordCall(session, timeline, "GetName") },
    segments = segmentReports,
    expectedDurationFrames = expectedTotal,
    actualDurationFrames = actualTotal,
    partial = false,
    tracksAdded = tracksAdded,
    videoTracks = recordCall(session, timeline, "GetTrackCount", "video"),
    audioTracks = recordCall(session, timeline, "GetTrackCount", "audio"),
    audioTracksAdded = audioTracksAdded,
    expectedAudioItems = expectedAudioItems,
    audioItems = audioItemCount
  }

  if needsAudio and audioItemCount < expectedAudioItems then
    summary.partial = true
    return summary, {
      code = "AUDIO_APPEND_FAILED",
      message = "Resolve placed " .. tostring(audioItemCount) .. " audio items on A1 but "
        .. tostring(expectedAudioItems) .. " were requested for the linked source ranges.",
      details = {
        expectedAudioItems = expectedAudioItems,
        audioItems = audioItemCount,
        audioTracks = summary.audioTracks,
        videoTracks = summary.videoTracks
      }
    }
  end

  return summary, nil
end

function context.createTimelineFromRanges(options)
  options = options or {}
  local session = createSession()
  local result = baseResult(session)
  if session.failure then
    result.failure = session.failure
    return result, session.failure
  end

  local mediaPool = recordCall(session, session.project, "GetMediaPool")
  if mediaPool == nil then
    result.failure = {
      code = "MEDIA_POOL_UNAVAILABLE",
      message = "Could not obtain the project MediaPool."
    }
    return result, result.failure
  end

  local name = nil
  if options.name ~= nil then
    name = validName(options.name)
    if name == nil then
      result.failure = {
        code = "INVALID_TIMELINE_NAME",
        message = "Timeline name is empty or contains unsupported characters."
      }
      return result, result.failure
    end
  end
  local timelineName = name or "Timeline"
  local timeline = recordCall(session, mediaPool, "CreateEmptyTimeline", timelineName)
  if timeline == nil then
    result.failure = {
      code = "TIMELINE_CREATE_FAILED",
      message = "Resolve did not create the timeline."
    }
    return result, result.failure
  end

  result.timeline = timelineSummary(timeline, session)
  result.timelineName = result.timeline.name
  result.created = true

  local rangeResult, rangeFailure = appendRangeSegments(session, mediaPool, timeline, options.segments)
  if rangeResult ~= nil then
    result.appended = rangeResult.appended
    result.segments = rangeResult.segments
    result.expectedDurationFrames = rangeResult.expectedDurationFrames
    result.actualDurationFrames = rangeResult.actualDurationFrames
    result.partial = rangeResult.partial
    result.tracksAdded = rangeResult.tracksAdded
    result.videoTracks = rangeResult.videoTracks
    result.audioTracks = rangeResult.audioTracks
    result.audioTracksAdded = rangeResult.audioTracksAdded
    result.expectedAudioItems = rangeResult.expectedAudioItems
    result.audioItems = rangeResult.audioItems
  end
  -- Refresh after AddTrack / AppendToTimeline so callers see the true track count.
  result.timeline = timelineSummary(timeline, session)
  result.timelineName = result.timeline.name
  if rangeFailure ~= nil then
    result.failure = rangeFailure
    result.timelines = listTimelines(session.project, session)
    return result, rangeFailure
  end

  result.timelines = listTimelines(session.project, session)
  return result, nil
end

function context.appendRanges(options)
  options = options or {}
  local session = createSession()
  local result = baseResult(session)
  if session.failure then
    result.failure = session.failure
    return result, session.failure
  end

  local timeline = recordCall(session, session.project, "GetCurrentTimeline")
  if timeline == nil then
    result.failure = {
      code = "TIMELINE_UNAVAILABLE",
      message = "No current timeline is open."
    }
    return result, result.failure
  end

  local mediaPool = recordCall(session, session.project, "GetMediaPool")
  if mediaPool == nil then
    result.failure = {
      code = "MEDIA_POOL_UNAVAILABLE",
      message = "Could not obtain the project MediaPool."
    }
    return result, result.failure
  end

  local rangeResult, rangeFailure = appendRangeSegments(session, mediaPool, timeline, options.segments)
  if rangeResult ~= nil then
    result.appended = rangeResult.appended
    result.segments = rangeResult.segments
    result.expectedDurationFrames = rangeResult.expectedDurationFrames
    result.actualDurationFrames = rangeResult.actualDurationFrames
    result.partial = rangeResult.partial
    result.tracksAdded = rangeResult.tracksAdded
    result.videoTracks = rangeResult.videoTracks
    result.audioTracks = rangeResult.audioTracks
    result.audioTracksAdded = rangeResult.audioTracksAdded
    result.expectedAudioItems = rangeResult.expectedAudioItems
    result.audioItems = rangeResult.audioItems
  end
  if rangeFailure ~= nil then
    result.failure = rangeFailure
    return result, rangeFailure
  end
  return result, nil
end

function context.deleteClips(options)
  options = options or {}
  local session = createSession()
  local result = baseResult(session)
  if session.failure then
    result.failure = session.failure
    return result, session.failure
  end

  local timeline = recordCall(session, session.project, "GetCurrentTimeline")
  if timeline == nil then
    result.failure = {
      code = "TIMELINE_UNAVAILABLE",
      message = "No current timeline is open."
    }
    return result, result.failure
  end

  local targets = options.targets
  if type(targets) ~= "table" or #targets == 0 then
    result.failure = {
      code = "VALIDATION_ERROR",
      message = "targets must be a non-empty array of { trackType, trackIndex, itemIndices }."
    }
    return result, result.failure
  end
  if #targets > 50 then
    result.failure = {
      code = "VALIDATION_ERROR",
      message = "At most 50 delete targets are allowed per request."
    }
    return result, result.failure
  end

  local deleteItems = {}
  local requested = 0
  for index, target in ipairs(targets) do
    local trackType = validTrackType(type(target) == "table" and target.trackType or nil)
    if trackType == nil then
      result.failure = {
        code = "VALIDATION_ERROR",
        message = "Target at index " .. tostring(index) .. " has an invalid trackType."
      }
      return result, result.failure
    end
    local trackIndex = clampInteger(target.trackIndex, 0, 1, 100)
    if trackIndex < 1 then
      result.failure = {
        code = "VALIDATION_ERROR",
        message = "Target at index " .. tostring(index) .. " has an invalid trackIndex."
      }
      return result, result.failure
    end
    local itemIndices = type(target) == "table" and target.itemIndices or nil
    if type(itemIndices) ~= "table" or #itemIndices == 0 then
      result.failure = {
        code = "VALIDATION_ERROR",
        message = "Target at index " .. tostring(index) .. " has no itemIndices."
      }
      return result, result.failure
    end

    for _, rawItemIndex in ipairs(itemIndices) do
      local itemIndex = clampInteger(rawItemIndex, 0, 1, 500)
      if itemIndex < 1 then
        result.failure = {
          code = "VALIDATION_ERROR",
          message = "Target at index " .. tostring(index) .. " has an invalid itemIndex."
        }
        return result, result.failure
      end
      local item = findTimelineItem(session, timeline, trackType, trackIndex, itemIndex)
      if item == nil then
        result.failure = {
          code = "TIMELINE_ITEM_NOT_FOUND",
          message = "Timeline item not found: "
            .. trackType .. " track " .. tostring(trackIndex)
            .. " item " .. tostring(itemIndex)
        }
        return result, result.failure
      end
      deleteItems[#deleteItems + 1] = item
      requested = requested + 1
    end
  end

  local deleted = recordCall(session, timeline, "DeleteClips", deleteItems)
  if deleted ~= true then
    result.failure = {
      code = "DELETE_FAILED",
      message = "Resolve did not delete the requested timeline items."
    }
    return result, result.failure
  end

  result.deleted = { count = requested }
  return result, nil
end

function context.setItemProperty(options)
  options = options or {}
  local session = createSession()
  local result = baseResult(session)
  if session.failure then
    result.failure = session.failure
    return result, session.failure
  end

  local timeline = recordCall(session, session.project, "GetCurrentTimeline")
  if timeline == nil then
    result.failure = {
      code = "TIMELINE_UNAVAILABLE",
      message = "No current timeline is open."
    }
    return result, result.failure
  end

  local target = options.target
  if type(target) ~= "table" then
    result.failure = {
      code = "VALIDATION_ERROR",
      message = "target must be an object { trackType, trackIndex, itemIndex }."
    }
    return result, result.failure
  end
  local trackType = validTrackType(target.trackType)
  if trackType == nil then
    result.failure = {
      code = "VALIDATION_ERROR",
      message = "target.trackType must be video, audio or subtitle."
    }
    return result, result.failure
  end
  local trackIndex = clampInteger(target.trackIndex, 0, 1, 100)
  local itemIndex = clampInteger(target.itemIndex, 0, 1, 500)
  if trackIndex < 1 or itemIndex < 1 then
    result.failure = {
      code = "VALIDATION_ERROR",
      message = "target.trackIndex and target.itemIndex must be positive integers."
    }
    return result, result.failure
  end

  local properties = options.properties
  if type(properties) ~= "table" then
    result.failure = {
      code = "VALIDATION_ERROR",
      message = "properties must be an object of { key = value } pairs."
    }
    return result, result.failure
  end

  local keys = {}
  for key, value in pairs(properties) do
    if type(key) ~= "string" or #key == 0 or #key > 64 then
      result.failure = {
        code = "VALIDATION_ERROR",
        message = "Property keys must be non-empty strings of at most 64 characters."
      }
      return result, result.failure
    end
    if type(value) ~= "string" and type(value) ~= "number" and type(value) ~= "boolean" then
      result.failure = {
        code = "VALIDATION_ERROR",
        message = "Property values must be strings, numbers or booleans."
      }
      return result, result.failure
    end
    keys[#keys + 1] = key
  end
  if #keys == 0 then
    result.failure = {
      code = "VALIDATION_ERROR",
      message = "properties must contain at least one key."
    }
    return result, result.failure
  end
  if #keys > 20 then
    result.failure = {
      code = "VALIDATION_ERROR",
      message = "At most 20 properties can be set per request."
    }
    return result, result.failure
  end

  local item = findTimelineItem(session, timeline, trackType, trackIndex, itemIndex)
  if item == nil then
    result.failure = {
      code = "TIMELINE_ITEM_NOT_FOUND",
      message = "Timeline item not found: "
        .. trackType .. " track " .. tostring(trackIndex)
        .. " item " .. tostring(itemIndex)
    }
    return result, result.failure
  end

  local applied = emptyArray()
  local batch = {}
  local batchIndices = {}
  local failedProperties = emptyArray()

  for _, key in ipairs(keys) do
    if key == "Clip Color" then
      local appliedOk = recordCall(session, item, "SetClipColor", properties[key])
      applied[#applied + 1] = {
        key = key,
        applied = appliedOk == true
      }
      if appliedOk ~= true then
        failedProperties[#failedProperties + 1] = key
      end
    elseif key == "Name" or key == "Clip Name" then
      local appliedOk = recordCall(session, item, "SetName", tostring(properties[key]))
      applied[#applied + 1] = {
        key = key,
        applied = appliedOk == true
      }
      if appliedOk ~= true then
        failedProperties[#failedProperties + 1] = key
      end
    else
      batch[key] = properties[key]
      batchIndices[#batchIndices + 1] = #applied + 1
      applied[#applied + 1] = {
        key = key,
        applied = false
      }
    end
  end

  if next(batch) ~= nil then
    local appliedOk = recordCall(session, item, "SetProperties", batch)
    for _, index in ipairs(batchIndices) do
      applied[index].applied = appliedOk == true
      if appliedOk ~= true then
        failedProperties[#failedProperties + 1] = applied[index].key
      end
    end
  end

  result.item = timelineItemSummary(item, session)
  result.applied = applied
  result.itemIndex = itemIndex
  result.target = {
    trackType = trackType,
    trackIndex = trackIndex,
    itemIndex = itemIndex
  }
  if #failedProperties > 0 then
    result.failure = {
      code = "PROPERTY_SET_FAILED",
      message = "Resolve did not confirm that all requested timeline item properties were applied.",
      details = { failedProperties = failedProperties }
    }
    return result, result.failure
  end
  return result, nil
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
