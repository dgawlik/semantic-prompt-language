import { Marked } from 'marked';
import { documentMarkdown } from '../lang/dist/doc.js';
import fs from 'node:fs';
import path from 'node:path';
const dir = 'lang/examples';
for (const name of fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(n => n.endsWith('.spl'))) {
  const md = documentMarkdown(fs.readFileSync(path.join(dir, name), 'utf8'), { demote: 2 });
  const parser = new Marked({ gfm: true });
  let html = [];
  parser.use({ renderer: { html(token) { html.push(token.text); return ''; } } });
  parser.parse(md);
  if (html.length) console.log(name, JSON.stringify(html));
}
console.log('done');
