import { build } from 'esbuild'
import { cp, mkdir } from 'node:fs/promises'

await mkdir('dist', { recursive: true })
await Promise.all([
  build({
    entryPoints: ['src/main.ts', 'src/preload.ts'],
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', outExtension: { '.js': '.cjs' },
    external: ['electron'], outdir: 'dist'
  }),
  build({
    entryPoints: { app: 'src/renderer/App.tsx' }, bundle: true, platform: 'browser',
    target: 'chrome140', format: 'esm', outdir: 'dist', minify: true,
    loader: { '.svg': 'dataurl', '.gif': 'dataurl' }
  }),
  cp('src/renderer/index.html', 'dist/index.html'),
  cp('src/renderer/tray.png', 'dist/tray.png'),
  cp('node_modules/pdfjs-dist/LICENSE', 'dist/pdfjs-LICENSE'),
  cp('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/pdf.worker.min.mjs'),
  ...['cmaps', 'standard_fonts', 'wasm'].map(dir => cp('node_modules/pdfjs-dist/' + dir, 'dist/' + dir, { recursive: true }))
])
