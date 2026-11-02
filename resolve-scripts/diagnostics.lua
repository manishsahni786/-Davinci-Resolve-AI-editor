-- AI Video Editor Resolve diagnostics.
-- Run from: Workspace > Scripts > Utility > AI Video Editor Diagnostics
-- Resolve Free blocks io, so the report is published through Fusion prefs.
-- Read it from Node with: npm run resolve:diagnostics

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
  print("AI Video Editor diagnostics: " .. tostring(configError))
  return
end

local info = context.collect({ scriptFile = "diagnostics.lua" })
info.bridge = context.health(config, paths)
local encoded = json.encode(info)

if not prefs.available() then
  print("AI Video Editor diagnostics: Fusion preferences are unavailable; cannot publish the report.")
  print(encoded)
  return
end

local published, publishError = prefs.publishDiagnostics(encoded)
if not published then
  print("AI Video Editor diagnostics: could not publish report: " .. tostring(publishError))
  print(encoded)
  return
end

print("AI Video Editor diagnostics published to Fusion preferences.")
print("Run from Node: npm run resolve:diagnostics")
