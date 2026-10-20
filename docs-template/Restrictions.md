# Restrictions

`restrict` narrows raw tools and explicit agent actions. Outside restrictions they are allow-by-default. Generation has no tools at all, and replay further restricts execution to local reads and recorded generation.

## The four forms

| Form | Effect |
| --- | --- |
| `restrict './target/out' { … }` | Reads and writes are allowed only inside the folder. Same as `restrict fs`. |
| `restrict net 'api.example.com' { … }` | Network access is allowed only to the listed hosts. |
| `restrict exec 'npm,git' { … }` | Shell commands are allowed only for the listed executables. |
| `restrict mcp 'docs/search,issues' { … }` | Only the named MCP tools or servers may be called. Servers must be configured with `--mcp`. |

```spl
restrict './out' {
    agent 'Run the report and write it to ./out/report.md'
}

restrict net 'news.ycombinator.com' {
    let page = web_fetch('https://news.ycombinator.com')
}

restrict exec 'git' {
    let diff = shell('git diff --staged')
}
```

The argument is an expression evaluating to a comma-separated string (`'npm,git'`) or a list of strings. An empty list is an error.

Combine clauses with commas. Each clause defaults to `fs` if its kind is omitted. All clauses apply together; repeated kinds intersect just like nested blocks. Commas inside strings or lists remain part of that clause's allowlist.

```spl
restrict './src', net 'example.com', exec 'git', mcp 'docs/search' {
    let review = agent 'Inspect the source and use docs/search for reference material'
}
```

## Two layers of enforcement

**1 · Guidance**

The runtime tells the model about the active restrictions in the prompt, so it plans within them.

**2 · Hard enforcement**

The runtime intercepts *every* file, network and exec call and blocks any that violate the active scopes.

A blocked call raises a `restriction_violation` failure. It is catchable with `try/except`:

`web-digest.spl`

```spl
# Summarize a web page with network access limited to a single host,
# and prove the sandbox holds by catching a blocked request.

restrict net 'news.ycombinator.com' {
    let page = web_fetch('https://news.ycombinator.com')
    let headlines = ? '''
From this HTML list the 10 top stories as a Markdown bullet list: "- title (domain)".
Reply with ONLY the list.
{page}'''

    let themes = ?{len='paragraph'} 'What themes run through these headlines?\n{headlines}'

    try {
        web_fetch('https://example.org')
        fail 'the request to a second host should have been blocked'
    } except err {
        assert err.status_code == 'restriction_violation' "unexpected failure: {err.reason}"
        log("blocked as expected: {err.reason}")
    }
}

success "{headlines}\n\n{themes}"
```

## Nesting

Restrictions are scoped to their block and can be nested. Nested restrictions of the same kind **intersect**: they can only narrow the allowed set, never widen it. Different kinds combine freely.

```spl
restrict exec 'npm' {
    restrict '.' {                       # fs + exec both active
        restrict './src' {               # fs narrowed to ./src (still inside '.')
            shell('npm test')
        }
    }
}
```

## Matching rules

### File system

* Paths are **canonicalized** before checking: made absolute relative to `--cwd`, `..` removed, symbolic links resolved — including dangling links, whose targets are followed so a write cannot escape through them.

* A path is allowed when it is the allowed folder itself or inside it. On Windows the comparison is case-insensitive.

### Network

* `net` matches exact hostnames and `*.example.com` wildcards. Entries may be bare hosts or URLs (the host is extracted; ports are ignored).

* Only `http:` and `https:` URLs are fetched. Redirects are followed manually (at most 5) and the host is **re-checked on every hop**.

* `web_search` is network access too: it queries `html.duckduckgo.com`, so a `restrict net` scope must list that host for searches to work.

### Executables

* `exec` matches the executable *name*. On Windows `.exe`, `.cmd`, `.bat` and `.com` suffixes are ignored.

* Inside a `restrict exec` block, commands must be named *without a path* (`git`, not `/usr/bin/git`).

* Shell commands in pipelines and chains are checked against active restrictions: executables are checked against `restrict exec`, and path-like/URL arguments and redirection targets are checked against active `fs` and `net` scopes.

**Best effort for programs with their own I/O**

The runtime can only inspect what it sees on the command line. A program that touches files or the network on its own (a build tool, a package manager) is limited by its executable name, not by what it does internally.

### MCP servers and tools

Load servers with [`--mcp`](CLI.md#mcp-configuration). A selector such as `docs` or `docs/*` allows every configured tool from that server; `docs/search` allows only its `search` tool. Names are case-sensitive. Nested scopes intersect, and cannot widen the configuration's optional `tools` allowlist.

Disallowed servers and tools are removed before creating each LLM session. Every MCP permission request is checked again before approval; a restriction violation aborts the call like a file or shell violation. Unconfigured MCP servers are always rejected.

MCP servers are trusted programs or remote services: `restrict mcp` controls which tools may be called, not their internal I/O. The `fs`, `net` and `exec` clauses do not sandbox an MCP server's implementation or its configured connection.

## What is covered

| Caller | Checked? |
| --- | --- |
| Raw function calls (`read_file(...)`, `shell(...)`) | yes |
| Tool calls during explicit `agent` operations | yes |
| Generation (`?` / `think`) | No tools exposed; permission attempts abort the call. |
| MCP tools from `--mcp` | configuration and MCP scope checked |
| Any other Copilot permission request | rejected |
| Plain SPL code (arithmetic, `log`, variables) | nothing to restrict |

**Future direction**

Raw tools and agents remain allow-by-default; a global deny-by-default mode is not implemented. Shell command inspection and trusted MCP services are not OS sandboxes.
