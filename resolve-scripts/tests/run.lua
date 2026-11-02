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
local markedEmpty = setmetatable({}, { __jsontype = "array" })
check(json.encode(markedEmpty) == "[]", "marked empty array")
check(json.encode({ items = markedEmpty }) == '{"items":[]}', "nested marked empty array")

local ok = pcall(json.decode, '{"broken":')
check(not ok, "invalid JSON must fail")

local escaped = json.encode({ text = 'line\n"quote"' })
local escapedRoundTrip = json.decode(escaped)
check(escapedRoundTrip.text == 'line\n"quote"', "escaping round trip")

local previousResolve = resolve
local clip = {
  GetName = function() return "clip1.mov" end,
  GetUniqueId = function() return "clip-id-1" end,
  GetMediaId = function() return "media-id-1" end,
  GetClipProperty = function(_, key)
    local properties = {
      ["Type"] = "Video",
      ["File Path"] = "C:\\media\\clip1.mov",
      ["Duration"] = "00:00:10:00",
      ["Frames"] = "240",
      ["Resolution"] = "1920x1080",
      ["FPS"] = "24"
    }
    return properties[key]
  end
}
local rootFolder = {
  __flags = 4194304,
  [1] = clip,
  GetName = function() return "Master" end,
  GetClipList = function() return { __flags = 4194304, [1] = clip } end,
  GetSubFolderList = function() return { __flags = 4194304 } end
}
local item = {
  GetName = function() return "clip1.mov" end,
  GetStart = function() return 0 end,
  GetEnd = function() return 239 end,
  GetDuration = function() return 240 end,
  GetTrackType = function() return "video" end,
  GetTrackIndex = function() return 1 end
}
local timeline = {
  GetName = function() return "Timeline 1" end,
  GetUniqueId = function() return "timeline-id-1" end,
  GetStartFrame = function() return 0 end,
  GetEndFrame = function() return 239 end,
  GetStartTimecode = function() return "01:00:00:00" end,
  GetTrackCount = function(_, kind) return kind == "subtitle" and 0 or 1 end,
  GetSettings = function() return { timelineFrameRate = "24" } end,
  GetItemListInTrack = function(_, kind, index)
    if kind == "video" and index == 1 then
      return { __flags = 4194304, [1] = item }
    end
    return { __flags = 4194304 }
  end,
  GetMarkers = function() return { __flags = 4194304, [100] = { name = "Marker A" } } end
}
local project = {
  GetName = function() return "Fake Project" end,
  GetUniqueId = function() return "project-id-1" end,
  GetSettings = function() return { timelineResolutionWidth = "1920", timelineResolutionHeight = "1080" } end,
  GetTimelineCount = function() return 1 end,
  GetCurrentTimeline = function() return timeline end,
  GetTimelineByIndex = function(_, index) return index == 1 and timeline or nil end,
  GetMediaPool = function() return { GetRootFolder = function() return rootFolder end } end,
  GetCurrentRenderFormatAndCodec = function() return { format = "mp4", codec = "H264" } end,
  GetRenderFormats = function() return { __flags = 4194304, MP4 = "mp4", QuickTime = "mov" } end,
  GetRenderCodecs = function(_, format) return { __flags = 4194304, H264 = "H264", H265 = "H265" } end,
  GetRenderPresetList = function() return { __flags = 4194304, [1] = "H.264 Master" } end,
  GetRenderSettings = function() return { SelectAllFrames = true, TargetDir = "C:\\renders" } end,
  GetRenderJobList = function() return { __flags = 4194304 } end,
  GetRenderJobStatus = function() return nil end
}
local manager = {
  GetCurrentProject = function() return project end,
  GetProjectListInCurrentFolder = function() return { __flags = 4194304, [1] = "Fake Project" } end,
  GetCurrentFolder = function() return "" end
}
resolve = {
  GetVersionString = function() return "21.1.0.17" end,
  IsStudio = function() return false end,
  GetCurrentPage = function() return "media" end,
  GetProjectManager = function() return manager end
}

