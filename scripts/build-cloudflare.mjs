import { cpSync, mkdirSync, rmSync } from 'node:fs';

const out = 'dist-cloudflare/phase-process';
const files = [
  'index.html',
  'styles.css',
  'phase.js',
  'favicon.png',
  'wav-recorder-worklet.js',
];

rmSync('dist-cloudflare', { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of files) {
  cpSync(file, `${out}/${file}`);
}
console.log(`copied ${files.join(', ')} to ${out}/`);
