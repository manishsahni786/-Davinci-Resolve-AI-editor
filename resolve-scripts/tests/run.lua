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
      ["FPS"] = "24",
      ["Audio Ch"] = "2"
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
check(mediaResult.mediaPool.bins[1].clips[1].durationSeconds == 10, "media duration seconds from frames and fps")

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
  OpenPage = function(_, page) return page ~= nil end,
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

local timelineItems = { __flags = 4194304 }
local managedTimelines = {}
local function makeManagedTimeline(name, uniqueId)
  local timelineObject = {
    name = name,
    uniqueId = uniqueId or ("timeline-" .. name),
    videoTrackCount = 1,
    GetName = function(self) return self.name end,
    GetUniqueId = function(self) return self.uniqueId end,
    GetStartFrame = function() return 0 end,
    GetEndFrame = function() return 239 end,
    GetStartTimecode = function() return "01:00:00:00" end,
    AddTrack = function(self, kind)
      if kind == "video" then
        self.videoTrackCount = (self.videoTrackCount or 1) + 1
        return true
      end
      return false
    end,
    GetTrackCount = function(self, kind)
      if kind == "subtitle" then
        return 0
      end
      if kind == "video" then
        local count = self.videoTrackCount or 1
        for _, item in ipairs(timelineItems) do
          count = math.max(count, item.GetTrackIndex())
        end
        return count
      end
      return 1
    end,
    GetSettings = function() return { timelineFrameRate = "24" } end,
    GetMarkers = function() return { __flags = 4194304 } end,
    GetItemListInTrack = function(_, kind, index)
      local filtered = { __flags = 4194304 }
      for _, item in ipairs(timelineItems) do
        if (kind == nil or item.GetTrackType() == kind) and item.GetTrackIndex() == index then
          filtered[#filtered + 1] = item
        end
      end
      return filtered
    end,
    DeleteClips = function(_, items)
      local remaining = { __flags = 4194304 }
      local remove = {}
      for _, victim in ipairs(items) do
        remove[victim] = true
      end
      for _, existing in ipairs(timelineItems) do
        if not remove[existing] then
          remaining[#remaining + 1] = existing
        end
      end
      timelineItems = remaining
      return true
    end
  }
  return timelineObject
end

local function makeTimelineItem(name, startFrame, finishFrame, sourceStartFrame, sourceEndFrame, trackIndex, mediaItem, trackType)
  local properties = {}
  local track = trackIndex or 1
  local sourceStart = sourceStartFrame or 0
  local sourceEnd = sourceEndFrame or (finishFrame - startFrame - 1)
  local kind = trackType or "video"
  return {
    GetName = function() return name end,
    GetStart = function() return startFrame end,
    GetEnd = function() return finishFrame end,
    GetDuration = function() return finishFrame - startFrame end,
    GetSourceStartFrame = function() return sourceStart end,
    GetSourceEndFrame = function() return sourceEnd end,
    GetMediaPoolItem = function() return mediaItem end,
    GetTrackType = function() return kind end,
    GetTrackIndex = function() return track end,
    SetProperties = function(_, values)
      for key, value in pairs(values) do
        properties[key] = value
      end
      return true
    end,
    SetClipColor = function(_, color)
      properties["Clip Color"] = color
      return true
    end,
    GetProperty = function(_, key)
      return properties[key]
    end
  }
end

managedRoot.GetClipList = function()
  return { __flags = 4194304, [1] = clip }
end

managedPool.CreateEmptyTimeline = function(_, name)
  local created = makeManagedTimeline(name)
  timelineItems = { __flags = 4194304 }
  managedTimelines[#managedTimelines + 1] = created
  managedCurrentProject._currentTimeline = created
  return created
end
managedPool.CreateTimelineFromClips = function(_, name, items)
  local created = makeManagedTimeline(name)
  timelineItems = { __flags = 4194304 }
  for index, mediaItem in ipairs(items) do
    timelineItems[#timelineItems + 1] = makeTimelineItem(
      mediaItem.GetName(),
      (index - 1) * 240,
      index * 240
    )
  end
  managedTimelines[#managedTimelines + 1] = created
  managedCurrentProject._currentTimeline = created
  return created
end
managedPool.AppendToTimeline = function(_, items)
  local appended = { __flags = 4194304 }
  for _, entry in ipairs(items) do
    local mediaItem = entry
    local clipInfo = nil
    if entry.mediaPoolItem ~= nil then
      mediaItem = entry.mediaPoolItem
      clipInfo = entry
    end
    local trackIndex = clipInfo and clipInfo.trackIndex or 1
    local sourceStart = clipInfo and clipInfo.startFrame or 0
    local duration = 240
    if clipInfo and clipInfo.endFrame ~= nil then
      -- Live Resolve Free 21.1 behaviour: AppendToTimeline endFrame is exclusive,
      -- so duration is endFrame - startFrame (verified: 1200..1799 -> 599 frames).
      duration = clipInfo.endFrame - sourceStart
    end
    local start
    if clipInfo and clipInfo.recordFrame ~= nil then
      start = clipInfo.recordFrame
    else
      start = 0
      for _, existing in ipairs(timelineItems) do
        if existing.GetTrackIndex() == trackIndex then
          start = math.max(start, existing.GetEnd())
        end
      end
    end
    local item = makeTimelineItem(
      mediaItem.GetName(),
      start,
      start + duration,
      sourceStart,
      sourceStart + duration,
      trackIndex,
      mediaItem
    )
    timelineItems[#timelineItems + 1] = item
    appended[#appended + 1] = item
    -- Omitting mediaType means video + linked audio in Resolve, so the mock
    -- records the mirrored A1 item too.
    if clipInfo ~= nil and clipInfo.mediaType == nil then
      local audioItem = makeTimelineItem(
        mediaItem.GetName(),
        start,
        start + duration,
        sourceStart,
        sourceStart + duration,
        1,
        mediaItem,
        "audio"
      )
      timelineItems[#timelineItems + 1] = audioItem
      appended[#appended + 1] = audioItem
    end
  end
  return appended
end

managedCurrentProject.GetTimelineCount = function() return #managedTimelines end
managedCurrentProject.GetCurrentTimeline = function() return managedCurrentProject._currentTimeline end
managedCurrentProject.GetTimelineByIndex = function(_, index) return managedTimelines[index] end
managedCurrentProject._currentTimeline = nil

local emptyTimeline, emptyTimelineFailure = context.createTimeline({ name = "Empty Reel" })
check(emptyTimelineFailure == nil and emptyTimeline.timeline.name == "Empty Reel", "create empty timeline")
check(emptyTimeline.created == true, "empty timeline created flag")

local fromClips, fromClipsFailure = context.createTimeline({
  name = "From Clips",
  mediaIds = { "clip-id-1" }
})
check(fromClipsFailure == nil and fromClips.timeline.name == "From Clips", "create timeline from clips")
check(#timelineItems == 1, "timeline from clips has one item")

local missingClipTimeline, missingClipFailure = context.createTimeline({
  name = "Missing",
  mediaIds = { "no-such-clip" }
})
check(missingClipTimeline ~= nil and missingClipFailure.code == "TIMELINE_CLIP_NOT_FOUND", "missing clip rejected on create")

local appendedClips, appendFailure = context.appendClips({ mediaIds = { "media-id-1" } })
check(appendFailure == nil and appendedClips.appended.count == 1, "append clips to timeline")
check(#timelineItems == 2, "timeline has two items after append")

local rangeTimeline, rangeFailure = context.createTimelineFromRanges({
  name = "Range Reel",
  segments = {
    { mediaId = "clip-id-1", startFrame = 10, endFrameExclusive = 34, trackIndex = 1, recordFrame = 0 },
    { mediaId = "media-id-1", startFrame = 5, endFrameExclusive = 25, trackIndex = 2, recordFrame = 24 }
  }
})
check(rangeFailure == nil and rangeTimeline.timeline.name == "Range Reel", "create timeline from source ranges")
check(rangeTimeline.expectedDurationFrames == 44, "range timeline expected duration")
check(rangeTimeline.actualDurationFrames == 44, "range timeline actual duration")
check(rangeTimeline.segments[1].endFrameSent == 34, "range end passed through as exclusive frame")
check(rangeTimeline.segments[2].trackIndex == 2, "range track index preserved")
check(rangeTimeline.tracksAdded == 1, "range timeline added one video track")
check(rangeTimeline.videoTracks == 2, "range timeline reports two video tracks")
check(#timelineItems == 2, "range timeline has two items")
check(timelineItems[1].GetSourceStartFrame() == 10 and timelineItems[1].GetSourceEndFrame() == 34, "range one source frames")
check(timelineItems[1].GetDuration() == 24, "range one duration")
check(timelineItems[2].GetTrackIndex() == 2 and timelineItems[2].GetStart() == 24, "range two track and record frame")
check(rangeTimeline.audioItems == 0 and rangeTimeline.expectedAudioItems == 0, "ranges stay video-only unless audio is requested")

local audioTimeline, audioFailure = context.createTimelineFromRanges({
  name = "Audio Range Reel",
  segments = {
    { mediaId = "clip-id-1", startFrame = 10, endFrameExclusive = 34, trackIndex = 1, recordFrame = 0, includeAudio = true },
    { mediaId = "media-id-1", startFrame = 5, endFrameExclusive = 25, trackIndex = 1, recordFrame = 24, includeAudio = true }
  }
})
check(audioFailure == nil and audioTimeline.timeline.name == "Audio Range Reel", "create range timeline with linked audio")
check(audioTimeline.expectedAudioItems == 2 and audioTimeline.audioItems == 2, "two linked audio items placed on A1")
check(audioTimeline.audioTracks == 1 and audioTimeline.segments[1].includeAudio == true, "audio track and segment audio flag reported")
local audioTrackItems = managedTimelines[#managedTimelines]:GetItemListInTrack("audio", 1)
check(#audioTrackItems == 2, "A1 holds both audio items")
check(audioTrackItems[1].GetStart() == 0 and audioTrackItems[2].GetStart() == 24, "audio items mirror video record frames")
check(audioTrackItems[1].GetSourceStartFrame() == 10 and audioTrackItems[1].GetSourceEndFrame() == 34, "audio item keeps the source range")

local baseAppendToTimeline = managedPool.AppendToTimeline
managedPool.AppendToTimeline = function(self, items)
  local entry = items[1]
  if entry ~= nil and entry.mediaType == nil then
    items = {
      {
        mediaPoolItem = entry.mediaPoolItem,
        startFrame = entry.startFrame,
        endFrame = entry.endFrame,
        trackIndex = entry.trackIndex,
        recordFrame = entry.recordFrame,
        mediaType = 1
      }
    }
  end
  return baseAppendToTimeline(self, items)
end
local droppedAudio, droppedAudioFailure = context.createTimelineFromRanges({
  name = "Dropped Audio",
  segments = {
    { mediaId = "clip-id-1", startFrame = 0, endFrameExclusive = 10, trackIndex = 1, recordFrame = 0, includeAudio = true }
  }
})
check(droppedAudioFailure ~= nil and droppedAudioFailure.code == "AUDIO_APPEND_FAILED", "silently dropped linked audio fails closed")
check(droppedAudio.partial == true and droppedAudio.audioItems == 0, "dropped audio reports partial state")
managedPool.AppendToTimeline = baseAppendToTimeline

local stuckTimeline = makeManagedTimeline("Stuck Tracks")
stuckTimeline.AddTrack = function() return true end
stuckTimeline.GetTrackCount = function(_, kind)
  if kind == "subtitle" then return 0 end
  return 1
end
managedPool.CreateEmptyTimeline = function(_, name)
  timelineItems = { __flags = 4194304 }
  managedTimelines[#managedTimelines + 1] = stuckTimeline
  managedCurrentProject._currentTimeline = stuckTimeline
  stuckTimeline.name = name
  return stuckTimeline
end
local stuckRanges, stuckFailure = context.createTimelineFromRanges({
  name = "Stuck Tracks",
  segments = {
    { mediaId = "clip-id-1", startFrame = 0, endFrameExclusive = 10, trackIndex = 2, recordFrame = 0 }
  }
})
check(stuckFailure ~= nil and stuckFailure.code == "TRACK_CREATE_FAILED", "soft AddTrack without track growth fails closed")
check(stuckRanges.created == true, "stuck track timeline still created before failure")

managedPool.CreateEmptyTimeline = function(_, name)
  local offsetTimeline = makeManagedTimeline(name)
  offsetTimeline.GetStartFrame = function() return 216000 end
  timelineItems = { __flags = 4194304 }
  managedTimelines[#managedTimelines + 1] = offsetTimeline
  managedCurrentProject._currentTimeline = offsetTimeline
  return offsetTimeline
end
local offsetRanges, offsetFailure = context.createTimelineFromRanges({
  name = "Offset Timeline",
  segments = {
    { mediaId = "clip-id-1", startFrame = 10, endFrameExclusive = 34, trackIndex = 1, recordFrame = 0 },
    { mediaId = "media-id-1", startFrame = 5, endFrameExclusive = 25, trackIndex = 1, recordFrame = 24 }
  }
})
check(offsetFailure == nil, "offset timeline accepts ranges")
check(offsetRanges.timelineStartFrame == 216000, "timeline start frame reported")
check(timelineItems[1].GetStart() == 216000, "record frame offset by timeline start")
check(timelineItems[2].GetStart() == 216024, "second record frame offset by timeline start")

managedPool.CreateEmptyTimeline = function(_, name)
  local created = makeManagedTimeline(name)
  timelineItems = { __flags = 4194304 }
  managedTimelines[#managedTimelines + 1] = created
  managedCurrentProject._currentTimeline = created
  return created
end

local badRange, badRangeFailure = context.appendRanges({
  segments = { { mediaId = "clip-id-1", startFrame = 10, endFrameExclusive = 10 } }
})
check(badRangeFailure ~= nil and badRangeFailure.code == "INVALID_SOURCE_RANGE", "inverted source range rejected")

local missingRange, missingRangeFailure = context.appendRanges({
  segments = { { mediaId = "no-such-clip", startFrame = 0, endFrameExclusive = 10 } }
})
check(missingRangeFailure ~= nil and missingRangeFailure.code == "TIMELINE_CLIP_NOT_FOUND", "missing range clip rejected")

local propertyTimeline, propertyTimelineFailure = context.createTimeline({
  name = "Property Reel",
  mediaIds = { "clip-id-1", "media-id-1" }
})
check(propertyTimelineFailure == nil and #timelineItems == 2, "reset timeline for property tests")

local setPropertyResult, setPropertyFailure = context.setItemProperty({
  target = { trackType = "video", trackIndex = 1, itemIndex = 1 },
  properties = { Color = "Blue" }
})
check(setPropertyFailure == nil and setPropertyResult.applied[1].key == "Color", "set timeline item property")
check(setPropertyResult.applied[1].applied == true, "property applied flag")

local clipColorResult, clipColorFailure = context.setItemProperty({
  target = { trackType = "video", trackIndex = 1, itemIndex = 1 },
  properties = { ["Clip Color"] = "Blue" }
})
check(clipColorFailure == nil and clipColorResult.applied[1].key == "Clip Color", "set clip color")
check(clipColorResult.applied[1].applied == true, "clip color applied flag")

local unsupportedNameResult, unsupportedNameFailure = context.setItemProperty({
  target = { trackType = "video", trackIndex = 1, itemIndex = 1 },
  properties = { Name = "New name" }
})
check(unsupportedNameFailure ~= nil and unsupportedNameFailure.code == "PROPERTY_SET_FAILED", "failed property call returns failure")
check(unsupportedNameResult.applied[1].applied == false, "failed property call is marked unapplied")

local deletedClips, deleteFailure = context.deleteClips({
  targets = { { trackType = "video", trackIndex = 1, itemIndices = { 2 } } }
})
check(deleteFailure == nil and deletedClips.deleted.count == 1, "delete timeline clips")
check(#timelineItems == 1, "timeline has one item after delete")

local missingItem, missingItemFailure = context.deleteClips({
  targets = { { trackType = "video", trackIndex = 1, itemIndices = { 9 } } }
})
check(missingItem ~= nil and missingItemFailure.code == "TIMELINE_ITEM_NOT_FOUND", "missing timeline item rejected")

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
