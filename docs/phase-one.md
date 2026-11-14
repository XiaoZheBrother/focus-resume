# Phase 1 scope

Focus Resume v0.1 targets a complete local desktop workflow for general tasks and document reading. Windows 11 x64 is the stable release target. A macOS arm64 DMG is planned for v0.1.1 after native verification, signing, and notarization.

| Phase 1 module | Included in the alpha implementation |
| --- | --- |
| First launch | Start or continue directly, with no account or model setup. |
| Tasks and sessions | Create, pause, resume, rest, end, complete, archive, or reopen. One unfinished work session. |
| Reading | Managed PDF, Markdown, and UTF-8 TXT copies. Reading begins explicitly. Restore position, adjust text display, and save notes. |
| Resume cards | Goal, progress, next action, blockers, and original document position. |
| Distraction capture | Per-session thoughts. Review, mark handled, or turn a thought into a task. |
| Desktop | Main window, tray, compact panel, global shortcut, sleep and lock hooks, and opt-in notifications. |
| History and data | Session outcomes and durations, local SQLite backup and replacement, and managed copy deletion. |
| AI | Explicit selected-text explanation and next-action suggestions with a preview and cancellation. |
| Open-source delivery | MIT source, lockfile, build and check commands, GitHub Actions, and manual update check. |

## Validation

The alpha label keeps Windows native acceptance and the small user pilot visible before a stable release. The working-state checkpoint is scheduled every 2.5 seconds. The 10-second crash-loss target is a test objective.

| PRD check | Verification route |
| --- | --- |
| AC01–03 Offline tasks, multiple sessions, and safe switching | Core tests and Electron desktop smoke |
| AC04–06 Tray, lock, suspend, and interrupted-process recovery | Electron crash/restart smoke, then native Windows tray, lock, and sleep checks |
| AC07–09 Import, recovery, and distraction capture | Electron smoke, followed by large, password-protected, scanned, and Chinese document samples |
| AC10–11 AI actions, error handling, and target binding | Adapter tests and Electron smoke with a mock endpoint. Live DeepSeek verification requires a user-provided experimental credential. |
| AC12–13 Backups, version protection, and multiple instances | SQLite regression tests and native Windows checks |
| AC14–15 Accessibility, installation, update, and retained data | Native Windows testing, including keyboard and light/dark modes, plus a small user pilot |

## Roadmap

- **v0.1 stable** — Validate a real Windows installer, tray, sleep, second instance, update, and persisted data. Resolve blocking defects, then run a small usability pilot for offline tasks, reading, and interruption recovery.
- **v0.1.1** — Verify macOS arm64 independently and publish a signed, notarized DMG.
- **v0.2 work in v0.3** — Capture thoughts without a running session, manage them from the inbox, and open the current or recent resume card from the compact panel or tray. Browser site blocking remains a candidate if usage establishes a recurring problem.
- **v0.3** — Reading and study. Create an offline study card from a document, attempt recall before revealing its answer, rate the result, and reopen the source. Review history records each self-rating. It supports measuring study activity and recall during a trial.
- **Conditional** — Consider a DSH plugin for document and task handoff when DSH users need it. Consider the DSH SDK when a concrete feature requires multi-step tool execution. Evaluate web access, sync, OCR, and quiet co-working against actual demand.

### v0.3 acceptance

- Saving a thought without a running timer creates an inbox item. Finishing or switching the source session while capturing preserves the association with the original session.
- Creating or reviewing a card leaves session timing unchanged. A new card is due immediately. Forgot schedules it in 10 minutes, partial recall in one day, and successful recall advances through 1, 3, 7, 14, and 30 days.
- The review screen hides the reference answer until the reader reveals it. Each attempt stores its time and rating once. Returning to the source opens the linked document at its anchor.
- v0.1 data and backup archives remain readable. The first upgrade keeps a database copy before migrating. A restore of a v0.3 backup retains cards, review history, and inbox entries.
- Preview binaries require actual Windows and macOS validation before stable certification. macOS public distribution with Developer ID signing and notarization requires the project’s Apple credentials.
