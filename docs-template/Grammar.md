# Grammar

The complete syntax of SPL documents and the code inside `spl` fences, in EBNF. Modifier names are
checked while parsing; modifier values and schemas are checked at runtime.

## Notation

`{ x }` repeats, `[ x ]` is optional, `|` separates alternatives, and quoted text is literal.
EBNF repetition braces are notation, not SPL block delimiters.

**Breaking change:** blocks start with `:` on the header's line, followed by a newline and an
indented, nonempty body. Replace old block braces with this layout; expand inline suites onto
separate lines and use `pass` for empty bodies. Dictionary braces are also removed: use `object:`
and `object()`. Interpolation `{expr}` and JSON wire syntax are unchanged.
Anonymous value-producing blocks use the same bare-colon syntax.

Indentation adds exactly four spaces per block level. The lexer emits `INDENT` when a block's indentation
increases and `DEDENT` when it decreases, including at end of input. Tabs in indentation,
unexpected indentation, missing bodies and dedents not matching a prior indentation level are
syntax errors. Blank and comment-only lines are ignored and cannot satisfy a block's body.
`elif`, `else` and `except` align with their opening statement.

`NL` is a significant logical newline. Newlines inside `()` and `[]` suspend ordinary indentation,
but explicit object suites still produce indentation tokens; a trailing `\` explicitly continues a line.
`#` starts a comment outside strings. Semicolons separate simple statements only, not compound
statements or block headers. A completed block ends at its dedent; a statement whose value ends
with a block can end there without another physical newline.

## Complete grammar

