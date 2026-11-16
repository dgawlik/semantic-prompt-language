# API reference

Everything a workflow can use on one page: the file format, every header key, the errors the
scanner reports, every library global with its signature and options, the type builder, the
agent tools and the failure codes.

## File format

A workflow is a `.spl` file: TypeScript with Markdown comments and blocks.

| Construct | Treatment |
| --- | --- |
| `//*` ... `*//`, each on a line of its own | [Markdown comment](Language.md#markdown-comments): never runs; prose in `spl doc`. Top level only |
| `---` ... `---` with an instruction | [Block](Language.md#blocks): an instruction for a model, with an optional header |
| `---` ... `---` with header lines only | [File defaults](Language.md#file-defaults); must be the first item that is not a comment |
| Everything else | TypeScript with [erasable syntax](Language.md#the-typescript-dialect), run as an ES module |

A block may stand wherever a statement may. Blocks, references and outputs compile to calls on
the lines they occupy; see [How a file is compiled](Language.md#how-a-file-is-compiled).

## Header keys

| Key | Modes | File default | Value |
| --- | --- | --- | --- |
| `mode` | all | No | `ask` (default), `agent` or `codegen` |
| `model` | all | Yes | Model id; `provider/model` selects a provider |
| `reasoning` | all | Yes | `none`, `low`, `medium` (default), `high` or `max` |
| `enforce` | all | Yes | Guidance the model must follow: a string or a list of strings |
| `forbid` | all | Yes | Guidance on what the model must avoid: a string or a list of strings |
| `hide` | all | Yes | `true` or `false`: hide reasoning in logs |
| `tokens` | all | Yes | Maximum generated tokens per model turn: a positive integer |
| `restrict` | agent | No | A folder, a list of folders, or `{ fs, exec, net, mcp }` with strings or lists of strings |
| `outputVar` | ask | No | Name of the output variable; `=name` assigns an existing `let`. Required |
| `outputType` | ask | No | Type expression the answer is converted to; `Str` by default. TypeScript, not YAML |
| `repairs` | ask | No | Retries when the answer cannot be converted: an integer from 0 to 5 |
| `seed` | ask | No | Sampling seed: an integer from 0 to 2147483647 |
| `temperature` | ask | No | Sampling temperature: a number from 0 to 2 |
| `topP` | ask | No | Nucleus sampling: a number from 0 to 1 |

Values are YAML, except `outputType`. The header ends at a blank line or at the first line
whose key is not in this table. See [The header](LLM-commands.md#the-header).

## References and outputs

| Written in a block | Mode | Meaning |
| --- | --- | --- |
| `@name`, `@name.property` | all | An input: a variable, function or type of the surrounding code |
| `@env.NAME` | all | An environment variable |
| `@args` | all | The script arguments |
| `@@` | all | A literal `@` |
| `outputVar: name` | ask | Declares the constant `name` |
| `outputVar: =name` | ask | Assigns the existing variable `name` |
| `->[Type] @name`, `-> @name` | agent | Declares an output, typed or untyped |
| `->[Type] @=name`, `-> @=name` | agent | Assigns the existing variable `name` |
| `-> @name(params): Type`, `-> @name` | codegen | Declares a generated function, with or without a signature |

A reference starts a word: `user@example.com` is literal text. There is no `${...}` interpolation.

## Errors the scanner reports

Syntax problems are found before anything runs. `spl run`, `spl compile` and `spl doc` print
them as `file:line:column: syntax error: message` and exit with code 2; `spl check` prints
them without the `syntax error:` label.

| Situation | Error |
| --- | --- |
| Odd number of `---` fences | `` Unmatched block opened at line N: every `---` needs a closing `---` `` |
| Block in expression position | ``Blocks are statements: a `---` block cannot be used as an expression`` |
| `//*` below top level or inside a block | ``Markdown comments (`//*`) are only allowed at the top level`` |
| Unclosed `//*` | ``Unclosed Markdown comment: `//*` needs a closing `*//` at the start of a line`` |
| Text on the line of `*//` | `` `*//` must be alone on its line `` |
| Misspelled header key | ``unknown header key `modle`; did you mean `model`?`` |
| Header key not valid for the mode | `` `outputVar` applies only to ask blocks ``, `` `restrict` applies only to agent blocks `` |
| Ask block without `outputVar` | `` ask block needs outputVar: name the variable that receives the answer, such as `outputVar: summary` `` |
| Ask block with `->` | `` ask block needs outputVar: `->` declares outputs only in agent and codegen blocks `` |
| Header-only block that is not first | `File defaults must come first: a block without an instruction sets defaults for the whole file` |
| Key that cannot be a file default | `` `mode` cannot be a file default; it belongs to a block with an instruction `` |
| Block with no header and no instruction | ``empty block: write an instruction between the `---` lines`` |
| Header key set twice | `` header key `model` is set twice `` |
| Header value that is not valid YAML | `` `enforce` is not valid YAML: `` followed by the parser's message |
| `outputType` without a value | `` `outputType` needs a type expression such as Int or List(Str) `` |
| Agent output declared twice | `output @notes is declared twice in this block` |
| Codegen block without a function | `` codegen block needs a function to generate, such as `-> @slugify(text: string): string` `` |
| `@=name` in a codegen block | `` generated functions are always new constants; write `@name`, not `@=name` `` |
| 2.x syntax | `SPL 2.x syntax; see the migration guide`; see [Migrating from 2.x](Migration.md) |
| `enum` | ``Unsupported TypeScript syntax: `enum` cannot be erased; use a union of string literals instead of enum`` |
| `namespace` or `module` with a body | ``Unsupported TypeScript syntax: `namespace` cannot be erased; use an ES module or a plain object instead of namespace`` |
| Decorator | `Unsupported TypeScript syntax: decorators cannot be erased; call the decorator as a function instead` |
| Constructor parameter property | `Unsupported TypeScript syntax: parameter properties cannot be erased; declare the field and assign it in the constructor` |

A header value of the wrong kind names the key and what it accepts:

| Key | Error |
| --- | --- |
| `mode` | `` `mode` must be ask, agent or codegen `` |
| `model` | `` `model` must be a model id `` |
| `reasoning` | `` `reasoning` must be none, low, medium, high or max `` |
| `enforce`, `forbid` | `` `enforce` must be a string or a list of strings `` |
| `hide` | `` `hide` must be true or false `` |
| `tokens` | `` `tokens` must be a positive integer `` |
| `restrict` | `` `restrict` must be a folder or { fs, exec, net, mcp } with strings or lists of strings `` |
| `outputVar` | `` `outputVar` must be a variable name, or =name to assign an existing variable `` |
| `repairs` | `` `repairs` must be an integer from 0 to 5 `` |
| `seed` | `` `seed` must be an integer from 0 to 2147483647 `` |
| `temperature` | `` `temperature` must be a number from 0 to 2 `` |
| `topP` | `` `topP` must be a number from 0 to 1 `` |

After the scanner, the generated TypeScript is erased and parsed. Problems found there are
reported the same way:

| Situation | Error |
| --- | --- |
| Code that is not valid TypeScript | `invalid TypeScript:` followed by the parser's message |
| Other syntax that cannot be erased | `Unsupported TypeScript syntax:` followed by the detail and `; only type syntax that can be erased is allowed` |
| `export default` | `` the default export of a .spl file is its workflow; remove `export default` `` |
| Exported declaration that uses a workflow variable | ``exported `double` uses the workflow variable `base`; exports live outside the workflow, so export `base` too or pass it as a parameter`` |
| `export { name }` of a workflow variable | ``cannot export the workflow variable `base`; write `export` on its declaration instead`` |

Type errors, including references to names that do not exist, are reported by
[`spl check`](CLI.md#spl-check) with TypeScript's own messages.

## Model calls

| Call | Resolves to |
| --- | --- |
| `ask(prompt, options?)` | The answer; no tools |
| `agent(prompt, options?)` | The answer after the model acted with the exact tools and MCP tools |
| `` ask`Text ${value}` `` | Tagged-template form of both calls, without options |

A prompt that is not a string is converted to text: objects and arrays as JSON, types by name.

| Option | Type | Default | Calls |
| --- | --- | --- | --- |
| `len` | `'word'`, `'sentence'`, `'paragraph'`, `'long'` | none | all |
| `fmt` | `'text'`, `'integer'`, `'float'`, `'boolean'`, `'array'`, `'object'`, `'json'` | `'text'`, or `'json'` with `schema` | all |
| `schema` | A type or JSON Schema (object or boolean) | none | all |
| `repairs` | Integer `0` to `5` | `0` | `ask` |
| `reasoning` | `'none'`, `'low'`, `'medium'`, `'high'`, `'max'` | File default, else `'medium'`; `'none'` when sampling is set | all |
| `hide` | Boolean | File default, else `false` | all |
| `model` | Nonempty string | File default, else the provider's | all |
| `tokens` | Positive safe integer | File default, else the provider's | all |
| `seed` | Integer `0` to `2147483647` | provider default | `ask` |
| `temperature` | Number `0` to `2` | provider default | `ask` |
| `topP` | Number `0` to `1` | provider default | `ask` |

The result is a string for text output, the parsed JSON value for `fmt`, and the converted
value of the type for `schema`. In TypeScript the return type follows the options. Invalid
options are a `runtime_error` raised before any model call. See [Options](LLM-commands.md#options).

## Guidance and restrictions

| Call | Effect |
| --- | --- |
| `enforce(text, body)` | Runs `body` with positive guidance added to every model call inside; returns its result |
| `forbid(text, body)` | Runs `body` with guidance about what to avoid; returns its result |
| `restrict(spec, body)` | Runs `body` with narrowed permissions; resolves to its result |

`text` is a nonempty string or a list of them. `body` is a function, usually an arrow function.
`spec` is a folder, a list of folders, or an object:

| `spec` key | Limits | Values |
| --- | --- | --- |
| `fs` | Files read and written by tools and agents | Folders or files, relative to the working directory |
| `exec` | Executables run by `shell` | Names without a path, such as `git` |
| `net` | Hosts reached by `webFetch`, `webSearch` and agents | Host names; `*.example.com` matches subdomains |
| `mcp` | MCP tools offered to agents | `server`, `server/*` or `server/tool` |

Each value is a comma-separated string or a list of strings. See [Restrictions](Safety.md#restrictions).

## Control, people and logging

| Call | Effect |
| --- | --- |
| `success(value?)` | Ends the workflow with a result (`null` when omitted) |
| `fail(reason?)` | Raises `explicit_failure`; the default reason is `failed` |
| `assert(condition, message?)` | Raises `assertion_failed` when `condition` is falsy |
| `human(question)` | Resolves to a person's answer as a string |
| `log(...values)`, `log.info(...)` | Writes to the run log at info level |
| `log.error(...values)`, `log.debug(...values)` | Writes at error or debug level |
| `Failure` | The class of failures: `error instanceof Failure`, `statusCode`, `status_code`, `reason`, `line`, `command`, `payload()` |

## Tools

| Call | Resolves to |
| --- | --- |
| `readFile(path)` | The file's UTF-8 text |
| `writeFile(path, content)` | A confirmation; parent folders are created |
| `webFetch(url)` | The body of an http(s) GET |
| `webSearch(query)` | The top results as text |
| `shell(command)` | Combined stdout and stderr |

Arguments are strings. Failures are `tool_error`; blocked calls are `restriction_violation`.
Tool names are camelCase everywhere: in code, as the tools an agent sees and in logs.

## Inputs and code generation

| Name | Value |
| --- | --- |
| `args` | Read-only array of `--arg` values |
| `env` | Read-only environment variables; access is recorded for replay |
| `codegen(description, options?)` | Resolves to a generated function; options are `model`, `reasoning`, `hide` and `tokens` |

## Types

| Builder | Kind | JSON Schema |
| --- | --- | --- |
| `Str` | `str` | `{ "type": "string" }` |
| `Int` | `int` | `{ "type": "integer" }` |
| `Float` | `float` | `{ "type": "number" }` |
| `Bool` | `bool` | `{ "type": "boolean" }` |
| `Char` | `char` | String with `minLength` and `maxLength` of 1 |
| `Nil` | `null` | `{ "type": "null" }` |
| `Any` | `any` | `{}` |
| `Dict` | `dict` | `{ "type": "object" }` |
| `Fn` | `fn` | None: describing it is a `runtime_error` |
| `List(T)` | `list` | `{ "type": "array", "items": T }` |
| `Union(A, B, ...)` | `union` | `{ "anyOf": [A, B, ...] }` |
| `Nullable(T)` | `union` | `{ "anyOf": [T, { "type": "null" }] }` |
| `Enum('a', 'b')`, `Enum(['a', 'b'])` | `enum` | `{ "type": "string", "enum": ["a", "b"] }` |
| `Struct(name, fields?)` | `struct` | Object with every field in `required` and `additionalProperties: false` |
| `Typedef(name, type, annotations?)` | Kind of `type` | Schema of `type` plus annotations |
| `JsonSchema(schema, name?)` | `schema` | The given schema |

| Member of every type | Result |
| --- | --- |
| `kind`, `name`, `annotations` | The kind above, the display name and the attached annotations |
| `annotate(annotations)` | A copy with the annotations merged in |
| `describe(text)` | Shorthand for `annotate({ description: text })` |
| `as(name, annotations?)` | A named copy; `Typedef` is the function form |
| `nullable()`, `list()`, `or(other)` | `Union(T, Nil)`, `List(T)`, `Union(T, other)` |
| `parse(value)` | The validated value; throws `validation_failed` with a path such as `$.lines[0].total` |
| `coerce(value)` | The value converted to the type, then validated; see [Parse and coerce](Language.md#parse-and-coerce) |
| `parseJson(text)` | `parse` of strict JSON text; throws `invalid_format` for malformed JSON |
| `is(value)` | Boolean |
| `schema()` | JSON Schema with annotations in `description` |

| Member of a struct | Result |
| --- | --- |
| `fields` | The field types by name |
| `field(name, type, annotations?)` | A copy with one more field |
| `methods({ ... })` | A class type whose parsed values have these methods |
| `class(Constructor)` | A class type whose parsed values are instances; a static `fromJSON(data)` builds them when present |
| `data` | The plain-struct view of a class type |

`validate(value, type)` equals `type.parse(value)`; `validate(value, schema)` checks raw JSON
Schema and returns the value. `t` holds every builder under one name: `t.Str`, `t.List`,
`t.Struct`. Type names in messages follow the builders: `expected Int, got "x"`,
`List(Str)`, `Str | Nil`. TypeScript code gets the parsed type with `Infer<typeof Type>`,
a global in `.spl` files and an export of `spl-lang`. See [Types](Language.md#types).

## Markdown builder

`markdown.document()` (or `new markdown.Document()`) has the chainable methods `heading`,
`paragraph`, `bulletList`, `orderedList`, `quote`, `codeBlock`, `table`, `thematicBreak`, `raw`
and `toString`. `markdown.bold`, `italic`, `code`, `link`, `image` and `escape` return inline
strings. See [Markdown builder](Language.md#markdown-builder).

## Agent tools

The tools of an [agent block](LLM-commands.md#agent-blocks):

| Tool | Arguments | Result |
| --- | --- | --- |
| `loadVariable` | `name` | The value of an input; a type's JSON Schema |
| `saveVariable` | `name`, `value` | The saved value, or a rejection with a hint when it does not fit the output's type |
| `callFunction` | `name`, `args` (list) | The function's result |
| `getEnv` | `name` | The value, or `null` |
| `askHuman` | `question` | The answer |
| `setGuidance` | `kind` (`enforce` or `forbid`), `text` | Adds guidance to model calls made by functions called later in the block |
| `readFile`, `writeFile`, `webFetch`, `webSearch`, `shell` | As the tools above | As the tools above |
| `mcp<Index><Tool>` | The MCP tool's own | The MCP result; see [MCP servers](CLI.md#mcp-servers) |

`name` is an identifier, optionally followed by `.property` parts, as written after `@` in the
instruction. `loadVariable` and `callFunction` accept only names the instruction references;
`saveVariable` accepts only declared outputs. An `agent()` call in code has the exact tools and
MCP tools only.

## Failure codes

| `status_code` | Raised by |
| --- | --- |
| `invalid_format` | `fmt` and JSON parsing of answers, `parseJson`, invalid generated code |
| `validation_failed` | Types and raw JSON Schema: `outputType`, `schema`, `parse`, `coerce`, agent outputs |
| `assertion_failed` | `assert`, the Markdown builder |
| `explicit_failure` | `fail` |
| `restriction_violation` | Tools, agents and MCP inside `restrict` |
| `tool_error` | `readFile`, `writeFile`, `webFetch`, `webSearch`, `shell`, MCP tools |
| `llm_error` | Providers: credentials, access, timeouts, token limits, rejected settings |
| `runtime_error` | Uncaught JavaScript exceptions, invalid options and arguments, misuse of the library |

See [Failure payload](Safety.md#failure-payload) for the JSON shape and
[Output and exit codes](CLI.md#output-and-exit-codes) for the exit codes.

## Package entry points

| Import | Contents |
| --- | --- |
| `spl-lang` | The library globals, `configure`, the type classes and `Infer`, plus the embedding API: `run`, `scan`, `compile`, `check`, `documentMarkdown`, `documentHtml`, `Runtime`, `Logger`, `AiBackend`, `Trace`, `loadMcpConfig`, `HEADER_KEYS`, `MODES` and their types. `__spl` is what compiled workflows call |
| `spl-lang/markdown` | The Markdown builder: `Document`, `document`, `bold`, `italic`, `code`, `link`, `image`, `escape` |
| `spl-lang/globals` | Types only: the globals of a `.spl` file as ambient declarations |

Inside a workflow, in `.spl` files and in the modules they import, `spl-lang` and
`spl-lang/markdown` always resolve to the running copy of the package: no local install is
needed, and helpers share the runtime and the `Failure` class.

To type-check your own helper modules with the globals of a `.spl` file, add them to a
`jsconfig.json` or `tsconfig.json`:

```json
{ "compilerOptions": { "types": ["spl-lang/globals"] } }
```

## Maintaining this page

The globals listed here are the keys of `library()` in `lang/src/library.ts`, which
`lang/globals.d.ts` and the VS Code catalog mirror. The header keys are `HEADER_KEYS` in
`lang/src/scanner.ts`, which also holds every scanner message. When they change, update this
page with them and run `npm run docs:build` from the repository root. The documentation tests
compile every `spl` listing and keep embedded example files in sync.
