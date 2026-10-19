// Build for the M1.5 GUI. The Electron main process is bundled to CJS
// (every Electron version loads it; 'electron' stays external), and the
// renderer to a self-contained IIFE like the extension bundles. dist/ is
// committed so the app runs without building. Run with: npm run build:gui
import { build } from 'esbuild';

await build({
  entryPoints: ['app/src/main.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: 'app/dist/main.cjs',
  target: 'node22',
  external: ['electron'],
});
console.log('built app/dist/main.cjs');

await build({
  entryPoints: ['app/src/renderer.ts'],
  bundle: true,
  format: 'iife',
  outfile: 'app/dist/renderer.js',
  target: 'chrome120',
});
console.log('built app/dist/renderer.js');
