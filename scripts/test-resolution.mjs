#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const outDir = path.join(root, ".tmp-test-resolution");
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diet-lsp-bin-"));
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diet-lsp-home-"));
for (const name of [
  "basedpyright-langserver",
  "clangd",
  "csharp-ls",
  "vue-language-server",
  "vscode-html-language-server",
  "nixd",
  "custom-lua-lsp",
]) {
  const file = path.join(fakeBin, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, 0o755);
}
fs.mkdirSync(path.join(fakeHome, ".pi", "agent", "pi-diet-lsp"), { recursive: true });
fs.writeFileSync(
  path.join(fakeHome, ".pi", "agent", "pi-diet-lsp", "config.json"),
  JSON.stringify({
    languages: {
      lua_override: {
        languageId: "lua",
        extensions: [".lua"],
        servers: [{ command: "custom-lua-lsp", args: ["--stdio"] }],
      },
    },
  }),
);
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
process.env.HOME = fakeHome;

fs.rmSync(outDir, { recursive: true, force: true });
execFileSync(
  "npx",
  [
    "--yes",
    "tsc",
    "--ignoreConfig",
    "index.ts",
    "--outDir",
    outDir,
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--target",
    "ES2022",
    "--skipLibCheck",
  ],
  { stdio: "inherit", cwd: root, env: process.env },
);

const mod = await import(path.join(outDir, "index.js"));
const { resolveLanguageSpec, serverFor } = mod;

assert.equal(resolveLanguageSpec("x.py")?.languageId, "python");
assert.equal(resolveLanguageSpec("x.cpp")?.languageId, "cpp");
assert.equal(resolveLanguageSpec("x.c")?.languageId, "c");
assert.equal(resolveLanguageSpec("x.cs")?.languageId, "csharp");
assert.equal(resolveLanguageSpec("x.vue")?.languageId, "vue");
assert.equal(resolveLanguageSpec("x.html")?.languageId, "html");
assert.equal(resolveLanguageSpec("x.nix")?.languageId, "nix");
assert.equal(resolveLanguageSpec("x.lua")?.languageId, "lua");
assert.equal(serverFor("x.py")?.command, "basedpyright-langserver");
assert.equal(serverFor("x.cpp")?.command, "clangd");
assert.equal(serverFor("x.cs")?.command, "csharp-ls");
assert.equal(serverFor("x.vue")?.command, "vue-language-server");
assert.equal(serverFor("x.html")?.command, "vscode-html-language-server");
assert.equal(serverFor("x.nix")?.command, "nixd");
assert.equal(serverFor("x.lua")?.command, "custom-lua-lsp");

console.log("pi-diet-lsp resolution tests passed");
fs.rmSync(outDir, { recursive: true, force: true });
fs.rmSync(fakeBin, { recursive: true, force: true });
fs.rmSync(fakeHome, { recursive: true, force: true });
