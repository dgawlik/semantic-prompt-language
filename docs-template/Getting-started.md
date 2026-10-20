

# Getting started

Orchestrate conversations with LLM, validate the responses, enforce schemas
and quickly iterate. Download npm package or use directly with npx.

## Requirements

* Node 20+
* Copilot account -> run `npx spl-lang login`


*note*

Only value passed to `success` (or failure) goes to stdout. Logging including model and 
reasoning effort go to stderr so results can be piped safely.


## Quick test

Create `hello.spl`

```spl
@{model='gpt-6-luna'}


let isFriday = ?{fmt='json'} 'Is today Friday? Return true or false.'
if isFriday {
    success 'Today is Friday!'
} else {
    success ?'Complain in original way'
}
```

Run

`npx spl-lang .\lang\examples\is-friday.spl`

## Exit codes


Code	Meaning
0	The script finished (reached success, a top-level return or the end).
1	Uncaught failure — the failure payload is printed to stdout.
2	Syntax error or command-line usage error.
70	Internal interpreter error.


##  Repository tour

Path	Contents
LANG-PRD.md	Product requirements — the language specification.
lang/	The interpreter: src/, tests/, examples/ and docs/syntax.ebnf.
vscode/	VS Code extension: TextMate grammar, snippets, language configuration, tests.
docs/	This documentation site.