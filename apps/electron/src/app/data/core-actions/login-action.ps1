param(
    [Parameter(Mandatory = $true)][string]$nircmd,
    [Parameter(Mandatory = $true)][string]$windowTitle,
    [Parameter(Mandatory = $true)][string]$username,
    [Parameter(Mandatory = $true)][string]$password,
    [int]$timeoutSeconds = 60,
    [int]$activateRetries = 15,
    [int]$inputRetries = 5
)

# Ensure STA mode for clipboard operations
if ([System.Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') {
    Write-Host "ERROR: Script must run in STA mode (launch PowerShell with -STA).";
    exit 1
}

if (!(Test-Path $nircmd)) {
    Write-Host "ERROR: NirCmd executable not found at $nircmd"
    exit 1
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# Native Windows API for window management and input
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class WinAPI
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr SetFocus(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    public const int SW_RESTORE = 9;
    public const int SW_SHOW = 5;
    public const int SW_SHOWDEFAULT = 10;

    private static List<IntPtr> foundWindows = new List<IntPtr>();
    private static string searchTitle = "";

    public static IntPtr[] FindWindowsByTitle(string title)
    {
        foundWindows.Clear();
        searchTitle = title.ToLower();
        EnumWindows(EnumWindowCallback, IntPtr.Zero);
        return foundWindows.ToArray();
    }

    private static bool EnumWindowCallback(IntPtr hWnd, IntPtr lParam)
    {
        if (!IsWindowVisible(hWnd)) return true;

        int length = GetWindowTextLength(hWnd);
        if (length == 0) return true;

        StringBuilder builder = new StringBuilder(length + 1);
        GetWindowText(hWnd, builder, builder.Capacity);
        string windowTitle = builder.ToString().ToLower();

        if (windowTitle.Contains(searchTitle))
        {
            foundWindows.Add(hWnd);
        }
        return true;
    }

    public static bool ForceForeground(IntPtr hWnd)
    {
        IntPtr foregroundWnd = GetForegroundWindow();
        uint unusedPid;
        uint foregroundThread = GetWindowThreadProcessId(foregroundWnd, out unusedPid);
        uint currentThread = GetCurrentThreadId();
        uint targetThread = GetWindowThreadProcessId(hWnd, out unusedPid);

        bool attached = false;
        try
        {
            if (foregroundThread != currentThread)
            {
                AttachThreadInput(currentThread, foregroundThread, true);
                attached = true;
            }

            if (IsIconic(hWnd))
            {
                ShowWindow(hWnd, SW_RESTORE);
            }

            BringWindowToTop(hWnd);
            SetForegroundWindow(hWnd);

            // Also attach to target if different
            if (targetThread != currentThread && targetThread != foregroundThread)
            {
                AttachThreadInput(currentThread, targetThread, true);
                SetFocus(hWnd);
                AttachThreadInput(currentThread, targetThread, false);
            }
        }
        finally
        {
            if (attached)
            {
                AttachThreadInput(currentThread, foregroundThread, false);
            }
        }

        return GetForegroundWindow() == hWnd;
    }
}
"@

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "HH:mm:ss.fff"
    Write-Host "[$timestamp] $Message"
}

function Find-RiotClientWindow {
    param([string]$Title, [int]$TimeoutMs)

    Write-Log "Searching for window containing '$Title'..."
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    
    while ($watch.ElapsedMilliseconds -lt $TimeoutMs) {
        $handles = [WinAPI]::FindWindowsByTitle($Title)
        if ($handles.Count -gt 0) {
            Write-Log "Found $($handles.Count) matching window(s)"
            return $handles[0]
        }
        Start-Sleep -Milliseconds 500
    }
    return [IntPtr]::Zero
}

function Get-WindowTitle {
    param([IntPtr]$Handle)
    $length = [WinAPI]::GetWindowTextLength($Handle)
    if ($length -eq 0) { return "" }
    $builder = New-Object System.Text.StringBuilder ($length + 1)
    [WinAPI]::GetWindowText($Handle, $builder, $builder.Capacity) | Out-Null
    return $builder.ToString()
}

function Force-WindowFocus {
    param([IntPtr]$Handle, [int]$Retries)

    $title = Get-WindowTitle -Handle $Handle
    Write-Log "Attempting to focus window: $title"

    for ($i = 0; $i -lt $Retries; $i++) {
        # Method 1: Use WinAPI force foreground
        if ([WinAPI]::ForceForeground($Handle)) {
            Start-Sleep -Milliseconds 200
            if ([WinAPI]::GetForegroundWindow() -eq $Handle) {
                Write-Log "Window focused successfully (attempt $($i+1))"
                return $true
            }
        }

        # Method 2: Use nircmd as fallback
        & "$nircmd" win activate handle $Handle 2>$null
        Start-Sleep -Milliseconds 200
        
        if ([WinAPI]::GetForegroundWindow() -eq $Handle) {
            Write-Log "Window focused via nircmd (attempt $($i+1))"
            return $true
        }

        Start-Sleep -Milliseconds 300
    }
    return $false
}

function Verify-CorrectWindowFocused {
    param([IntPtr]$ExpectedHandle)
    
    $currentFocus = [WinAPI]::GetForegroundWindow()
    return $currentFocus -eq $ExpectedHandle
}

function Safe-SendKeys {
    param([IntPtr]$TargetHandle, [string]$Text, [int]$Retries)

    for ($attempt = 0; $attempt -lt $Retries; $attempt++) {
        # CRITICAL: Verify the correct window is focused BEFORE sending any input
        if (-not (Verify-CorrectWindowFocused -ExpectedHandle $TargetHandle)) {
            Write-Log "Wrong window focused, re-focusing target window..."
            if (-not (Force-WindowFocus -Handle $TargetHandle -Retries 3)) {
                Write-Log "Failed to focus target window, retrying..."
                Start-Sleep -Milliseconds 500
                continue
            }
            Start-Sleep -Milliseconds 300
        }

        # Double-check focus before sending
        if (-not (Verify-CorrectWindowFocused -ExpectedHandle $TargetHandle)) {
            Write-Log "Window lost focus, aborting this attempt"
            continue
        }

        try {
            # Clear and set clipboard
            [System.Windows.Forms.Clipboard]::Clear()
            Start-Sleep -Milliseconds 50
            [System.Windows.Forms.Clipboard]::SetText($Text)
            Start-Sleep -Milliseconds 100

            # Verify clipboard content
            $clipboardContent = [System.Windows.Forms.Clipboard]::GetText()
            if ($clipboardContent -ne $Text) {
                Write-Log "Clipboard verification failed, retrying..."
                continue
            }

            # Final focus check before paste
            if (-not (Verify-CorrectWindowFocused -ExpectedHandle $TargetHandle)) {
                Write-Log "Lost focus right before paste, aborting"
                continue
            }

            # Send Ctrl+V
            [System.Windows.Forms.SendKeys]::SendWait('^v')
            Start-Sleep -Milliseconds 200

            Write-Log "Text sent successfully (attempt $($attempt+1))"
            return $true
        }
        catch {
            Write-Log "Error sending keys: $_"
            Start-Sleep -Milliseconds 300
        }
    }
    return $false
}

function Safe-SendKey {
    param([IntPtr]$TargetHandle, [string]$Key, [int]$Retries = 3)

    for ($attempt = 0; $attempt -lt $Retries; $attempt++) {
        # Verify focus before sending
        if (-not (Verify-CorrectWindowFocused -ExpectedHandle $TargetHandle)) {
            Write-Log "Wrong window for key '$Key', re-focusing..."
            if (-not (Force-WindowFocus -Handle $TargetHandle -Retries 3)) {
                continue
            }
            Start-Sleep -Milliseconds 200
        }

        if (Verify-CorrectWindowFocused -ExpectedHandle $TargetHandle) {
            [System.Windows.Forms.SendKeys]::SendWait($Key)
            Start-Sleep -Milliseconds 150
            return $true
        }
    }
    return $false
}

# ==================== MAIN EXECUTION ====================

Write-Log "Starting Riot Client login automation"
Write-Log "Looking for window: $windowTitle"

$timeoutMs = $timeoutSeconds * 1000

# Step 1: Find the Riot Client window
$riotHandle = Find-RiotClientWindow -Title $windowTitle -TimeoutMs $timeoutMs
if ($riotHandle -eq [IntPtr]::Zero) {
    Write-Log "ERROR: Timed out waiting for Riot Client window"
    exit 1
}

$foundTitle = Get-WindowTitle -Handle $riotHandle
Write-Log "Found Riot Client window: '$foundTitle' (Handle: $riotHandle)"

# Step 2: Wait a moment for the login form to be ready
Write-Log "Waiting for login form to be ready..."
Start-Sleep -Milliseconds 2000

# Step 3: Force focus to the Riot Client window
Write-Log "Bringing Riot Client to foreground..."
if (-not (Force-WindowFocus -Handle $riotHandle -Retries $activateRetries)) {
    Write-Log "ERROR: Could not focus Riot Client window after $activateRetries attempts"
    exit 1
}

# Extra delay after focus to ensure the window is ready
Start-Sleep -Milliseconds 250

# Step 4: Click on the window to ensure the username field is focused
# First, send a click to ensure we're in the right input field
Write-Log "Ensuring username field is focused..."
if (Verify-CorrectWindowFocused -ExpectedHandle $riotHandle) {
    # Send Tab then Shift+Tab to reset to first field, or just trust the focus
    # Actually, let's send a mouse click via nircmd to the center of the window
    & "$nircmd" win focus handle $riotHandle 2>$null
    Start-Sleep -Milliseconds 300
}

# Step 5: Enter username
Write-Log "Entering username..."
if (-not (Safe-SendKeys -TargetHandle $riotHandle -Text $username -Retries $inputRetries)) {
    Write-Log "ERROR: Failed to enter username"
    [System.Windows.Forms.Clipboard]::Clear()
    exit 1
}

# Step 6: Tab to password field
Write-Log "Tabbing to password field..."
if (-not (Safe-SendKey -TargetHandle $riotHandle -Key '{TAB}' -Retries $inputRetries)) {
    Write-Log "ERROR: Failed to send TAB key"
    [System.Windows.Forms.Clipboard]::Clear()
    exit 1
}

Start-Sleep -Milliseconds 100

# Step 7: Enter password
Write-Log "Entering password..."
if (-not (Safe-SendKeys -TargetHandle $riotHandle -Text $password -Retries $inputRetries)) {
    Write-Log "ERROR: Failed to enter password"
    [System.Windows.Forms.Clipboard]::Clear()
    exit 1
}

# Step 8: Press Enter to submit
Write-Log "Submitting login..."
if (-not (Safe-SendKey -TargetHandle $riotHandle -Key '{ENTER}' -Retries $inputRetries)) {
    Write-Log "ERROR: Failed to send ENTER key"
    [System.Windows.Forms.Clipboard]::Clear()
    exit 1
}

# Step 9: Clear clipboard for security
[System.Windows.Forms.Clipboard]::Clear()
Write-Log "Login automation completed successfully!"