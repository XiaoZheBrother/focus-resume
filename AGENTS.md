# Working on Focus Resume

Focus Resume is a local-first Electron focus timer, document reader, and interruption recovery app. Read [phase-one.md](docs/phase-one.md) for the current scope and platform release checks.

## Commands

- `npm ci` installs locked dependencies on Node.js 24.
- `npm run typecheck`, `npm test`, and `npm run build` verify source changes.
- `npm run test:desktop` exercises the packaged renderer and Electron IPC with a graphical session.
- `npm run package:win` builds an x64 NSIS installer on Windows.

## Invariants

- The main process owns state and applies validated, transactional commands. Keep a single unfinished session, and require the caller's expected session ID for switching tasks.
- End a session independently of completing the task. Preserve historical goal snapshots and exclude paused time from work totals.
- Opening a document does not start work. Persist managed file bytes and metadata together. Keep renderer navigation and file access within the preload bridge.
- Keep desktop data usable offline. Model calls require explicit submission and carry only the reviewed payload. Associate results with their original object. Use temporary credentials and mock servers for tests.
- Verify a backup before replacement, preserve the previous dataset, and keep credentials outside the backup.
- Document which platforms and release checks were verified. Mark unvalidated builds as previews.
