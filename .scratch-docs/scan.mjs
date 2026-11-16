import { scan } from '../lang/dist/scanner.js';
import fs from 'node:fs';
const s = scan(fs.readFileSync(process.argv[2], 'utf8'));
console.log(s.code.split('\n').map((l, i) => `${String(i + 1).padStart(3)} ${l}`).filter(l => l.trim().length > 3).join('\n'));
console.log(JSON.stringify(s.problems, null, 1));
