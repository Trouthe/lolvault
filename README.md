# LoL Vault Monorepo

This monorepo contains:
- **Electron App** (`apps/electron/`) - Desktop application for League of Legends account management
- **Web App** (`apps/web/`) - Marketing/payment website (Angular)
- **Backend** (`backend/`) - Firebase Cloud Functions

## Project Structure

```
lolvault/
├── apps/
│   ├── electron/        # Electron + Angular desktop app
│   └── web/             # Angular marketing/payment website
├── backend/
│   ├── functions/       # Firebase Cloud Functions
│   ├── firestore.rules
│   └── firebase.json
├── package.json         # Root workspace config
└── tsconfig.base.json   # Shared TypeScript config
```

## Getting Started

### Install Dependencies

```bash
# Install all workspace dependencies
npm install

# Or install each workspace separately
cd apps/electron && npm install
cd apps/web && npm install
cd backend/functions && npm install
```

## Running the Applications

### Electron App (Desktop)

```bash
# Development mode (hot reload)
npm run start:electron:dev

# Build and run
npm run start:electron:prod

# Build for distribution
npm run dist:electron:portable
```

### Web App (Marketing Site)

```bash
# Development mode (runs on port 4300)
npm run start:web:dev

# Production build
npm run build:web:prod
```

### Firebase Functions

```bash
# Build functions
npm run build:functions

# Run local emulators
npm run emulators

# Deploy to Firebase
npm run deploy:functions
```

## Building for Distribution

### Electron App

```bash
# Build portable Windows executable
npm run dist:electron:portable

# Build Windows installer + portable
npm run dist:electron:win
```

Output will be in `apps/electron/release/`

Change the icon by modifying `apps/electron/package.json` under the `build.win.icon` property.

## Notes

- The Electron app runs on port 4200 during development
- The Web app runs on port 4300 during development
- Firebase emulators run on ports 5000 (hosting), 5001 (functions), 8080 (firestore)
