// Regenerates assets/search-index.js from the headings of every page in this folder.
// Usage: node build-search-index.mjs   (the site itself needs no build step; the index is committed)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.resolve(dir, '..', 'lang', 'examples');
const examples = new Set(fs.readdirSync(examplesDir).filter((file) => file.endsWith('.spl')));
const escapeCode = (source) => source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Keep complete executable examples and the published grammar synchronized with their sources.
for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.html'))) {
  const target = path.join(dir, file);
  const original = fs.readFileSync(target, 'utf8');
  let html = original.replace(/(<code class="language-spl" data-file="([^"]+)">)[\s\S]*?(<\/code>)/g, (block, open, name, close) => {
    const source = name === 'quickstart.spl' ? 'hi.spl' : name;
    if (!examples.has(source)) return block;
    return `${open}\n${escapeCode(fs.readFileSync(path.join(examplesDir, source), 'utf8').trimEnd())}\n${close}`;
  });
  if (file === 'grammar.html') {
    html = html.replace(/(<code class="language-ebnf">)[\s\S]*?(<\/code>)/, (_block, open, close) =>
      `${open}\n${escapeCode(fs.readFileSync(path.resolve(examplesDir, '..', 'docs', 'syntax.ebnf'), 'utf8').trimEnd())}\n${close}`);
  }
  if (html !== original) fs.writeFileSync(target, html);
}

const strip = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, '-')
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const index = [];
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort()) {
  const html = fs.readFileSync(path.join(dir, file), 'utf8');
  const main = /<main id="page">([\s\S]*)<\/main>/.exec(html)?.[1] ?? '';
  const pageTitle = strip(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(main)?.[1] ?? file);
  index.push({ title: pageTitle, page: pageTitle, href: file, level: 1, text: strip(/<p class="lead">([\s\S]*?)<\/p>/.exec(main)?.[1] ?? '') });

  // Each h2/h3 owns the text up to the next heading.
  const parts = main.split(/(?=<h[23][ >])/);
  for (const part of parts) {
    const m = /^<h([23])\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>([\s\S]*)$/.exec(part);
    if (!m) continue;
    const body = m[4].replace(/<pre[\s\S]*?<\/pre>/g, ' ');
    index.push({ title: strip(m[3]), page: pageTitle, href: `${file}#${m[2]}`, level: Number(m[1]), text: strip(body).slice(0, 400) });
  }
}

fs.writeFileSync(path.join(dir, 'assets', 'search-index.js'), `window.SPL_SEARCH_INDEX = ${JSON.stringify(index)};\n`);
console.log(`indexed ${index.length} entries from ${new Set(index.map((e) => e.href.split('#')[0])).size} pages`);
