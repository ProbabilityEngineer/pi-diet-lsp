---
id: pdl-iru2
status: in_progress
deps: []
links: []
created: 2026-06-16T10:28:46Z
type: feature
priority: 2
assignee: ProbabilityEngineer
---
# Add configurable scalable LSP server registry

Replace the current small hardcoded server mapping with a more scalable design: broader built-in defaults, PATH-aware command selection for equivalent servers, and user-configurable overrides for language/server mappings.

## Design

- Keep lightweight default behavior.
- Add broader built-in mappings for common languages (including C/C++ via clangd).
- Prefer available commands on PATH when multiple equivalent servers are supported.
- Add config loading from a user-controlled file such as ~/.pi/agent/pi-diet-lsp/config.json with per-language command/args overrides.
- Preserve existing explicit tool behavior and low prompt overhead.

## Acceptance Criteria

- Python still prefers basedpyright-langserver then falls back to pyright-langserver.
- C/C++ files use clangd.
- Built-in mappings cover more common languages.
- Config overrides can replace command/args for a language.
- README documents defaults and config.
- Tests/validation demonstrate resolution behavior.
- Package version is bumped and tagged for release.


## Notes

**2026-06-16T10:31:59Z**

Implemented broader built-in LSP registry, PATH-aware server candidate selection, config overrides from ~/.pi/agent/pi-diet-lsp/config.json, C/C++ clangd support, README/docs updates, and a resolution validation script exercised by npm run test:resolution.
