# Focus Resume

**Focus Resume** is an open-source, local-first Electron desktop focus app for starting tasks, reading PDF / Markdown / TXT, and recovering your place after an interruption. It combines a focus timer, work-session history, resume cards, an offline distraction inbox, spaced-repetition study cards, and optional DeepSeek / OpenAI-compatible AI.

**Focus Resume** 是一个本地优先的开源专注工具。用一句话开始任务，阅读 PDF、Markdown 或 TXT，暂停后通过继续卡片找到原文位置、当前进度和下一步。把页或段落制成复习卡，按自己的回忆结果安排下次复习。

[Downloads / 下载](https://github.com/XiaoZheBrother/focus-resume/releases) · [Build and test](#build-and-test) · [Repository map](#repository-map) · [Phase 1 and roadmap](docs/phase-one.md)

## Try one work session

1. On **开始与继续**, create a task like “Compare two designs” and start the focus timer. You can work in any application.
2. Add a goal and a next action to the **继续卡片** (resume card). Capture a distracting thought with the **随手记** button or the configured global shortcut.
3. Pause, take a break, or close the main window to the tray. After restarting, open **继续上次** and continue the saved task.
4. End the session to save its outcome. Mark the task complete separately if the whole task is finished.

For reading, import a file, then select **开始阅读** when ready to start timing. The reader restores PDF pages and Markdown/TXT paragraph positions, and can keep notes tied to the original location.

## What is included

| Capability | Behavior |
| --- | --- |
| Task sessions and focus timer | Free timing or an optional time target. Pause, resume, rest, finish, and review session history. Work time stops on lock, suspend, and exit. |
| Interruption recovery | A resume card keeps the goal, progress, next action, and blockers. A local checkpoint preserves timer progress if the process exits unexpectedly. |
| Document reader | PDF rendering and selectable text via PDF.js, Markdown heading navigation, UTF-8 text, paragraph focus, position restoration, and anchored notes. |
| Reading review and spaced repetition | Turn a page, paragraph, or text selection into a question and answer. Recall before revealing the answer, rate what you remembered, and return to the source. |
| Distraction inbox | Capture a thought with or without a timer running. Review it later, mark it handled, or turn it into a task. |
| Desktop controls | Tray, compact task panel with optional always-on-top, configurable global shortcut, and optional notifications. |
| Local storage and offline backups | SQLite stores tasks and imported file copies. Export a complete `.focusbackup` and restore it on another install. Restore replaces the local dataset after an automatic backup. |
| Optional AI | Explain selected text or suggest one to three next actions. Review and edit the outgoing text, cancel a request, and explicitly adopt a result. |

## Download and platform status

Version **0.3.0** includes the desktop recovery improvements and the reading-study workflow. Windows x64 and macOS Apple Silicon builds use native GitHub runners. See [Releases](https://github.com/XiaoZheBrother/focus-resume/releases) for the available downloads and the verification status for each platform.

Preview builds may lack Windows code signing or Apple Developer ID signing and notarization. The current UI is in Simplified Chinese. v0.1 data and backups are supported, and the application keeps a copy of the original database before upgrading it.

From **阅读工作区**, select text or open a page and choose **制作复习卡**. In **阅读复习**, reveal the answer after attempting recall. Choose an outcome to schedule the next review. Each card links to its original page or paragraph.

## Data and AI

Basic tasks, timers, document reading, and backups work offline without an account, an API key, or DeepSeek Harness. Focus Resume uses a private local SQLite database. Imported files are copied into the application database, and deleting that copy leaves the original file alone.

AI starts disabled. When enabled, it sends the text shown in the preview, plus instructions specific to the selected action, to the endpoint you configured. Use a DeepSeek API key or an OpenAI-compatible Chat Completions endpoint. HTTPS is required for remote endpoints. HTTP is supported on loopback. Credentials use Electron safeStorage with OS-backed encryption when available and are omitted from backups. Keep backup files private if they contain sensitive documents or notes.

The app accepts local PDF files up to 50 MiB and Markdown or UTF-8 TXT up to 2 MiB. PDF OCR and password-protected PDFs are outside this release. Scanned pages can render and save their position. Text explanation needs selectable text. Markdown resources are rendered locally with embedded HTML and remote content disabled.

## Build and test

Use Node.js 24 or newer and npm. Run the desktop application on a machine with a graphical session.

```bash
npm ci
npm start
npm run typecheck
npm test
npm run test:desktop
npm run package:win
```

The Windows x64 packaging command targets a Windows runner. `npm run package:mac` builds an arm64 DMG on macOS for platform validation. The smoke test launches the real Electron app and uses only temporary local data and a mock model. See [Contributing](CONTRIBUTING.md).

## Repository map

| When you need to change | Start here |
| --- | --- |
| Session lifecycle, work/rest timing, task transitions | [src/core.ts](src/core.ts) |
| State schema, command types, settings, format bounds | [src/shared/model.ts](src/shared/model.ts) |
| SQLite snapshots, managed document bytes, backup validation | [src/store.ts](src/store.ts) |
| Desktop lifecycle, IPC, tray, import, and secure storage | [src/main.ts](src/main.ts) and [src/preload.ts](src/preload.ts) |
| Reader, PDF.js, source selection, and notes | [src/renderer/reader.tsx](src/renderer/reader.tsx) |
| Reading review UI and source anchors | [src/renderer/study.tsx](src/renderer/study.tsx) and [src/renderer/reader.tsx](src/renderer/reader.tsx) |
| Tasks, resume cards, history, settings, and desktop panel | [src/renderer/App.tsx](src/renderer/App.tsx) |
| DeepSeek / OpenAI-compatible Chat Completions adapter | [src/ai.ts](src/ai.ts) |
| Agent contributor instructions and verification commands | [AGENTS.md](AGENTS.md) |

Licensed under [MIT](LICENSE). Electron, React, PDF.js, and other dependencies retain their own licenses.
