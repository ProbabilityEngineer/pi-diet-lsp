# pi-diet-lsp

On-demand LSP code-intelligence tools for Pi without automatic diagnostics or context injection.

`pi-diet-lsp` gives Pi agents focused, model-visible Language Server Protocol tools for definitions, references, symbols, hover/type information, and diagnostics. It keeps the surface compact and explicit: no automatic diagnostics pipeline, no context injection, no read guard, no skills, and no session-start bootstrap. Agents call the tools when precise code intelligence is useful.

This is intentionally different from automatic LSP feedback extensions: `pi-diet-lsp` favors low prompt overhead and explicit tool calls over continuously appending diagnostics to every edit.

## Tools

- `lsp_definition` — jump to definition at a 1-based file position
- `lsp_references` — find references at a 1-based file position
- `lsp_symbols` — document symbols for a file, or workspace symbols by query
- `lsp_hover` — show hover/type info at a 1-based file position
- `lsp_diagnostics` — open a file in LSP and return current diagnostics

`lsp_symbols` has two modes:

```json
{ "filePath": "src/index.ts", "query": "optional-filter" }
{ "query": "SymbolName" }
```

With `filePath`, it returns document symbols. Without `filePath`, it uses LSP workspace symbol search.

Large symbol/reference results are compacted and capped to avoid runaway context growth.

## Install

From npm, after publication:

```bash
pi install npm:pi-diet-lsp
```

From GitHub:

```bash
pi install git:github.com/ProbabilityEngineer/pi-diet-lsp
```

For project-local install, add `-l`:

```bash
pi install -l git:github.com/ProbabilityEngineer/pi-diet-lsp
```

For local testing:

```bash
pi -e ./index.ts
```

## Runtime requirements

LSP tools use language servers from `PATH`:

- TypeScript/JavaScript: `typescript-language-server --stdio`
- Python: `pyright-langserver --stdio`
- Go: `gopls`
- Rust: `rust-analyzer`
- Swift: `sourcekit-lsp`
- JSON: `vscode-json-language-server --stdio`
- YAML: `yaml-language-server --stdio`

## Prompt overhead

`pi-diet-lsp` avoids automatic context injection. It registers compact tools and guidance, then waits for agents to call LSP tools explicitly when code intelligence is relevant.
