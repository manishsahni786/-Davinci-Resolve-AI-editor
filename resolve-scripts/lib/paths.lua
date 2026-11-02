-- Path, config and atomic-write helpers shared by the Resolve Lua scripts.

local paths = {}
local rootOverride = nil

function paths.setRoot(directory)
  if type(directory) == "string" and directory ~= "" then
    rootOverride = directory:gsub("[\\/]+$", "")
  end
end

local function directoryOf(file)
  local path = file:match("^@(.*)$") or file
  return path:match("^(.*)[\\/][^\\/]+$") or "."
end

function paths.libDir()
  if rootOverride then
    return rootOverride .. "\\lib"
  end
  local explicit = AIVE_SCRIPT_DIR
  if type(explicit) == "string" and explicit ~= "" then
    return explicit:gsub("[\\/]+$", "") .. "\\lib"
  end
  if type(debug) == "table" and type(debug.getinfo) == "function" then
    return directoryOf(debug.getinfo(1, "S").source or "")
  end
  return "."
end

function paths.rootDir()
  if rootOverride then
    return rootOverride
  end
  local explicit = AIVE_SCRIPT_DIR
  if type(explicit) == "string" and explicit ~= "" then
    return explicit:gsub("[\\/]+$", "")
  end
  local lib = paths.libDir()
  return lib:match("^(.*)[\\/][^\\/]+$") or "."
end

function paths.join(directory, name)
  local base = directory:gsub("[\\/]+$", "")
  return base .. "\\" .. name
end

-- Resolve Free sandboxes internal Lua: io is nil. Prefer bmd.fileexists, then
-- loadfile (which still works inside Resolve), and only fall back to io in an
-- external interpreter such as fuscript.
function paths.fileExists(target)
  if type(bmd) == "table" and type(bmd.fileexists) == "function" then
    local ok, exists = pcall(bmd.fileexists, target)
    if ok then
      return exists == true
    end
  end
  if type(io) == "table" and type(io.open) == "function" then
    local handle = io.open(target, "rb")
    if handle then
      handle:close()
      return true
    end
    return false
  end
  local chunk = loadfile(target)
  return chunk ~= nil
end

function paths.readAll(target)
  if type(io) ~= "table" or type(io.open) ~= "function" then
    return nil, "file reads are blocked by the Resolve Free Lua sandbox"
  end
  local handle, errorMessage = io.open(target, "rb")
  if not handle then
    return nil, errorMessage
  end
  local content = handle:read("*a")
  handle:close()
  return content
end

function paths.writeAll(target, content)
  if type(io) ~= "table" or type(io.open) ~= "function" then
    return nil, "file writes are blocked by the Resolve Free Lua sandbox"
  end
  local handle, errorMessage = io.open(target, "wb")
  if not handle then
    return nil, errorMessage
  end
  local ok, writeError = handle:write(content)
  handle:flush()
  handle:close()
  if not ok then
    return nil, writeError
  end
  return true
end

-- Only usable from an external interpreter. Internal Resolve scripts return
-- their response through Fusion preferences instead.
function paths.writeAtomic(target, content)
  local temporary = target .. ".tmp"
  local ok, errorMessage = paths.writeAll(temporary, content)
  if not ok then
    return nil, errorMessage
  end
  os.remove(target)
  local renamed, renameError = os.rename(temporary, target)
  if not renamed then
    local fallbackOk, fallbackError = paths.writeAll(target, content)
    os.remove(temporary)
    if not fallbackOk then
      return nil, renameError or fallbackError
    end
  end
  return true
end

function paths.directoryExists(directory)
  if type(bmd) == "table" and type(bmd.fileexists) == "function" then
    local ok, exists = pcall(bmd.fileexists, directory)
    if ok then
      return exists == true
    end
  end
  if type(io) == "table" and type(io.open) == "function" then
    local handle = io.open(directory .. "\\.write-probe-" .. tostring(os.time()), "wb")
    if not handle then
      return false
    end
    handle:close()
    os.remove(directory .. "\\.write-probe-" .. tostring(os.time()))
    return true
  end
  return false
end

function paths.canWriteDirectory(directory)
  return paths.directoryExists(directory)
end

function paths.utcNow()
  return os.date("!%Y-%m-%dT%H:%M:%SZ")
end

function paths.appendLog(logDirectory, message)
  if type(io) ~= "table" or type(io.open) ~= "function" then
    return false
  end
  local ok = paths.directoryExists(logDirectory)
  if not ok then
    return false
  end
  local target = paths.join(logDirectory, "resolve-bridge.log")
  local handle = io.open(target, "ab")
  if not handle then
    return false
  end
  handle:write(message .. "\n")
  handle:flush()
  handle:close()
  return true
end

function paths.loadConfig()
  local root = paths.rootDir()
  local candidate = paths.join(root, "bridge_config.lua")
  local chunk, loadError = loadfile(candidate)
  if chunk then
    local ok, config = pcall(chunk)
    if not ok then
      return nil, "bridge_config.lua failed to load: " .. tostring(config)
    end
    if type(config) ~= "table" then
      return nil, "bridge_config.lua must return a table"
    end
    return config
  end
  if loadError and not loadError:match("No such file") and not loadError:match("cannot open") then
    return nil, "bridge_config.lua could not be loaded: " .. tostring(loadError)
  end

  local dataRoot = os.getenv("AVE_DATA_DIR")
  local logRoot = os.getenv("AVE_LOG_DIR")
  if dataRoot and logRoot then
    return {
      projectRoot = os.getenv("AVE_PROJECT_ROOT") or root,
      dataDir = dataRoot,
      bridgeRoot = dataRoot,
      requestsDir = dataRoot .. "\\requests",
      responsesDir = dataRoot .. "\\responses",
      archiveDir = dataRoot .. "\\requests\\archive",
      logsDir = logRoot,
      protocolVersion = "1.0",
      source = "environment"
    }
  end

  return nil, "bridge_config.lua not found next to the script. Run: npm run resolve:install-scripts"
end

function paths.validateConfig(config)
  local required = { "requestsDir", "responsesDir", "archiveDir", "logsDir" }
  for _, key in ipairs(required) do
    if type(config[key]) ~= "string" or config[key] == "" then
      return nil, "bridge_config.lua is missing required key: " .. key
    end
  end
  return true
end

return paths
