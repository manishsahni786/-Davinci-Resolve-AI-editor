param(
  [string]$ItemName = "AI Video Editor Bridge",
  [int]$ExpandDelayMs = 150
)

$ErrorActionPreference = "Stop"

function Write-Result($value) {
  $value | ConvertTo-Json -Compress -Depth 6
}

function Find-ByControlType($parent, $controlType) {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    $controlType
  )
  return $parent.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
}

function Find-ByName($parent, $name) {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $name
  )
  return $parent.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes

  $resolveProcess = Get-Process Resolve -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $resolveProcess) {
    Write-Result @{ ok = $false; code = "RESOLVE_NOT_RUNNING"; message = "DaVinci Resolve is not running." }
    exit 3
  }

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $processCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
    $resolveProcess.Id
  )
  $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $processCondition)

  $mainWindow = $null
  $menuBar = $null
  foreach ($candidate in $windows) {
    if ($candidate.Current.ControlType -ne [System.Windows.Automation.ControlType]::Window) {
      continue
    }
    $bar = Find-ByControlType $candidate ([System.Windows.Automation.ControlType]::MenuBar)
    if ($bar) {
      $mainWindow = $candidate
      $menuBar = $bar
      break
    }
  }

  if (-not $mainWindow -or -not $menuBar) {
    Write-Result @{ ok = $false; code = "WINDOW_NOT_FOUND"; message = "Resolve window or menu bar was not found." }
    exit 4
  }

  try {
    $windowPattern = $mainWindow.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
    if ($windowPattern.Current.WindowVisualState -eq [System.Windows.Automation.WindowVisualState]::Minimized) {
      $windowPattern.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal)
      Start-Sleep -Milliseconds 200
    }
  } catch {
  }

  $workspaceCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    "Workspace"
  )
  $workspace = $menuBar.FindFirst([System.Windows.Automation.TreeScope]::Children, $workspaceCondition)
  if (-not $workspace) {
    Write-Result @{ ok = $false; code = "WORKSPACE_MENU_NOT_FOUND"; message = "The Workspace menu was not found." }
    exit 5
  }

  $workspacePattern = $workspace.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  $workspacePattern.Expand()
  Start-Sleep -Milliseconds $ExpandDelayMs

  $scripts = Find-ByName $workspace "Scripts"
  if (-not $scripts) {
    try { $workspacePattern.Collapse() } catch {}
    Write-Result @{ ok = $false; code = "SCRIPTS_MENU_NOT_FOUND"; message = "The Scripts submenu was not found." }
    exit 6
  }

  $scriptsPattern = $scripts.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  $scriptsPattern.Expand()
  Start-Sleep -Milliseconds ($ExpandDelayMs + 100)

  $itemCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $ItemName
  )
  $item = $scripts.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $itemCondition)

  if (-not $item) {
    $folder = Find-ByName $scripts "AI Video Editor"
    if ($folder) {
      try {
        $folder.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
        Start-Sleep -Milliseconds ($ExpandDelayMs + 100)
        $item = $scripts.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $itemCondition)
      } catch {
      }
    }
  }

  if (-not $item) {
    try { $workspacePattern.Collapse() } catch {}
    Write-Result @{ ok = $false; code = "SCRIPT_ITEM_NOT_FOUND"; message = "Script item '$ItemName' was not found." }
    exit 7
  }

  $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Start-Sleep -Milliseconds 100
  try { $workspacePattern.Collapse() } catch {}

  Write-Result @{ ok = $true; item = $ItemName; resolvePid = $resolveProcess.Id }
  exit 0
} catch {
  Write-Result @{ ok = $false; code = "TRIGGER_ERROR"; message = $_.Exception.Message }
  exit 2
}
