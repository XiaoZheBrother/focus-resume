# Contributing

Open an issue describing the problem and how to reproduce it. Reading compatibility fixes are easiest to verify with a small public sample or a document you created for the report. Keep API keys, personal backups, and private documents out of reports.

Use Node.js 24 and run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`. Run `npm run test:desktop` for changes to the main/renderer boundary, the reader, or desktop state. See [AGENTS.md](AGENTS.md) for the repository boundaries.

Useful starting points include keyboard navigation, testing more public Chinese PDF samples, and documenting Windows install and update behavior. Keep behavior changes tied to a user flow in the [Phase 1 scope](docs/phase-one.md).
