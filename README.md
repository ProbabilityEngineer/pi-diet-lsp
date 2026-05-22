# pi-lsp-lite

Lightweight pi extension with focused LSP code-intelligence tools:

- `lsp_definition`
- `lsp_references`
- `lsp_symbols` — document symbols for a file, or workspace symbols by query
- `lsp_hover`
- `lsp_diagnostics`

No automatic lint pipeline, no context injection, no read guard, no non-actionable widget, no skills, no session-start bootstrap.

`lsp_symbols` has two modes:

```json
{ "filePath": "src/index.ts", "query": "optional-filter" }
{ "query": "SymbolName" }
```

With `filePath`, it returns document symbols. Without `filePath`, it uses LSP workspace symbol search.

## Install

```bash
pi install git:github.com/ProbabilityEngineer/pi-lsp-lite
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

This intentionally avoids pi-lens' large installer/bootstrap layer.