local context = dofile(root .. "\\lib\\resolve-context.lua")
context.setResolve(resolve)
local projectResult, projectFailure = context.inspectProject({})
check(projectFailure == nil and projectResult.project.name == "Fake Project", "project inspection")
check(projectResult.projectManager.projectCount == 1, "project list ignores internal keys")
check(json.decode(json.encode(projectResult)).project.name == "Fake Project", "project result JSON")

local mediaResult, mediaFailure = context.inspectMedia({})
check(mediaFailure == nil and mediaResult.mediaPool.clipCount == 1, "media clip count")
check(mediaResult.mediaPool.bins[1].clips[1].name == "clip1.mov", "media clip summary")

local timelineResult, timelineFailure = context.inspectTimeline({})
check(timelineFailure == nil and timelineResult.timeline.name == "Timeline 1", "timeline inspection")
check(timelineResult.tracks.video[1].itemCount == 1, "timeline track item count")
check(timelineResult.markers[1].frame == 100, "timeline markers")
check(timelineResult.timelines[1].name == "Timeline 1", "timeline list")

local renderResult, renderFailure = context.inspectRender({ includeJobs = true })
check(renderFailure == nil and renderResult.render.formats.MP4 == "mp4", "render formats")
check(renderResult.render.codecs.H264 == "H264", "render codecs")
check(renderResult.render.currentFormatAndCodec.codec == "H264", "render current codec")