```ebnf
(* Documents *)
document       = frontmatter , { markdown_block } ;
frontmatter    = "---" , NL , yaml_mapping , ( "---" | "..." ) , NL ;
                 (* extension: semantic-prompt-language and version: 1 are required;
                    model and preamble are optional; other keys are errors *)
markdown_block = spl_fence | blockquote | commentary ;
spl_fence      = fence , "spl" , NL , program , fence ;
fence          = 3 * "`" , { "`" } | 3 * "~" , { "~" } ;
                 (* matching fences; each is a complete program without directives *)
blockquote     = ">" , [ controls ] , text , { NL , ">" , text } ;
                 (* natural language; the agent acts through shared-scope tools,
                    not by submitting generated SPL; quote prefixes may continue controls *)
controls       = "@CTL" , "(" , [ control , { "," , control } , [ "," ] ] , ")" ;
control        = "restrict" , "=" , restriction_map
               | ( "enforce" | "forbid" ) , "=" , control_strings
               | "model" , "=" , plain_string
               | "reasoning" , "=" , ( "'low'" | "'medium'" | "'high'" ) ;
restriction_map = "{" , [ restriction_entry , { "," , restriction_entry } , [ "," ] ] , "}" ;
restriction_entry = ( "fs" | "exec" | "net" | "mcp" | plain_string ) , ":" , control_strings ;
control_strings = plain_string | "[" , [ plain_string , { "," , plain_string } , [ "," ] ] , "]" ;
                 (* literal values only; restriction keys must name one of the four kinds;
                    marker case-insensitive, keys unique, model nonempty;
                    controls appear once at the start and may span lines;
                    reasoning strings may use either quote style;
                    removed @Restrict/@Enforce/@Forbid/@Human markers are errors *)
commentary     = ? any other Markdown ? ;

(* Programs *)
program        = { NL } , { directive , simple_end } , { statement } , EOF ;
directive      = "@" , "(" , "model" , "=" , plain_string , [ "," ] , ")" ;
                 (* raw parse API only; documents use frontmatter model *)
statement      = simple_line | compound_stmt ;
simple_line    = simple_stmt , { ";" , simple_stmt } , [ ";" ] , simple_end ;
simple_end     = NL | ? end of input, without consuming EOF ?
               | ? boundary immediately after a block-valued expression's DEDENT ? ;
compound_stmt  = if_stmt | for_stmt | while_stmt | def_stmt | try_stmt | struct_stmt | class_stmt
               | guidance_stmt | restrict_stmt | block ;
block          = ":" , NL , INDENT , statement , { statement } , DEDENT ;

simple_stmt    = import_stmt | declaration | assignment | enum_stmt | type_alias
               | "return" , [ expr ] | "success" , [ expr ]
               | "assert" , expr , [ expr ] | "fail" , expr
               | "break" | "continue" | "pass" | expr ;
                 (* a compound statement or block-valued expression is not an
                    inline semicolon suite; its body must use block layout *)
declaration    = "let" , NAME , [ ":" , type_expr ] , "=" , expr ;
import_stmt    = "import" , ( named_imports | "*" , "as" , NAME ) , "from" , plain_string ;
named_imports  = "{" , [ import_binding , { "," , import_binding } , [ "," ] ] , "}" ;
import_binding = NAME , [ "as" , NAME ] ;
                 (* imports occur only at program top level; sources are relative .spl paths
                    or bundled standard library names such as 'markdown';
                    all top-level declarations are exported automatically *)
assignment     = target , ( "=" | "+=" | "-=" | "*=" | "/=" | "//=" | "%=" ) , expr ;
target         = NAME | postfix , "." , NAME | postfix , "[" , expr , "]" ;
if_stmt        = "if" , expr , block , { "elif" , expr , block } , [ "else" , block ] ;
for_stmt       = "for" , NAME , { "," , NAME } , "in" , expr , block ;
while_stmt     = "while" , expr , block ;
def_stmt       = "def" , NAME , "(" , [ parameter , { "," , parameter } , [ "," ] ] , ")"
               , [ "->" , type_expr ] , block ;
parameter      = NAME , [ ":" , type_expr ] ;
enum_stmt      = "enum" , NAME , "=" , plain_string , { "|" , plain_string } ;
type_alias     = "type" , NAME , "=" , type_expr , [ metadata ] ;
struct_stmt    = "struct" , NAME , ":" , NL , INDENT , field , { field } , DEDENT ;
class_stmt     = [ "hydratable" ] , "class" , NAME , ":" , NL , INDENT
               , ( field | def_stmt ) , { field | def_stmt } , DEDENT ;
field          = NAME , ":" , type_expr , [ metadata ] , NL ;
metadata       = "[" , [ NAME , "=" , advice_literal , { "," , NAME , "=" , advice_literal } , [ "," ] ] , "]" ;
advice_literal = ? compile-time JSON-compatible literal, never an executed expression ? ;
type_expr      = type_atom , { "|" , type_atom } ;
type_atom      = NAME | "None" | "(" , type_expr , ")"
               | "list" , "[" , type_expr , "]"
               | "fn" , "(" , [ type_expr , { "," , type_expr } ] , ")" , "->" , type_expr ;
try_stmt       = "try" , block , "except" , NAME , block ;
guidance_stmt  = ( "enforce" | "forbid" ) , expr , block ;
restrict_stmt  = "restrict" , restrict_clause , { "," , restrict_clause } , block ;
restrict_clause = [ "fs" | "net" | "exec" | "mcp" ] , expr ;

(* Every block is a lexical child scope; let declares locally, assignment updates the
   nearest declaration. Blocks and if yield their final expression, otherwise None.
   object() is an empty dictionary; object entries do not create a lexical scope.
   A bare-colon block containing pass yields None.
   All bodies are nonempty. Functions need an explicit return. *)

expr           = lambda_expr | or_expr , [ "if" , or_expr , "else" , expr ] ;
lambda_expr    = "lambda" , [ NAME , { "," , NAME } , [ "," ] ] , ":" , expr ;
                 (* positional names only, no annotations or defaults;
                    the expression is implicitly returned in a lexical function scope *)
or_expr        = and_expr , { "or" , and_expr } ;
and_expr       = not_expr , { "and" , not_expr } ;
not_expr       = "not" , not_expr | comparison ;
comparison     = sum , { ( "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "not" , "in" ) , sum } ;
sum            = term , { ( "+" | "-" ) , term } ;
term           = unary , { ( "*" | "/" | "//" | "%" ) , unary } ;
unary          = ( "-" | "+" ) , unary | "ask" , [ ask_modifiers ] , postfix
               | human_expr | power ;
power          = postfix , [ "**" , unary ] ;
postfix        = primary , { call | index | slice | member } ;
call           = "(" , [ expr , { "," , expr } , [ "," ] ] , ")" ;
index          = "[" , expr , "]" ;
slice          = "[" , [ expr ] , ":" , [ expr ] , [ ":" , [ expr ] ] , "]" ;
member         = "." , NAME ;
primary        = NUMBER | string | "True" | "False" | "None" | NAME | special_var
               | "(" , expr , ")" | list | object_expr | type_expr | block | if_stmt | log_expr | human_expr
               | ( "think" | "agent" ) , [ modifiers ] , postfix ;
special_var    = "$env" | "$args" ;
list           = "[" , [ expr , { "," , expr } , [ "," ] ] , "]" ;
object_expr    = "object" , ":" , NL , INDENT , object_entry , { object_entry } , DEDENT ;
object_entry   = expr , ":" , expr , simple_end | def_stmt ;
                 (* object() is the ordinary empty-dictionary builtin call;
                    entries are newline-separated, without trailing commas *)
modifiers      = "(" , [ modifier , { "," , modifier } , [ "," ] ] , ")" ;
modifier       = ( "len" | "fmt" | "reasoning" | "hide" | "schema" | "repairs" | "model" | "tokens" ) , "=" , expr ;
ask_modifiers  = "(" , [ ask_modifier , { "," , ask_modifier } , [ "," ] ] , ")" ;
ask_modifier   = modifier | sampling ;
sampling       = ( "seed" | "temperature" | "top_p" ) , "=" , expr ;
log_expr       = "log" , "(" , [ "level" , "=" , log_level , [ "," ] ] , ")" , call ;
log_level      = "error" | "info" | "debug" | expr ;
human_expr     = "human" , postfix ;

(* Sampling modifiers are accepted only by ask. Unknown or duplicate modifiers are syntax errors.
   human takes no modifiers and
   uses a host input handler (stdin or --human in the CLI). Tools are ordinary functions: read_file, write_file,
   web_fetch, web_search, shell. *)

string         = [ "r" ] , quote , { char | escape | interpolation } , closing_quote ;
quote          = "'" | '"' | "'''" | '"""' ;
plain_string   = string_without_interpolation ;
escape         = "\" , ( "n" | "t" | "r" | "0" | "\" | "'" | '"' | "{" | "}" ) ;
interpolation  = "{" , expr , "}" ;
NUMBER         = digit+ , [ "." , digit+ ] , [ ( "e" | "E" ) , [ "+" | "-" ] , digit+ ] ;
NAME           = ( letter | "_" ) , { letter | digit | "_" } ;
NL             = ? logical newline outside delimiters and explicit continuations ? ;
INDENT         = ? increase of exactly four leading spaces after a block header ? ;
DEDENT         = ? return to a previous indentation level, including at EOF ? ;
EOF            = ? end of input ? ;

(* "{{" and "}}" are literal braces; raw strings have no escapes or interpolation.
   Blank/comment-only lines produce no indentation changes and are ignored.
   Indentation tabs, inline suites, empty bodies and inconsistent dedents are errors.
   $env and $args are read-only; other $-names are syntax errors.
   Reserved words: let if elif else for in while def return try except assert fail success
   enum struct class hydratable fn object enforce forbid restrict ask think agent human
   break continue pass and or not True False None. *)
```

## Block expressions

The same layout works in value positions without grouping parentheses:

```spl
let x = :
    let n = 2
    n + 1
let choice = if x > 2:
    1
else:
    2
let no_value = :
    pass
```

Each block is still a lexical child scope: `let` declares locally, assignment searches outward,
and child locals do not leak into the parent. Python-like indentation does not introduce Python's
assignment semantics.

## Maintaining the grammar

This page is the only copy of the grammar. When the syntax changes, update it together with the
VS Code TextMate grammar, then run `npm run docs:build` from the repository root. The documentation
tests check that the rendered grammar and the example listings stay in sync.
