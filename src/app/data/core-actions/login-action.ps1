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
    Start-Sleep -Milliseconds 10
}

# Focus the window
& "$nircmd" win activate ititle "$windowTitle"
Start-Sleep -Milliseconds 1

# Clear clipboard and send username
& "$nircmd" clipboard clear
& "$nircmd" clipboard set "$username"
& "$nircmd" sendkeypress "ctrl+v"
Start-Sleep -Milliseconds 1

# Tab to password field
& "$nircmd" sendkeypress "tab"
Start-Sleep -Milliseconds 1

# Clear clipboard and send password  
& "$nircmd" clipboard clear
& "$nircmd" clipboard set "$password"
& "$nircmd" sendkeypress "ctrl+v"
Start-Sleep -Milliseconds 1

# Submit
& "$nircmd" sendkeypress "enter"

# Clear clipboard for security
& "$nircmd" clipboard clear