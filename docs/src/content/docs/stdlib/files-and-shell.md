---
title: Files, Shell & Host I/O
description: Server and universal stdlib modules — std/fs, std/proc, std/os, std/http, std/clock, std/crypto, and std/console.
---

SPL splits its host standard library into **universal** modules (Browser + Node 22+ / Bun / Deno) and **server-only** modules (Node / Bun / Deno).

## Filesystem (`std/fs`)

| Function | Signature | Description |
|---|---|---|
| `fs.read` | `(path: Str) -> Result<Str, Str>` | Read UTF-8 file contents |
| `fs.write` | `(path: Str, data: Str) -> Result<Unit, Str>` | Write UTF-8 text to a file |
| `fs.stat` | `(path: Str) -> Result<FileStat, Str>` | File metadata (`is_file`, `is_dir`, `size`, `mtime_ms`) |
| `fs.list_dir` | `(dir: Str) -> Result<Array<Str>, Str>` | List directory entry names |
| `fs.mkdir` | `(dir: Str) -> Result<Unit, Str>` | Create directory recursively (`mkdir -p`) |
| `fs.remove` | `(path: Str) -> Result<Unit, Str>` | Remove file or directory recursively |
| `fs.join_path` | `(a: Str, b: Str) -> Str` | Join path segments |
| `fs.ext_name` | `(p: Str) -> Str?` | Extract file extension without leading dot |

```splx
import fs from "std/fs"

fs.mkdir("./tmp-work")?
fs.write("./tmp-work/hello.txt", "Hello from SPL!")?
let text = fs.read("./tmp-work/hello.txt")?
let st = fs.stat("./tmp-work/hello.txt")?
print("${text} (${st.size} bytes)")
fs.remove("./tmp-work")?
```

## Shell & Processes (`std/proc`)

- `proc.shell(command: Str) -> Result<ExecOutput, Str>`: runs a cross-platform shell command (`cmd /c` on Windows, `sh -c` on Unix).
- `proc.exec(cmd: Str, args: Array<Str>, opts: { cwd: Str?, timeout_ms: Int? }) -> Result<ExecOutput, Str>`: spawns a process directly with a safe argument array (no shell injection), custom working directory, and timeout.

```splx
import proc from "std/proc"

let sh = proc.shell("echo hello from shell")?
print("exit=${sh.code}, out=${sh.stdout.trim()}")

let res = proc.exec("node", ["-v"], { cwd: None, timeout_ms: Some(5000) })?
print("node version: " + res.stdout.trim())
```

## OS Environment (`std/os`)

- `os.env(key: Str) -> Str?` — read an environment variable safely
- `os.args() -> Array<Str>` — CLI arguments
- `os.cwd() -> Str` — current working directory
- `os.platform() -> Str` — host OS (`"win32"`, `"linux"`, `"darwin"`)
- `os.exit(code: Int) -> Unit` — terminate process with exit code

## Universal Modules (`std/http`, `std/clock`, `std/crypto`, `std/console`)

- **`std/http`**: `http.fetch(req)`, `http.get(url)`, `http.post_json(url, body)`
- **`std/clock`**: `clock.now_ms()`, `clock.sleep(ms)`
- **`std/crypto`**: `crypto.random_bytes(n)`, `crypto.random_hex(n)`
- **`std/console`**: `console.log(v)`, `console.warn(v)`, `console.error(v)`
