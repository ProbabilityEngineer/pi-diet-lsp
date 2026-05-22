# pi-lsp-lite

Lightweight pi extension with only the code-intelligence tools I actually want available every turn:

- `ast_grep_search`
- `ast_grep_replace`
- `lsp_definition`
- `lsp_references`
- `lsp_symbols`
- `lsp_hover`
- `lsp_diagnostics`

No automatic lint pipeline, no context injection, no read guard, no widget, no skills, no session-start bootstrap.

## Install

```bash
pi install git:github.com/apmantza/pi-lsp-lite
```

For local testing:

```bash
pi -e ./index.ts
```

## Runtime requirements

`ast_grep_*` uses `sg` from `@ast-grep/cli` if available, otherwise falls back to `npx --yes @ast-grep/cli`.

LSP tools use language servers from `PATH`:

- TypeScript/JavaScript: `typescript-language-server --stdio`
- Python: `pyright-langserver --stdio`
- Go: `gopls`
- Rust: `rust-analyzer`
- JSON: `vscode-json-language-server --stdio`
- YAML: `yaml-language-server --stdio`

This intentionally avoids pi-lens' large installer/bootstrap layer.
