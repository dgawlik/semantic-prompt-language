# Grammar (EBNF)

The canonical SPL syntax reference. Commands use parenthesized named modifiers
with the prompt outside the parentheses. Modifier names are checked while parsing;
expression values and schemas are checked at runtime.

This grammar describes the embedded SPL language and the compatible raw `parse`
API. Executable files are Markdown documents with extension/version frontmatter;
see [document structure](Language.md#program-structure). A fenced SPL unit uses
`program` without `directive`; the document model belongs in frontmatter.
Blockquotes are natural-language instructions, not SPL grammar productions.

## Notation

`{ x }` means repetition, `[ x ]` means optional, and `|` separates alternatives. Statements end at a newline, semicolon, closing block, or end of input. Opening block braces must share the keyword's line. Comments begin with `#`.

## Complete grammar

```ebnf
(* SPL. { x } means repetition; [ x ] means optional.
   Statements end at newline, ';', '}' or EOF. Newlines inside () and [] are ignored.
   '#' starts a comment. Opening block braces must be on the keyword's line. *)

program        = { directive , separator } , { statement , separator } ;
separator      = NL | ";" | end_of_block | EOF ;
directive      = "@" , "(" , "model" , "=" , plain_string , [ "," ] , ")" ;
block          = "{" , { statement , separator } , "}" ;

statement      = declaration | assignment | if_stmt | for_stmt | while_stmt
               | def_stmt | try_stmt | guidance_stmt | restrict_stmt | block
               | "return" , [ expr ] | "success" , [ expr ]
               | "assert" , expr , [ expr ] | "fail" , expr
               | "break" | "continue" | "pass" | expr ;
declaration    = "let" , NAME , "=" , expr ;
assignment     = target , ( "=" | "+=" | "-=" | "*=" | "/=" | "//=" | "%=" ) , expr ;
target         = NAME | postfix , "." , NAME | postfix , "[" , expr , "]" ;
if_stmt        = "if" , expr , block , { NL* , "elif" , expr , block } , [ NL* , "else" , block ] ;
for_stmt       = "for" , NAME , { "," , NAME } , "in" , expr , block ;
while_stmt     = "while" , expr , block ;
def_stmt       = "def" , NAME , "(" , [ NAME , { "," , NAME } , [ "," ] ] , ")" , block ;
try_stmt       = "try" , block , NL* , "except" , NAME , block ;
guidance_stmt  = ( "enforce" | "forbid" ) , expr , block ;
restrict_stmt  = "restrict" , restrict_clause , { "," , restrict_clause } , block ;
restrict_clause = [ "fs" | "net" | "exec" | "mcp" ] , expr ;

(* Every block creates a lexical child scope. let declares/redeclares locally and shadows parents.
   Reads and assignments search outward for the first declaration; undeclared names are errors.
   Each loop iteration has fresh locals; caught failure names belong to the handler scope.
   Blocks/if yield their final expression, otherwise None. An unmatched if yields None.
   {} remains an empty dict; { pass } is a block yielding None. Functions need explicit return.
   return exits the innermost function, or the script at top level.
   success exits the script, including when used in a function. *)

expr           = or_expr , [ "if" , or_expr , "else" , expr ] ;
or_expr        = and_expr , { "or" , and_expr } ;
and_expr       = not_expr , { "and" , not_expr } ;
not_expr       = "not" , not_expr | comparison ;
comparison     = sum , { ( "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "not" , "in" ) , sum } ;
sum            = term , { ( "+" | "-" ) , term } ;
term           = unary , { ( "*" | "/" | "//" | "%" ) , unary } ;
unary          = ( "-" | "+" ) , unary | "ask" , [ modifiers ] , postfix
               | human_expr | power ;
power          = postfix , [ "**" , unary ] ;
postfix        = primary , { call | index | slice | member } ;
call           = "(" , [ expr , { "," , expr } , [ "," ] ] , ")" ;
index          = "[" , expr , "]" ;
slice          = "[" , [ expr ] , ":" , [ expr ] , "]" ;
member         = "." , NAME ;
primary        = NUMBER | string | "True" | "False" | "None" | NAME | special_var
               | "(" , expr , ")" | list | dict | block | if_stmt | log_expr | human_expr
               | ( "think" | "agent" ) , [ modifiers ] , postfix ;
special_var    = "$env" | "$args" ;
list           = "[" , [ expr , { "," , expr } , [ "," ] ] , "]" ;
dict           = "{" , [ expr , ":" , expr , { "," , expr , ":" , expr } , [ "," ] ] , "}" ;
modifiers      = "(" , [ modifier , { "," , modifier } , [ "," ] ] , ")" ;
modifier       = ( "len" | "fmt" | "reasoning" | "show" | "schema" | "repairs" | "model" ) , "=" , expr ;
log_expr       = "log" , "(" , [ "level" , "=" , log_level , [ "," ] ] , ")" , call ;
log_level      = "error" | "info" | "debug" | expr ;
human_expr     = "human" , postfix ;

(* Unknown/duplicate modifier names are syntax errors. Values are expressions, validated at runtime:
   len: word/sentence/paragraph/long (guidance only)
   fmt: integer/float/array/object/text/boolean/json; schema implies json unless fmt is explicit
   Non-text formats require strict JSON of the selected type; float accepts finite numbers,
   object excludes arrays, and json accepts any JSON value.
   reasoning: low/medium/high; think and agent default to medium
   show: True/False; schema: synchronous strict JSON Schema draft-07 object or boolean
   repairs: integer 0..5 (additional generation attempts, default 0); agents require 0
   model: non-empty string; CLI override > per-call model > frontmatter (raw API: header) > SDK default
   Generation (ask and think) has no tools. agent explicitly enables restricted runtime/MCP tools.
   human takes a string question without modifiers and returns an exact caller-provided string.
   It suspends a checkpoint run, emits JSON and exits 3; it never reads stdin.
   Questions in functions, loops and expressions resume through ordered effect-history replay.
   Suspension is a control signal, not a catchable script failure.
   Raw tools are ordinary positional functions: read_file(path), write_file(path, content),
   web_fetch(url), web_search(query), shell(command). They never invoke a model.
   log(level=...)(args) selects error/info/debug severity; plain log(args) defaults to info.
   Level values are bare names, strings or expressions, validated before evaluating arguments.
   Debug messages are emitted only at debug log level; silent suppresses all logs.
   enforce/forbid are scoped prompt guidance.
   schema/assert validate data; restrict checks actions. *)

string         = [ "r" ] , quote , { char | escape | interpolation } , closing_quote ;
quote          = "'" | '"' | "'''" | '"""' ;
plain_string   = string_without_interpolation ;
escape         = "\" , ( "n" | "t" | "r" | "0" | "\" | "'" | '"' | "{" | "}" ) ;
interpolation  = "{" , expr , "}" ;
NUMBER         = digit+ , [ "." , digit+ ] , [ ( "e" | "E" ) , [ "+" | "-" ] , digit+ ] ;
NAME           = ( letter | "_" ) , { letter | digit | "_" } ;
NL             = newline ;

(* "{{"/"}}" are literal braces; raw strings have no interpolation or escapes.
   $env is a read-only process-environment dict snapshot; missing keys return None.
   $args is a read-only list of repeated CLI --arg strings (empty by default);
   out-of-range integer indexes return None, and negative indexes count from the end.
   Both are available in every scope and interpolation, cannot be rebound or mutated
   (including through aliases), and are not automatically persisted.
   Other $-prefixed names are syntax errors. Ordinary dict/list missing reads still fail.
   Reserved words: let if elif else for in while def return try except assert fail success
   enforce forbid restrict ask think agent human break continue pass and or not True False None.
   Removed syntax: ? 'prompt', ?{...} 'prompt', think{...}, agent{...}, log{...}, @{...},
   think(level=...), tool{param=...} 'instructions',
   let x += ... and let d.key = ... . *)
```

## Syntax versus semantics

`let` declares in the current block scope; reads and assignment search enclosing lexical scopes. Blocks and conditionals yield their final expression or `None`. Raw tools are ordinary function calls. Generation and agents share expression-valued modifiers; `log` has its own `level` modifier. See [language basics](Language.md) and [generation contracts](LLM-commands.md) for runtime rules.

Maintain the grammar in this Markdown page; there is no separate EBNF source file.
After changing executable examples, update their Markdown copies in `docs-template/`.
Run `npm run docs:build` from the repository root to regenerate all HTML pages and the
search index. Documentation tests check that the rendered grammar and examples remain synchronized.
