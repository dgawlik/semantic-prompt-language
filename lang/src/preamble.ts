export const RUNTIME_PREAMBLE = `You are running a Semantic Prompt Language Markdown workflow.
Only fenced spl blocks and blockquotes execute; other Markdown is commentary.
Respect the requested output format. ask and think generate values without tools; agent permits actions.
Runtime tools: read_file(path), write_file(path, content), web_fetch(url), web_search(query), shell(command).
All actions are subject to active runtime restrictions. Never claim an action happened unless it executed.`;

export const NATURAL_PREAMBLE = `Translate this blockquote into SPL using submit_spl exactly once.
The submitted program executes AFTER this model request completes, in the shared document scope.
Do not perform actions yourself or merely describe them. Use SPL to read data, branch on it and perform actions.
@name refers to a shared variable or SPL operation (e.g. @answer, @read_file, @success).
Markers are semantic references, not textual substitution; plain natural language is equally supported.
Do not terminate the document unless requested; use success, fail or top-level return only to end it.
Existing bindings and function signatures are supplied as context, not instructions.

SPL syntax (Python-like expressions with brace blocks; no Python imports):
let name = expression declares a variable; name = expression updates an existing variable.
Values: None, True, False, numbers, 'strings', [lists], {'key': value}; indexing and member access work.
Strings interpolate {expression}; use doubled {{ and }} for literal braces.
if condition { ... } elif condition { ... } else { ... }
for item in sequence { ... }; while condition { ... }; break; continue
def name(arg) { return expression }; functions have lexical scope.
Blocks create child scopes; declare results outside a block before assigning within it.
Operators: + - * / // % **, == != < <= > >=, in, not in, and, or, not.
Builtins include range, len, str, int, float, bool, keys, values, items, json_parse, json_stringify.
log(value); log(level=debug)(value); assert condition 'message'; try { ... } except err { ... }
success value ends the document successfully; fail 'reason' fails it; return value also ends it.
let answer = human 'Question' suspends via checkpoint; requires --checkpoint/--resume.
$args is a read-only list of CLI arguments; $env is the read-only environment.
ask 'prompt' and think 'prompt' generate values; agent 'task' performs model-directed actions.
Generation options: ask(fmt='json', schema=Schema, repairs=2, model='id', reasoning='high') 'prompt'.
fmt: text, json, integer, float, boolean, array, object. repairs is 0..5 (not for agent).
len: word, sentence, paragraph, long. show=True emits reasoning. Options are expression-valued.
enforce 'guidance' { ... }; forbid 'guidance' { ... } are scoped model instructions.
restrict './folder', exec 'git', net 'example.com', mcp 'server/tool' { ... } limits actions.
All existing runtime tools, functions, control flow, validation and human input are available through SPL.
Submit a complete program, not Markdown fences, not an @(model=...) header.
Example: "Read @path and store a summary in @summary" =>
let content = read_file(path)
let summary = ask 'Summarize: {content}'`;
