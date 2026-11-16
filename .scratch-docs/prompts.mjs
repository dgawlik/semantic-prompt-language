import { run, Logger } from '../lang/dist/index.js';
const source = `---
model: gpt-6-luna
enforce: Be concise.
---

const Card = Struct('Card', { term: Str, score: Int.describe('1 to 5') });
const notes = ['a', 'b'];
function fib(n: number): number { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

---
outputVar: card
outputType: Card
forbid: guessing

Make a card from @notes using @fib and @Card for @env.NOPE and @args
---

---
mode: agent
restrict: { fs: ./out }

Call @fib with 10 ->[Int] @fib10 and describe @notes -> @text
---

const plain = await ask('Rate it', { fmt: 'integer', len: 'word' });
success({ card, fib10, text, plain });
`;
let n = 0;
const backend = {
  async call(request) {
    n++;
    console.log(`===== request ${n} kind=${request.kind} model=${request.model} reasoning=${request.reasoningEffort} tools=${request.runtimeTools?.map(t => t.name).join(',')}`);
    console.log(request.prompt);
    if (request.runtimeTools) {
      console.log('call ->', JSON.stringify(await request.invokeAction({ name: 'callFunction', arguments: { name: 'fib', args: [10] } })));
      console.log('bad save ->', JSON.stringify(await request.invokeAction({ name: 'saveVariable', arguments: { name: 'fib10', value: 'fifty-five' } })));
      console.log('save ->', JSON.stringify(await request.invokeAction({ name: 'saveVariable', arguments: { name: 'fib10', value: '55' } })));
      console.log('load ->', JSON.stringify(await request.invokeAction({ name: 'loadVariable', arguments: { name: 'notes' } })));
      await request.invokeAction({ name: 'saveVariable', arguments: { name: 'text', value: { any: 'json' } } });
      return { text: 'Done.', effective: {} };
    }
    return { text: n === 1 ? '```json\n{"term":"a","score":"4"}\n```' : '3', effective: {} };
  },
  async close() {},
};
const result = await run(source, { backend, logger: new Logger('silent'), args: ['x'] });
console.log(JSON.stringify(result));
