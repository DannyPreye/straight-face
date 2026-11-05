// Bundles the renderer and styles, and injects the API key from .env (or the
// environment). dist/ and .env are gitignored, so the key never reaches the repo.
import { existsSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';

function readEnv(name) {
  if (process.env[name]) return process.env[name].trim();
  if (!existsSync('.env')) return '';
  const line = readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : '';
}

await build({
  entryPoints: ['src/app.js'],
  bundle: true,
  outfile: 'dist/renderer.bundle.js',
  platform: 'browser',
  format: 'iife',
  logLevel: 'warning',
  define: {
    __PRESAGE_API_KEY__: JSON.stringify(readEnv('PRESAGE_API_KEY')),
    __DEBUG__: JSON.stringify(readEnv('STRAIGHT_FACE_LOG') === '1'),
  },
});

await build({
  entryPoints: ['src/app.css'],
  bundle: true,
  outfile: 'dist/app.css',
  loader: { '.woff2': 'file', '.woff': 'file' },
  assetNames: 'fonts/[name]-[hash]',
  logLevel: 'warning',
});
