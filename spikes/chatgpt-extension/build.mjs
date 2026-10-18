// Minimal build for the M0.2 spike: MV3 content scripts cannot use ES modules,
// so the TS sources are bundled to self-contained IIFE scripts under dist/.
// Run with: npm run build:ext
import { build } from 'esbuild';

for (const [entry, outfile] of [
  ['spikes/chatgpt-extension/src/content.ts', 'spikes/chatgpt-extension/dist/content.js'],
  ['spikes/chatgpt-extension/src/popup.ts', 'spikes/chatgpt-extension/dist/popup.js'],
]) {
  await build({ entryPoints: [entry], bundle: true, format: 'iife', outfile, target: 'chrome120' });
  console.log(`built ${outfile}`);
}
