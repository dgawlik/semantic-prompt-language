// One-time helper: replaces lines of the form `<<include lang/examples/hi.spl>>` with the file's text.
import fs from 'node:fs';
for (const file of process.argv.slice(2)) {
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const expanded = text.replace(/^<<include ([^>]+)>>$/gm, (_, name) => fs.readFileSync(name.trim(), 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, ''));
    if (expanded !== text) { fs.writeFileSync(file, expanded); console.log(`expanded ${file}`); }
}
