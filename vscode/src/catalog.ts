export interface Help {
    signature: string;
    description: string;
}

/** The library every fence has in scope. Names must match `library()` in lang/src/library.ts. */
export const library: Record<string, Help> = {
    ask: { signature: 'ask(prompt, options?)', description: 'Ask the model for a value; no tools. Returns trimmed text, or the parsed value with `fmt` or `schema`. Options: len, fmt, schema, repairs, reasoning, hide, model, tokens, seed, temperature, topP. Also usable as a template tag: ask`Summarize ${notes}`.' },
    think: { signature: 'think(prompt, options?)', description: 'Like ask, with medium reasoning by default. No tools and no sampling options.' },
    agent: { signature: 'agent(prompt, options?)', description: 'Let the model act with the runtime tools (read_file, write_file, web_fetch, web_search, shell) and configured MCP tools, within active restrictions. Never repaired, so actions are not repeated.' },
    human: { signature: 'human(question)', description: 'Ask a person and resolve to their answer. The CLI reads stdin or repeatable --human answers; traces replay recorded answers.' },
    enforce: { signature: 'enforce(text, () => ...)', description: 'Add positive prompt guidance to every model call made inside the callback. Guidance shapes prompts; it does not validate answers.' },
    forbid: { signature: 'forbid(text, () => ...)', description: 'Tell every model call made inside the callback what to avoid. Guidance shapes prompts; it does not validate answers.' },
    restrict: { signature: "restrict({ fs, exec, net, mcp }, async () => ...)", description: "Limit what tools and agents may touch inside the callback. A string or list is shorthand for fs. Nested restrictions of one kind intersect; violations raise restriction_violation." },
    success: { signature: 'success(value?)', description: 'End the document successfully with a result, even from inside a function.' },
    fail: { signature: 'fail(reason)', description: 'Stop with explicit_failure and a reason, unless caught with try/catch.' },
    assert: { signature: 'assert(condition, message?)', description: 'Raise assertion_failed when the condition is falsy.' },
    log: { signature: 'log(...values)', description: 'Write values to the run log (stderr) at info level. log.error(...) and log.debug(...) select other levels.' },
    codegen: { signature: 'codegen(description, options?)', description: 'Generate a JavaScript function from a description, define it in the shared scope and resolve to it. With --trace the code is cached next to the workflow.' },
    readFile: { signature: 'readFile(path)', description: 'Read a UTF-8 file. An exact tool: it never calls a model and is subject to active restrictions.' },
    writeFile: { signature: 'writeFile(path, content)', description: 'Create or overwrite a UTF-8 file, creating parent folders. Subject to active restrictions.' },
    webFetch: { signature: 'webFetch(url)', description: 'Fetch an http(s) URL and resolve to the response text. Subject to active restrictions.' },
    webSearch: { signature: 'webSearch(query)', description: 'Search the web and resolve to the top results as text. Subject to active restrictions.' },
    shell: { signature: 'shell(command)', description: 'Run a shell command and resolve to its combined output. A nonzero exit raises tool_error.' },
    args: { signature: 'args', description: 'Read-only list of strings supplied with repeated --arg options, in order. Missing entries are undefined.' },
    env: { signature: 'env', description: 'Read-only environment variables: env.NAME. Missing names are undefined. Access is recorded for trace replay.' },
    validate: { signature: 'validate(value, Type)', description: 'Parse a value with a type (returning plain objects or class instances), or check it against raw JSON Schema. Never coerces or fills defaults.' },
    markdown: { signature: 'markdown', description: 'Markdown builder: markdown.document().heading(text, level).paragraph(text).bulletList(items).table(headers, rows).toString(), plus bold, italic, code, link, image and escape.' },
    Failure: { signature: 'Failure', description: 'The class of workflow failures: error instanceof Failure, error.statusCode, error.reason, error.line.' },
    t: { signature: 't', description: 'The type builders under one name: t.str, t.int, t.list(t.str), t.enum(...), t.struct(name, fields).' },
    str: { signature: 'str', description: 'String type. Add annotations for the model with .annotate({...}) or .describe(text).' },
    int: { signature: 'int', description: 'Integer type (safe integers only).' },
    float: { signature: 'float', description: 'Finite number type.' },
    bool: { signature: 'bool', description: 'Boolean type.' },
    char: { signature: 'char', description: 'Type of a string with exactly one Unicode character.' },
    nil: { signature: 'nil', description: 'The null type; nullable(T) is shorthand for union(T, nil).' },
    any: { signature: 'any', description: 'Type accepting any JSON value.' },
    object: { signature: 'object', description: 'Type accepting any plain object, without a declared shape.' },
    fn: { signature: 'fn', description: 'Type of a callable; it cannot be decoded from JSON.' },
    list: { signature: 'list(type)', description: 'List type: list(str), list(Invoice).' },
    union: { signature: 'union(a, b, ...)', description: 'Value matching any of the member types.' },
    nullable: { signature: 'nullable(type)', description: 'The type or null. The field must still be present.' },
    enumOf: { signature: "enumOf('a', 'b', ...)", description: 'One of the given strings.' },
    struct: { signature: 'struct(name, { field: type, ... })', description: 'An exact record: every field is required and extra fields are rejected. Chain .field(name, type, annotations), .methods({...}) or .class(Constructor).' },
    typedef: { signature: 'typedef(name, type, annotations?)', description: 'Name a type and attach annotations the model reads, such as { desc, minimum }. Annotations are advice, not validation.' },
    jsonSchema: { signature: 'jsonSchema(schema, name?)', description: 'Wrap raw JSON Schema as a type; unlike annotations, its constraints are enforced.' },
};

/** Library functions an agent can usefully reach from a blockquote with `@name`. */
export const callable = ['ask', 'think', 'agent', 'human', 'log', 'codegen', 'readFile', 'writeFile', 'webFetch', 'webSearch', 'shell', 'validate'];

/** Blockquote markers with a fixed meaning, by lowercase name. */
export const markers: Record<string, Help & { insert: string }> = {
    ctl: { insert: "CTL(${1|restrict,enforce,forbid,model,reasoning|}=$0)", signature: "@CTL(restrict={fs: ['./src']}, enforce='...', forbid='...', model='...', reasoning='high')", description: 'Literal settings applied by the runtime before the agent starts. Must open the blockquote.' },
    codegen: { insert: "CODEGEN '${0:Define name(args), returning ...}'", signature: "@CODEGEN 'description'", description: 'Generate JavaScript functions from a literal description and define them in the shared scope, instead of running an agent command.' },
    validate: { insert: 'validate[${1:Type}]', signature: '@validate[Type]', description: 'Ask the agent to validate the saved value against a declared type or schema; invalid values stop the command.' },
    success: { insert: 'success', signature: '@success', description: 'End the whole document successfully with a value.' },
    fail: { insert: 'fail', signature: '@fail', description: 'End the whole document with an explicit failure.' },
    env: { insert: 'env.${1:NAME}', signature: '@env.NAME', description: 'One read-only environment variable, read by the agent with get_env.' },
    args: { insert: 'args', signature: '@args', description: 'The script arguments supplied with --arg.' },
};
