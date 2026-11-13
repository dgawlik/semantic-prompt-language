# API reference

Everything a workflow can use on one page: the document format, every library global with its
signature and options, the type builder, blockquote tools and controls, and failure codes.

## Document format

A workflow is a Markdown file that starts with YAML frontmatter.

| Frontmatter field | Required | Value |
| --- | --- | --- |
| `extension` | Yes | `semantic-prompt-language` |
| `version` | Yes | `1` |
| `model` | No | Default model ID for the document |
| `preamble` | No | Text added to every model request |

Unknown fields are syntax errors. After the frontmatter, blocks run in document order:

| Block | Treatment |
| --- | --- |
| Fence `js`, `javascript`, `mjs` | Runs as JavaScript |
| Fence `ts`, `typescript`, `mts` | Types are erased, then it runs as JavaScript |
| Fence with `ignore` or `no-run` after the language | Not run |
| Fence `spl` | Syntax error with a migration hint |
| Any other fence, headings, prose | Commentary |
| Top-level blockquote | Agent command; `@CODEGEN` generates functions instead |
| Double blockquote with a `spl-lock` fence | The journal of a [pinned workflow](CLI.md#pinned-workflows) |

A [`.spl` file](Language.md#dedicated-spl-files) holds the same workflow as blocks. Frontmatter is
optional there and needs neither `extension` nor `version`. Each tag stands on its own line, and
text outside blocks is a syntax error.

| Block of a `.spl` file | Treatment |
| --- | --- |
| `{js}` ... `{/js}` | Runs as JavaScript |
| `{ts}` ... `{/ts}` | Types are erased, then it runs as JavaScript |
| `{js ignore}`, `{js no-run}`, likewise for `ts` | Not run |
| `{agent restrict=..., enforce=..., forbid=..., model=..., reasoning=...}` ... `{/agent}` | Agent command; the optional settings are those of `@CTL` |
| `{codegen ...}` ... `{/codegen}` | Generates functions from the description; accepts the settings of `{agent}` |
| `{comment}` ... `{/comment}` | Commentary |
| `{lock}` ... `{/lock}` | The journal of a [pinned workflow](CLI.md#pinned-workflows) |

Fences are compiled as ES-module code in strict mode: top-level `await`, `import`, `import()`
and `import.meta.url`, `.filename`, `.dirname` are available; top-level `return`,
`export default` and `export { ... }` are not. `import.meta` describes the workflow file, while
imports and relative tool paths resolve against the working directory. Imported names are
live, read-only bindings. All blocks share one top-level scope; see
[One shared scope](Language.md#one-shared-scope).

## Model calls

| Call | Resolves to |
| --- | --- |
| `ask(prompt, options?)` | The answer; no tools |
| `think(prompt, options?)` | Like `ask`, with `reasoning: 'medium'` by default |
| `agent(prompt, options?)` | The answer after the model acted with runtime and MCP tools |
| `` ask`Text ${value}` `` | Tagged-template form of all three calls, without options |

A prompt that is not a string is converted to text: objects and arrays as JSON, types by name.

| Option | Type | Default | Calls |
| --- | --- | --- | --- |
| `len` | `'word'`, `'sentence'`, `'paragraph'`, `'long'` | none | all |
| `fmt` | `'text'`, `'integer'`, `'float'`, `'boolean'`, `'array'`, `'object'`, `'json'` | `'text'`, or `'json'` with `schema` | all |
| `schema` | A type or JSON Schema (object or boolean) | none | all |
| `repairs` | Integer `0` to `5` | `0` | `ask`, `think` |
| `reasoning` | `'low'`, `'medium'`, `'high'` | none for `ask`, `'medium'` otherwise | all |
| `hide` | Boolean | `false` | all |
| `model` | Nonempty string | document or provider default | all |
| `tokens` | Positive safe integer | provider default | all |
| `seed` | Integer `0` to `2147483647` | provider default | `ask` |
| `temperature` | Number `0` to `2` | provider default | `ask` |
| `topP` (alias `top_p`) | Number `0` to `1` | provider default | `ask` |

The result is a string for text output, the parsed JSON value for `fmt`, and the parsed value of
the type for `schema`. In TypeScript the return type follows the options. Invalid options are a
`runtime_error` raised before any model call. See [Options](LLM-commands.md#options).

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
| `success(value?)` | Ends the document with a result (`null` when omitted) |
| `fail(reason?)` | Raises `explicit_failure`; the default reason is `failed` |
| `assert(condition, message?)` | Raises `assertion_failed` when `condition` is falsy |
| `human(question)` | Resolves to a person's answer as a string |
| `log(...values)`, `log.info(...)` | Writes to the run log at info level |
| `log.error(...values)`, `log.debug(...values)` | Writes at error or debug level |
| `Failure` | The class of failures: `error instanceof Failure`, `statusCode`, `status_code`, `reason`, `payload()` |

## Tools

| Call | Resolves to | Agent tool name |
| --- | --- | --- |
| `readFile(path)` | The file's UTF-8 text | `read_file` |
| `writeFile(path, content)` | A confirmation; parent folders are created | `write_file` |
| `webFetch(url)` | The body of an http(s) GET | `web_fetch` |
| `webSearch(query)` | The top results as text | `web_search` |
| `shell(command)` | Combined stdout and stderr | `shell` |

Arguments are strings. Failures are `tool_error`; blocked calls are `restriction_violation`.

## Inputs and code generation

| Name | Value |
| --- | --- |
| `args` | Read-only array of `--arg` values |
| `env` | Read-only environment variables; access is recorded for replay |
| `codegen(description, options?)` | Resolves to a generated function, also defined in the shared scope; options are `model` and `reasoning` |

## Types

| Builder | Kind | JSON Schema |
| --- | --- | --- |
| `str` | `str` | `{ "type": "string" }` |
| `int` | `int` | `{ "type": "integer" }` |
| `float` | `float` | `{ "type": "number" }` |
| `bool` | `bool` | `{ "type": "boolean" }` |
| `char` | `char` | String with `minLength` and `maxLength` of 1 |
| `nil` | `null` | `{ "type": "null" }` |
| `any` | `any` | `{}` |
| `object` | `object` | `{ "type": "object" }` |
| `fn` | `fn` | None: describing it is a `runtime_error` |
| `list(T)` | `list` | `{ "type": "array", "items": T }` |
| `union(A, B, ...)` | `union` | `{ "anyOf": [A, B, ...] }` |
| `nullable(T)` | `union` | `{ "anyOf": [T, { "type": "null" }] }` |
| `enumOf('a', 'b')`, `enumOf(['a', 'b'])` | `enum` | `{ "type": "string", "enum": ["a", "b"] }` |
| `struct(name, fields?)` | `struct` | Object with every field in `required` and `additionalProperties: false` |
| `typedef(name, type, annotations?)` | Kind of `type` | Schema of `type` plus annotations |
| `jsonSchema(schema, name?)` | `schema` | The given schema |

| Member of every type | Result |
| --- | --- |
| `kind`, `name`, `annotations` | The kind above, the display name and the attached annotations |
| `annotate(annotations)` | A copy with the annotations merged in |
| `describe(text)` | Shorthand for `annotate({ description: text })` |
| `as(name, annotations?)` | A named copy; `typedef` is the function form |
| `nullable()`, `list()`, `or(other)` | `union(T, nil)`, `list(T)`, `union(T, other)` |
| `parse(value)` | The validated value; throws `validation_failed` with a path such as `$.lines[0].total` (the variable name replaces `$` when an agent saves with a schema) |
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
Schema and returns the value. `t` holds every builder under one name: `t.str`, `t.list`,
`t.struct`, with `t.enum`, `t.null` and `t.schema` as aliases of `enumOf`, `nil` and
`jsonSchema`. TypeScript code gets the parsed type with `Infer<typeof Type>`, imported from
`spl-lang`. See [Types](Language.md#types) and [TYPES.md](../TYPES.md).

## Markdown builder

`markdown.document()` (or `new markdown.Document()`) has the chainable methods `heading`,
`paragraph`, `bulletList`, `orderedList`, `quote`, `codeBlock`, `table`, `thematicBreak`, `raw`
and `toString`. `markdown.bold`, `italic`, `code`, `link`, `image` and `escape` return inline
strings. See [Markdown builder](Language.md#markdown-builder).

## Blockquote tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `load_variable` | `name` | The value; a type's JSON Schema; the script arguments for `args` |
| `save_variable` | `name`, `value`, optional `schema` | The saved value |
| `call_function` | `name`, `args` (list) | The function's result |
| `get_env` | `name` | The value, or `null` |
| `ask_human` | `question` | The answer |
| `read_file`, `write_file`, `web_fetch`, `web_search`, `shell` | As the tools above | As the tools above |
| `restrict` | `kind`, `value` | Narrows permissions for the rest of the command |
| `set_guidance` | `kind` (`enforce` or `forbid`), `text` | Adds guidance for the rest of the command |
| `success` | `value` | Ends the document |
| `fail` | `reason` | Ends the document with `explicit_failure` |

Names must be JavaScript identifiers that are not reserved words. `load_variable` refuses `env`;
`save_variable` refuses to replace functions, types, imported names and library names.

## Blockquote markers and controls

| Marker | Meaning |
| --- | --- |
| `@name` | A shared variable or function, or a library function such as `@readFile` |
| `@validate[Type]` | Validate the value being saved against a declared type or schema |
| `@success`, `@fail` | End the document |
| `@env.NAME` | One environment variable |
| `@args` | The script arguments |
| `@CTL(...)` | Runtime settings; must open the blockquote |
| `@CODEGEN 'description'` | Generate functions; must open the blockquote, after optional `@CTL` |

`@CTL` and `@CODEGEN` are case-insensitive and parsed by the runtime; the other markers are
conventions the agent follows. `@restrict`, `@enforce`, `@forbid` and `@human` are rejected.

```text
blockquote = [ controls ] ( codegen | instruction )
controls   = "@CTL" "(" [ setting { "," setting } [ "," ] ] ")"
setting    = "restrict" "=" "{" [ entry { "," entry } [ "," ] ] "}"
           | ( "enforce" | "forbid" ) "=" strings
           | "model" "=" string
           | "reasoning" "=" string            (low, medium or high)
entry      = ( "fs" | "exec" | "net" | "mcp" ) ":" strings
strings    = string | "[" [ string { "," string } [ "," ] ] "]"
codegen    = "@CODEGEN" string
string     = 'text' | "text" | `text` | '''text''' | """text""" | r'text' | r"text"
```

Strings are literals. Escapes are `\n`, `\t`, `\r`, `\0`, `\b`, `\f`, `\v`, `\xHH`, `\uHHHH`
and `\u{H...}`; any other escaped character stands for itself, and raw strings (`r'...'`) have
no escapes. Single- and double-quoted strings end on their line; backtick and triple-quoted
strings may span lines. `${...}` inside backticks is rejected. Each setting and each restriction
kind may appear once.

## Failure codes

| `status_code` | Raised by |
| --- | --- |
| `invalid_format` | `fmt` parsing, `parseJson`, invalid generated code |
| `validation_failed` | Types, raw JSON Schema, `@validate` |
| `assertion_failed` | `assert`, the Markdown builder |
| `explicit_failure` | `fail`, the agent's `fail` tool |
| `restriction_violation` | Tools, agents and MCP inside `restrict` |
| `tool_error` | `readFile`, `writeFile`, `webFetch`, `webSearch`, `shell` |
| `llm_error` | Providers: credentials, access, timeouts, token limits |
| `runtime_error` | Uncaught JavaScript exceptions, invalid options and arguments, misuse of the library |

See [Failure payload](Safety.md#failure-payload) for the JSON shape and exit codes.

## Package entry points

| Import | Contents |
| --- | --- |
| `spl-lang` | The library globals, `configure`, the type classes and `Infer`, plus the embedding API: `parseMarkdown`, `parseSpl`, `parse`, `parseInstruction`, `run`, `ExecutionSession`, `checkWorkflow`, `Logger`, `AiBackend`, `Trace`, `Pin`, `loadMcpConfig` and their types |
| `spl-lang/markdown` | The Markdown builder: `Document`, `document`, `bold`, `italic`, `code`, `link`, `image`, `escape` |
| `spl-lang/globals` | Types only: the fence globals as ambient declarations |

Inside a workflow, in fences and in the helper modules they import, `spl-lang` and
`spl-lang/markdown` always resolve to the running copy of the package: no local install is
needed, and helpers share the runtime and the `Failure` class.

To type-check your own helper modules as if they were fences, add the globals to a
`jsconfig.json` or `tsconfig.json`:

```json
{ "compilerOptions": { "types": ["spl-lang/globals"] } }
```

## Maintaining this page

The globals listed here are the keys of `library()` in `lang/src/library.ts`, which
`lang/globals.d.ts` and the VS Code catalog mirror. When the library changes, update this page
with them and run `npm run docs:build` from the repository root. The documentation tests compile
every `js` and `ts` example and keep embedded example files in sync.
