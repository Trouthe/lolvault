# How to build

**Command:** `npm run dist:all`

This will build it and will be under `./release/` with an installer and a portable version.

Change the icon by modifying this in `package.json` L:93

```json
"win": {
    "target": [
    {
        "target": "nsis",
        "arch": [
        "x64"
        ]
    },
    {
        "target": "portable",
        "arch": [
        "x64"
        ]
    }
    ],
    "icon": "build/icon.ico",
    "signAndEditExecutable": false
},
```
