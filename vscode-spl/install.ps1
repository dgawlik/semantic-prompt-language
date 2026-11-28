param(
  [ValidateSet("auto", "all", "vscode", "insiders", "cursor", "antigravity", "windsurf")]
  [string]$Editor = "auto",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeArgs = @((Join-Path $scriptDir "install.mjs"), "--editor", $Editor)
if ($Uninstall) {
  $nodeArgs += "--uninstall"
}

& node @nodeArgs
exit $LASTEXITCODE
