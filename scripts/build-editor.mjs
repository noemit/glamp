import { build } from 'esbuild';
import { statSync } from 'node:fs';

await build({
  entryPoints: ['src/editor.mjs'],
  outfile: 'public/vendor/editor.js',
  bundle: true,
  format: 'esm',
  minify: true,
  sourcemap: false,
  target: ['es2022'],
  logLevel: 'info',
});

const bytes = statSync('public/vendor/editor.js').size;
console.log(`Built public/vendor/editor.js (${(bytes / 1024).toFixed(1)} KiB)`);
