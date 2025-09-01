param(
    [Parameter(Mandatory=$true)][string]$nircmd,
    [Parameter(Mandatory=$true)][string]$windowTitle,
    [Parameter(Mandatory=$true)][string]$username,
    [Parameter(Mandatory=$true)][string]$password
)

if (!(Test-Path $nircmd)) {
    Write-Host "ERROR: NirCmd executable not found at $nircmd"
    exit 1
}

# Wait for the target window
$windowFound = $false
while (-not $windowFound) {
    $windowFound = (Get-Process | Where-Object { $_.MainWindowTitle -like "*$windowTitle*" }).Count -gt 0
    Start-Sleep -Milliseconds 500
}

# Activate the window
& "$nircmd" win activate process "$windowTitle"
if (-not $?) { 
    & "$nircmd" win activate ititle "$windowTitle"
}
Start-Sleep -Seconds 5

# Send username
& "$nircmd" clipboard set "$username"
& "$nircmd" sendkeypress "ctrl+v"
Start-Sleep -Milliseconds 200

# Send TAB
& "$nircmd" sendkeypress "tab"
Start-Sleep -Milliseconds 200

# Send password
& "$nircmd" clipboard set "$password"
& "$nircmd" sendkeypress "ctrl+v"
Start-Sleep -Milliseconds 200

# Send ENTER
& "$nircmd" sendkeypress "enter"
