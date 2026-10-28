# Grammar

The complete syntax of SPL documents and the code inside `spl` fences, in EBNF. Modifier names are
checked while parsing; modifier values and schemas are checked at runtime.

## Notation

`{ x }` repeats, `[ x ]` is optional, `|` separates alternatives, and quoted text is literal.
EBNF repetition braces are notation, not SPL block delimiters.

**Breaking change:** blocks start with `:` on the header's line, followed by a newline and an
indented, nonempty body. Replace old block braces with this layout; expand inline suites onto
separate lines and use `pass` for empty bodies. Dictionaries `{...}` and interpolation `{expr}`
are unchanged. Anonymous value-producing blocks use the same bare-colon syntax.

Indentation uses spaces only (4 recommended). The lexer emits `INDENT` when a block's indentation
increases and `DEDENT` when it decreases, including at end of input. Tabs in indentation,
unexpected indentation, missing bodies and dedents not matching a prior indentation level are
syntax errors. Blank and comment-only lines are ignored and cannot satisfy a block's body.
`elif`, `else` and `except` align with their opening statement.

`NL` is a significant logical newline. Newlines inside `()`, `[]` and dictionaries are
insignificant and do not produce indentation tokens; a trailing `\` explicitly continues a line.
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
blockquote     = ">" , text , { NL , ">" , text } ;
                 (* natural language; the agent acts through shared-scope tools,
                    not by submitting generated SPL *)
commentary     = ? any other Markdown ? ;

(* Programs *)
program        = { NL } , { directive , simple_end } , { statement } , EOF ;
directive      = "@" , "(" , "model" , "=" , plain_string , [ "," ] , ")" ;
                 (* raw parse API only; documents use frontmatter model *)
statement      = simple_line | compound_stmt ;
simple_line    = simple_stmt , { ";" , simple_stmt } , [ ";" ] , simple_end ;
simple_end     = NL | ? end of input, without consuming EOF ?
               | ? boundary immediately after a block-valued expression's DEDENT ? ;
compound_stmt  = if_stmt | for_stmt | while_stmt | def_stmt | try_stmt
               | guidance_stmt | restrict_stmt | block ;
block          = ":" , NL , INDENT , statement , { statement } , DEDENT ;

simple_stmt    = declaration | assignment
               | "return" , [ expr ] | "success" , [ expr ]
               | "assert" , expr , [ expr ] | "fail" , expr
               | "break" | "continue" | "pass" | expr ;
                 (* a compound statement or block-valued expression is not an
                    inline semicolon suite; its body must use block layout *)
declaration    = "let" , NAME , "=" , expr ;
assignment     = target , ( "=" | "+=" | "-=" | "*=" | "/=" | "//=" | "%=" ) , expr ;
target         = NAME | postfix , "." , NAME | postfix , "[" , expr , "]" ;
if_stmt        = "if" , expr , block , { "elif" , expr , block } , [ "else" , block ] ;
for_stmt       = "for" , NAME , { "," , NAME } , "in" , expr , block ;
while_stmt     = "while" , expr , block ;
def_stmt       = "def" , NAME , "(" , [ NAME , { "," , NAME } , [ "," ] ] , ")" , block ;
try_stmt       = "try" , block , "except" , NAME , block ;
guidance_stmt  = ( "enforce" | "forbid" ) , expr , block ;
restrict_stmt  = "restrict" , restrict_clause , { "," , restrict_clause } , block ;
restrict_clause = [ "fs" | "net" | "exec" | "mcp" ] , expr ;

(* Every block is a lexical child scope; let declares locally, assignment updates the
   nearest declaration. Blocks and if yield their final expression, otherwise None.
   {} is an empty dict; a bare-colon block containing pass yields None.
   All bodies are nonempty. Functions need an explicit return. *)

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

(* Unknown or duplicate modifiers are syntax errors. human takes no modifiers and
   requires a checkpoint run. Tools are ordinary functions: read_file, write_file,
   web_fetch, web_search, shell. *)

string         = [ "r" ] , quote , { char | escape | interpolation } , closing_quote ;
quote          = "'" | '"' | "'''" | '"""' ;
plain_string   = string_without_interpolation ;
escape         = "\" , ( "n" | "t" | "r" | "0" | "\" | "'" | '"' | "{" | "}" ) ;
interpolation  = "{" , expr , "}" ;
NUMBER         = digit+ , [ "." , digit+ ] , [ ( "e" | "E" ) , [ "+" | "-" ] , digit+ ] ;
NAME           = ( letter | "_" ) , { letter | digit | "_" } ;
NL             = ? logical newline outside delimiters and explicit continuations ? ;
INDENT         = ? increase in leading spaces after a block header ? ;
DEDENT         = ? return to a previous indentation level, including at EOF ? ;
EOF            = ? end of input ? ;

(* "{{" and "}}" are literal braces; raw strings have no escapes or interpolation.
   Blank/comment-only lines produce no indentation changes and are ignored.
   Indentation tabs, inline suites, empty bodies and inconsistent dedents are errors.
   $env and $args are read-only; other $-names are syntax errors.
   Reserved words: let if elif else for in while def return try except assert fail success
   enforce forbid restrict ask think agent human break continue pass and or not True False None. *)
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
