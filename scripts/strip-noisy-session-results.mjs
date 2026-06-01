#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const DEFAULT_TOOLS = new Set(["lsp_symbols", "lsp_references", "lsp_definition"]);
const DEFAULT_MAX_CHARS = 64_000;

function usage() {
  console.error(`Usage: node scripts/strip-noisy-session-results.mjs <file-or-dir> [--out DIR] [--max-chars N] [--tool NAME] [--in-place-backup]\n\nWrites *.rescued.jsonl copies by default. With --in-place-backup, writes a .bak copy then replaces the original.`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (!args.length) usage();
const target = args.shift();
let outDir = null;
let maxChars = DEFAULT_MAX_CHARS;
let inPlaceBackup = false;
const tools = new Set(DEFAULT_TOOLS);

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--out") outDir = args[++i];
  else if (arg === "--max-chars") maxChars = Number(args[++i]);
  else if (arg === "--tool") tools.add(args[++i]);
  else if (arg === "--in-place-backup") inPlaceBackup = true;
  else usage();
}

if (!target || !Number.isFinite(maxChars) || maxChars < 1) usage();

function filesFor(input) {
  const stat = fs.statSync(input);
  if (stat.isFile()) return [input];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(input)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(input, name));
}

function contentTextLength(content) {
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, part) => sum + (typeof part?.text === "string" ? part.text.length : 0), 0);
}

function likelyHugeLspJson(text) {
  return text.includes('"uri": "file://') && text.includes('"range"') && text.includes('"line"') && text.includes('"character"');
}

function stripEntry(entry, stats) {
  if (entry?.type !== "message") return entry;
  const msg = entry.message;
  if (msg?.role !== "toolResult") return entry;
  if (!tools.has(msg.toolName)) return entry;
  const chars = contentTextLength(msg.content);
  const joined = Array.isArray(msg.content)
    ? msg.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
    : "";
  if (chars <= maxChars && !likelyHugeLspJson(joined)) return entry;

  stats.stripped += 1;
  stats.removedChars += chars;
  stats.byTool[msg.toolName] = (stats.byTool[msg.toolName] ?? 0) + 1;
  return {
    ...entry,
    message: {
      ...msg,
      content: [{
        type: "text",
        text: `[stripped noisy ${msg.toolName} result: ${chars} chars removed; original contained verbose LSP file URI/range JSON]`,
      }],
      details: {
        ...(msg.details ?? {}),
        strippedBy: "strip-noisy-session-results",
        originalChars: chars,
      },
    },
  };
}

function outputPath(file) {
  if (inPlaceBackup) return file;
  const base = path.basename(file, ".jsonl") + ".rescued.jsonl";
  return path.join(outDir ?? path.dirname(file), base);
}

for (const file of filesFor(target)) {
  const raw = fs.readFileSync(file, "utf8");
  const stats = { lines: 0, stripped: 0, removedChars: 0, parseErrors: 0, byTool: {} };
  const output = raw.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    stats.lines += 1;
    try {
      return JSON.stringify(stripEntry(JSON.parse(line), stats));
    } catch {
      stats.parseErrors += 1;
      return line;
    }
  }).join("\n");

  if (inPlaceBackup) {
    fs.copyFileSync(file, `${file}.bak`);
  } else if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const out = outputPath(file);
  fs.writeFileSync(out, output);
  console.log(JSON.stringify({ file, out, ...stats }, null, 2));
}
