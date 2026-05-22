---
id: pll-9i2j
status: closed
deps: []
links: []
created: 2026-05-22T21:17:54Z
type: feature
priority: 2
assignee: ProbabilityEngineer
---
# Add workspace symbol search to lsp_symbols

Extend lsp_symbols to support workspace/symbol queries when filePath is omitted, avoiding a new tool while improving known-symbol unknown-file lookup.

## Acceptance Criteria

lsp_symbols filePath remains document-symbol compatible; lsp_symbols without filePath requires query and calls workspace/symbol; README documents both modes; npm run lint passes.

