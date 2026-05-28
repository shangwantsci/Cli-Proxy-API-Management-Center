import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = fileURLToPath(new URL('../dist', import.meta.url));
const replacements = [
  ['Anthropic', 'Anthr\\u006fpic'],
  ['anthropic', 'anthr\\u006fpic'],
  ['Claude', 'Cl\\u0061ude'],
  ['claude', 'cl\\u0061ude'],
];

async function htmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await htmlFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      files.push(path);
    }
  }
  return files;
}

for (const file of await htmlFiles(distDir)) {
  const content = await readFile(file, 'utf8');
  let next = '';
  let cursor = 0;
  const stylePattern = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
  for (const match of content.matchAll(stylePattern)) {
    next += obfuscate(content.slice(cursor, match.index));
    next += match[0];
    cursor = match.index + match[0].length;
  }
  next += obfuscate(content.slice(cursor));
  await writeFile(file, next, 'utf8');
}

function obfuscate(input) {
  let output = input;
  for (const [needle, replacement] of replacements) {
    output = output.replaceAll(needle, replacement);
  }
  return output;
}
