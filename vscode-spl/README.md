# SPL v5 VS Code Syntax Extension

Syntax highlighting and editor configuration for:
- **`.spl`** — Semantic Prompt Language v5 source files (keywords, types, nullability operators, template `${...}` interpolation, and distinct coloring for leaf effect namespaces like `model.ask`, `model.decide`, `web.*`, `fs.*`, `shell.run`, `tool.*`, `mcp.*`).
- **`.splb`** — Canonical `SPLB 5` textual stack bytecode (sections, function headers, PC addresses, effect vs control-flow vs stack opcodes, `c0`/`s0` pool refs, and `FN ... END` folding).

## Install

### Quick Install (npm — Windows, macOS, Linux)

Auto-detects installed editors (VS Code, VS Code Insiders, Cursor, Antigravity, Windsurf):

```bash
npm run install:vscode
```

Uninstall:

```bash
npm run uninstall:vscode
```

### Windows (PowerShell)

```powershell
# Auto-detect installed editors
.\vscode-spl\install.ps1

# Target a specific editor (vscode | insiders | cursor | antigravity | windsurf | all)
.\vscode-spl\install.ps1 -Editor vscode

# Uninstall
.\vscode-spl\install.ps1 -Uninstall
```

### macOS / Linux (Bash)

```bash
./vscode-spl/install.sh
./vscode-spl/install.sh --editor vscode
./vscode-spl/install.sh --uninstall
```

After installing, reload your editor (`Ctrl+Shift+P` → **Developer: Reload Window**).

### Package as `.vsix` (Optional)

```bash
cd vscode-spl
npx @vscode/vsce package
code --install-extension spl-lang-v5-vscode-5.0.0.vsix
```
