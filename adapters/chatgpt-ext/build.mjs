// Build for the astra adapter (M1.4): MV3 content scripts and the service
// worker cannot use ES modules, so the TS sources are bundled to
// self-contained IIFE scripts under dist/. dist/ is committed so the
// extension loads unpacked without building. Run with: npm run build:ext
// (which type-checks first — m0.2 carry item 4).
import { build } from 'esbuild';

for (const [entry, outfile] of [
  ['adapters/chatgpt-ext/src/content.ts', 'adapters/chatgpt-ext/dist/content.js'],
  ['adapters/chatgpt-ext/src/background.ts', 'adapters/chatgpt-ext/dist/background.js'],
  ['adapters/chatgpt-ext/src/popup.ts', 'adapters/chatgpt-ext/dist/popup.js'],
  ['adapters/chatgpt-ext/src/options.ts', 'adapters/chatgpt-ext/dist/options.js'],
]) {
  await build({ entryPoints: [entry], bundle: true, format: 'iife', outfile, target: 'chrome120' });
  console.log(`built ${outfile}`);
}
