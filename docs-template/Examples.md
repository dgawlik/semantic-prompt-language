# Examples

Every example is a runnable `.spl` file in [lang/examples](../lang/examples/). Run them from the
`lang` folder, for example `spl run examples/hi.spl`: the relative paths they read and write
resolve against the working directory. The first lines of each example show its command and arguments.

This page is generated from the files with [`spl doc`](CLI.md#spl-doc). Comments are the prose,
top-level code is listed as written, and each top-level block is a callout with its mode, its
settings and its instruction. Check any of them without a model: `spl check examples/hi.spl`.

## Getting started

Blocks, references, typed outputs and human input, a few lines at a time.

```spl-doc
hi.spl
basics.spl
is-friday.spl
env.spl
rgb.spl
rgb2.spl
color-poem.spl
answer.spl
```

## Control flow and guidance

Blocks inside `if` and loops, outputs that assign existing variables, decisions, guidance and sampling.

```spl-doc
conditional-workflows.spl
goto.spl
decision.spl
enforce.spl
randomness.spl
```

## No model required

These run offline, without credentials.

```spl-doc
typed-data.spl
markdown.spl
deterministic/node.spl
deterministic/enumsStructs.spl
deterministic/types.spl
imports/run.spl
imports/math.spl
```

## Developer workflows

Agents and exact tools around a repository: reviews, release notes, issue triage and generated code.

```spl-doc
code-review.spl
release-notes.spl
triage-issues.spl
codegen.spl
repo.spl
```

## Documents and data

Typed extraction and generation, with code checking what the model returned.

```spl-doc
extract-invoice.spl
types.spl
translate-docs.spl
incident-report.spl
```

## Research and operations

The web, MCP servers, state between runs and a person in the loop.

```spl-doc
web-digest.spl
mcp.spl
journal.spl
human-review.spl
```
