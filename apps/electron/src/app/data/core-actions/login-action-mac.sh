#!/bin/bash
# login-action-mac.sh
# macOS equivalent of login-action.ps1 for Riot Client auto-login
# Uses AppleScript (System Events) for UI automation
#
# Requires: Accessibility permissions for the terminal/app running this script
# System Preferences > Privacy & Security > Accessibility

# Parse named arguments (same style as the PowerShell script)
TIMEOUT_SECONDS=60
ACTIVATE_RETRIES=15

while [[ $# -gt 0 ]]; do
  case "$1" in
    -windowTitle) WINDOW_TITLE="$2"; shift 2;;
    -username) USERNAME="$2"; shift 2;;
    -password) PASSWORD="$2"; shift 2;;
    -timeoutSeconds) TIMEOUT_SECONDS="$2"; shift 2;;
    -activateRetries) ACTIVATE_RETRIES="$2"; shift 2;;
    *) shift;;
  esac
done

if [ -z "$USERNAME" ] || [ -z "$PASSWORD" ]; then
  echo "ERROR: -username and -password are required"
  exit 1
fi

WINDOW_TITLE="${WINDOW_TITLE:-Riot Client}"

echo "Waiting for '$WINDOW_TITLE' window (timeout: ${TIMEOUT_SECONDS}s)..."

# Wait for the Riot Client process to appear
ELAPSED=0
PROCESS_NAME=""
while [ $ELAPSED -lt $TIMEOUT_SECONDS ]; do
  # Look for Riot Client process
  PROCESS_NAME=$(osascript -e '
    tell application "System Events"
      set matchedProcs to {}
      repeat with p in (every process whose background only is false)
        if name of p contains "Riot" or name of p contains "RiotClient" then
          return name of p
        end if
      end repeat
      return ""
    end tell
  ' 2>/dev/null)

  if [ -n "$PROCESS_NAME" ] && [ "$PROCESS_NAME" != "" ]; then
    echo "Found process: $PROCESS_NAME"
    break
  fi

  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

if [ -z "$PROCESS_NAME" ] || [ "$PROCESS_NAME" = "" ]; then
  echo "ERROR: Timed out waiting for Riot Client process after ${TIMEOUT_SECONDS}s"
  exit 1
fi

# Wait a bit for the login UI to fully render
echo "Waiting for login UI to load..."
sleep 3

# Activate window and enter credentials via AppleScript
echo "Activating window and entering credentials..."

RETRIES=0
SUCCESS=false

while [ $RETRIES -lt $ACTIVATE_RETRIES ]; do
  RESULT=$(osascript <<APPLESCRIPT
    tell application "System Events"
      try
        set riotProc to first process whose name is "$PROCESS_NAME"
        set frontmost of riotProc to true
        delay 0.5

        -- Verify it's frontmost
        if frontmost of riotProc is false then
          return "not_frontmost"
        end if

        -- Use keyboard shortcut to ensure we start from username field
        -- Tab through to make sure we land in the username field
        -- First, click somewhere neutral, then use Tab navigation
        delay 0.3

        -- Select all in current field and clear it, then type username
        keystroke "a" using command down
        delay 0.1
        keystroke "$USERNAME"
        delay 0.3

        -- Tab to password field
        keystroke tab
        delay 0.2

        -- Type password
        keystroke "$PASSWORD"
        delay 0.3

        -- Press Enter to submit
        keystroke return
        delay 0.2

        return "ok"
      on error errMsg
        return "error: " & errMsg
      end try
    end tell
APPLESCRIPT
  )

  if [ "$RESULT" = "ok" ]; then
    SUCCESS=true
    break
  elif [ "$RESULT" = "not_frontmost" ]; then
    echo "Window not frontmost, retrying... ($((RETRIES + 1))/$ACTIVATE_RETRIES)"
    sleep 1
  else
    echo "AppleScript error: $RESULT"
    sleep 1
  fi

  RETRIES=$((RETRIES + 1))
done

if [ "$SUCCESS" = true ]; then
  echo "Credentials entered successfully"
  exit 0
else
  echo "ERROR: Failed to enter credentials after $ACTIVATE_RETRIES attempts"
  exit 1
fi