local savedRenderSettings = project.GetRenderSettings
project.GetRenderSettings = nil
local optionalRenderResult, optionalRenderFailure = context.inspectRender({})
check(optionalRenderFailure == nil and optionalRenderResult.render.formats.MP4 == "mp4", "render without optional settings")
check(#optionalRenderResult.errors == 0, "missing optional render method is not an error")
project.GetRenderSettings = savedRenderSettings

local rootChildren = { __flags = 4194304 }
local function makeManagedFolder(name, uniqueId)
  local folder = {
    _children = { __flags = 4194304 },
    GetName = function() return name end,
    GetUniqueId = function() return uniqueId or ("folder-" .. name) end,
    GetClipList = function() return { __flags = 4194304 } end
  }
  folder.GetSubFolderList = function() return folder._children end
  return folder
end

local managedRoot = makeManagedFolder("Master", "root-folder")
managedRoot._children = rootChildren
local managedPool
local managedCurrentFolder = managedRoot
local managedSaves = 0
local importCount = 0
managedPool = {
  GetRootFolder = function() return managedRoot end,
  GetCurrentFolder = function() return managedCurrentFolder end,
  SetCurrentFolder = function(_, folder)
    managedCurrentFolder = folder
    return true
  end,
  AddSubFolder = function(_, parent, name)
    local folder = makeManagedFolder(name)
    parent._children[#parent._children + 1] = folder
    return folder
  end,
  ImportMedia = function(_, clipInfos)
    local items = { __flags = 4194304 }
    for _, info in ipairs(clipInfos) do
      importCount = importCount + 1
      items[#items + 1] = {
        GetName = function() return "imported-" .. tostring(importCount) .. ".wav" end,
        GetUniqueId = function() return "imported-id-" .. tostring(importCount) end,
        GetMediaId = function() return "imported-media-" .. tostring(importCount) end,
        GetClipProperty = function(_, key)
          if key == "File Path" then return info.FilePath end
          if key == "Type" then return "Audio" end
          return nil
        end
      }
    end
    return items
  end
}

local managedProjects = { "Fake Project" }
local function makeManagedProject(name)
  return {
    GetName = function() return name end,
    GetUniqueId = function() return "project-" .. name end,
    GetTimelineCount = function() return 0 end,
    GetMediaPool = function() return managedPool end
  }
end
local managedCurrentProject = makeManagedProject("Fake Project")

local managedManager = {
  GetCurrentProject = function() return managedCurrentProject end,
  GetProjectListInCurrentFolder = function() return managedProjects end,
  GetCurrentFolder = function() return "" end,
  CreateProject = function(_, name)
    for _, existing in ipairs(managedProjects) do
      if existing == name then return nil end
    end
    managedProjects[#managedProjects + 1] = name
    managedCurrentProject = makeManagedProject(name)
    return managedCurrentProject
  end,
  LoadProject = function(_, name)
    for _, existing in ipairs(managedProjects) do
      if existing == name then
        managedCurrentProject = makeManagedProject(name)
        return managedCurrentProject
      end
    end
    return nil
  end,
  SaveProject = function()
    managedSaves = managedSaves + 1
    return true
  end
}
resolve = {
  GetVersionString = function() return "21.1.0.17" end,
  IsStudio = function() return false end,
  GetCurrentPage = function() return "media" end,
  GetProjectManager = function() return managedManager end
}
context.setResolve(resolve)

local createdProject, createFailure = context.createProject({ name = "New Project" })
check(createFailure == nil and createdProject.project.name == "New Project", "create project")
local duplicateProject, duplicateFailure = context.createProject({ name = "New Project" })
check(duplicateProject ~= nil and duplicateFailure.code == "PROJECT_ALREADY_EXISTS", "duplicate project rejected")

local openedProject, openFailure = context.openProject({ name = "Fake Project", saveCurrent = true })
check(openFailure == nil and openedProject.project.name == "Fake Project", "open project")
check(openedProject.savedCurrent == true and managedSaves == 1, "save current before open")
local missingProject, missingFailure = context.openProject({ name = "Missing Project" })
check(missingProject ~= nil and missingFailure.code == "PROJECT_NOT_FOUND", "missing project rejected")

local savedProject, saveFailure = context.saveProject()
check(saveFailure == nil and savedProject.saved == true and managedSaves == 2, "save project")

local footageBin, footageFailure = context.createBin({ name = "Footage" })
check(footageFailure == nil and footageBin.bin.path == "Footage", "create root bin")
local angleBin, angleFailure = context.createBin({ name = "Angle A", parentPath = "Footage" })
check(angleFailure == nil and angleBin.bin.path == "Footage/Angle A", "create nested bin")
local duplicateBin, duplicateBinFailure = context.createBin({ name = "Footage" })
check(duplicateBin ~= nil and duplicateBinFailure.code == "BIN_ALREADY_EXISTS", "duplicate bin rejected")

local imported, importFailure = context.importMedia({
  filePaths = { "C:\\media\\tone.wav" },
  binPath = "Footage/Angle A"
})
check(importFailure == nil and imported.imported.count == 1, "import media into bin")
check(imported.imported.currentFolderRestored == true, "restore current folder after import")
check(imported.imported.clips[1].filePath == "C:\\media\\tone.wav", "imported clip summary")
local missingBin, missingBinFailure = context.importMedia({
  filePaths = { "C:\\media\\tone.wav" },
  binPath = "Missing/Bin"
})
check(missingBin ~= nil and missingBinFailure.code == "BIN_NOT_FOUND", "missing import bin rejected")

local prefs = dofile(root .. "\\lib\\prefs.lua")
local store = {}
local fakeFusion = {}
function fakeFusion:GetPrefs(key)
  return store[key]
end
function fakeFusion:SetPrefs(key, value)
  store[key] = value
end
function fakeFusion:SavePrefs()
  return true
end
prefs.setFusion(fakeFusion)
check(prefs.available(), "prefs availability")
check(prefs.publishResponse("id-1", '{"value":1}', true), "prefs publish")
check(prefs.hasProcessed("id-1"), "prefs idempotency")
check(prefs.responseJsonFor("id-1") == '{"value":1}', "prefs response replay")
check(prefs.publishResponse("id-2", '{"value":2}', true), "prefs publish second")
check(prefs.hasProcessed("id-1") and prefs.hasProcessed("id-2"), "prefs keeps processed ids")
check(prefs.processedIds()[1] == "id-1", "prefs processed order")
prefs.recordError("boom")
check(prefs.get(prefs.KEYS.error) == "boom", "prefs error reporting")
prefs.setStage("test-stage")
check(prefs.get(prefs.KEYS.stage) == "test-stage", "prefs stage")

resolve = previousResolve
print("Lua tests passed: " .. tostring(passed))
