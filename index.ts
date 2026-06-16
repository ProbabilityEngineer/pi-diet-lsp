import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";


type Json = any;
type ToolCtx = {
	cwd?: string;
	ui?: {
		setStatus?: (id: string, text: string | undefined) => void;
		setWidget?: (id: string, widget: string[] | undefined, options?: { placement: "belowEditor" }) => void;
		notify?: (message: string, level?: "info" | "warning" | "error") => void;
		theme?: { fg?: (color: "success" | "error" | "accent", text: string) => string };
	};
};

function text(content: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: content }], details };
}

function resolvePath(cwd: string | undefined, p: string) {
	return path.isAbsolute(p) ? p : path.resolve(cwd ?? process.cwd(), p);
}


class LspClient {
	private proc?: ChildProcessWithoutNullStreams;
	private seq = 1;
	private buffer = Buffer.alloc(0);
	private pending = new Map<
		number,
		{ resolve: (v: Json) => void; reject: (e: Error) => void }
	>();
	private diagnostics = new Map<string, Json[]>();
	initialized = false;

	private command: string;
	private args: string[];
	private cwd: string;

	constructor(command: string, args: string[], cwd: string) {
		this.command = command;
		this.args = args;
		this.cwd = cwd;
	}

	start() {
		if (this.proc) return;
		this.proc = spawn(this.command, this.args, {
			cwd: this.cwd,
			stdio: "pipe",
		});
		this.proc.stdout.on("data", (chunk) => this.onData(chunk));
		this.proc.on("error", (error) => {
			for (const pending of this.pending.values()) {
				pending.reject(error instanceof Error ? error : new Error(String(error)));
			}
			this.pending.clear();
			this.proc = undefined;
			this.initialized = false;
		});
		this.proc.on("exit", () => {
			this.proc = undefined;
			this.initialized = false;
		});
	}

	isActive() {
		return Boolean(this.proc) && this.initialized;
	}

	private onData(chunk: Buffer) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (true) {
			const sep = this.buffer.indexOf("\r\n\r\n");
			if (sep < 0) return;
			const header = this.buffer.subarray(0, sep).toString();
			const match = /Content-Length: (\d+)/i.exec(header);
			if (!match) {
				this.buffer = this.buffer.subarray(sep + 4);
				continue;
			}
			const len = Number(match[1]);
			const start = sep + 4;
			if (this.buffer.length < start + len) return;
			const body = this.buffer.subarray(start, start + len).toString();
			this.buffer = this.buffer.subarray(start + len);
			this.handle(JSON.parse(body));
		}
	}

	private handle(msg: Json) {
		if (typeof msg.id === "number" && this.pending.has(msg.id)) {
			const p = this.pending.get(msg.id)!;
			this.pending.delete(msg.id);
			msg.error
				? p.reject(new Error(JSON.stringify(msg.error)))
				: p.resolve(msg.result);
			return;
		}
		if (msg.method === "textDocument/publishDiagnostics") {
			this.diagnostics.set(msg.params.uri, msg.params.diagnostics ?? []);
		}
	}

	private send(payload: Json) {
		this.start();
		const body = JSON.stringify(payload);
		this.proc!.stdin.write(
			`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
		);
	}

	request(method: string, params: Json, timeoutMs = 8000): Promise<Json> {
		const id = this.seq++;
		this.send({ jsonrpc: "2.0", id, method, params });
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(t);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(t);
					reject(e);
				},
			});
		});
	}

	notify(method: string, params: Json) {
		this.send({ jsonrpc: "2.0", method, params });
	}

	async ensure() {
		if (this.initialized) return;
		await this.request("initialize", {
			processId: process.pid,
			rootUri: pathToFileURL(this.cwd).href,
			capabilities: {},
		});
		this.notify("initialized", {});
		this.initialized = true;
	}

	async open(filePath: string) {
		await this.ensure();
		const uri = pathToFileURL(filePath).href;
		const languageId = languageIdFor(filePath);
		const text = await fs.readFile(filePath, "utf8");
		this.notify("textDocument/didOpen", {
			textDocument: { uri, languageId, version: 1, text },
		});
		return uri;
	}

	getDiagnostics(uri?: string) {
		if (uri) return this.diagnostics.get(uri) ?? [];
		return [...this.diagnostics.entries()].flatMap(([u, ds]) =>
			ds.map((d) => ({ ...d, uri: u })),
		);
	}
}

const clients = new Map<string, LspClient>();
let lastUiCtx: ToolCtx | undefined;

type ServerSpec = { command: string; args: string[] };
type LanguageSpec = {
	languageId: string;
	extensions: string[];
	servers: ServerSpec[];
};
type LspConfig = {
	languages?: Record<string, { languageId?: string; extensions?: string[]; servers?: ServerSpec[] }>;
};

const BUILTIN_LANGUAGES: LanguageSpec[] = [
	{
		languageId: "typescript",
		extensions: [".ts", ".tsx", ".mts", ".cts"],
		servers: [{ command: "typescript-language-server", args: ["--stdio"] }],
	},
	{
		languageId: "javascript",
		extensions: [".js", ".jsx", ".mjs", ".cjs"],
		servers: [{ command: "typescript-language-server", args: ["--stdio"] }],
	},
	{
		languageId: "vue",
		extensions: [".vue"],
		servers: [{ command: "vue-language-server", args: ["--stdio"] }],
	},
	{
		languageId: "python",
		extensions: [".py"],
		servers: [
			{ command: "basedpyright-langserver", args: ["--stdio"] },
			{ command: "pyright-langserver", args: ["--stdio"] },
		],
	},
	{ languageId: "go", extensions: [".go"], servers: [{ command: "gopls", args: [] }] },
	{ languageId: "rust", extensions: [".rs"], servers: [{ command: "rust-analyzer", args: [] }] },
	{ languageId: "swift", extensions: [".swift"], servers: [{ command: "sourcekit-lsp", args: [] }] },
	{
		languageId: "c",
		extensions: [".c", ".h"],
		servers: [{ command: "clangd", args: [] }],
	},
	{
		languageId: "cpp",
		extensions: [".cc", ".cp", ".cpp", ".cxx", ".hpp", ".hh", ".hxx", ".ino"],
		servers: [{ command: "clangd", args: [] }],
	},
	{
		languageId: "csharp",
		extensions: [".cs"],
		servers: [{ command: "csharp-ls", args: [] }, { command: "omnisharp", args: ["--languageserver"] }],
	},
	{
		languageId: "java",
		extensions: [".java"],
		servers: [{ command: "jdtls", args: [] }],
	},
	{
		languageId: "kotlin",
		extensions: [".kt", ".kts"],
		servers: [{ command: "kotlin-language-server", args: [] }],
	},
	{
		languageId: "php",
		extensions: [".php"],
		servers: [{ command: "intelephense", args: ["--stdio"] }, { command: "phpactor", args: ["language-server"] }],
	},
	{
		languageId: "ruby",
		extensions: [".rb"],
		servers: [{ command: "ruby-lsp", args: [] }, { command: "solargraph", args: ["stdio"] }],
	},
	{
		languageId: "lua",
		extensions: [".lua"],
		servers: [{ command: "lua-language-server", args: [] }],
	},
	{
		languageId: "nix",
		extensions: [".nix"],
		servers: [{ command: "nixd", args: [] }, { command: "nil", args: [] }],
	},
	{
		languageId: "html",
		extensions: [".html", ".htm"],
		servers: [{ command: "vscode-html-language-server", args: ["--stdio"] }],
	},
	{
		languageId: "css",
		extensions: [".css", ".scss", ".less"],
		servers: [{ command: "vscode-css-language-server", args: ["--stdio"] }],
	},
	{
		languageId: "json",
		extensions: [".json", ".jsonc"],
		servers: [{ command: "vscode-json-language-server", args: ["--stdio"] }],
	},
	{
		languageId: "yaml",
		extensions: [".yml", ".yaml"],
		servers: [{ command: "yaml-language-server", args: ["--stdio"] }],
	},
];

function activeLspCount() {
	return [...clients.values()].filter((client) => client.isActive()).length;
}

function updateLspStatus(ctx: ToolCtx | undefined) {
	if (ctx?.ui) lastUiCtx = ctx;
	const uiCtx = ctx?.ui ? ctx : lastUiCtx;
	const count = activeLspCount();
	const label = count > 0 ? `LSP Active (${count})` : "LSP Inactive";
	const color = count > 0 ? "success" : "error";
	const theme = uiCtx?.ui?.theme;
	let rendered = label;
	try {
		if (typeof theme?.fg === "function") rendered = theme.fg(color, label);
	} catch {
		// Some pi theme methods depend on internal binding during early reload.
		rendered = label;
	}
	uiCtx?.ui?.setStatus?.("pi-diet-lsp", rendered);
	uiCtx?.ui?.setWidget?.("pi-diet-lsp", undefined);
}

function lspConfigPath() {
	const home = process.env.HOME;
	return home ? path.join(home, ".pi", "agent", "pi-diet-lsp", "config.json") : undefined;
}

function normalizeSpec(spec: LanguageSpec): LanguageSpec {
	return {
		languageId: spec.languageId,
		extensions: spec.extensions.map((ext) => ext.toLowerCase()),
		servers: spec.servers.map((server) => ({ command: server.command, args: [...server.args] })),
	};
}

function loadConfigLanguages() {
	const file = lspConfigPath();
	if (!file || !fsSync.existsSync(file)) return [] as LanguageSpec[];
	try {
		const parsed = JSON.parse(fsSync.readFileSync(file, "utf8")) as LspConfig;
		return Object.values(parsed.languages ?? {})
			.filter((entry): entry is NonNullable<LspConfig["languages"]>[string] => Boolean(entry?.languageId && entry?.servers?.length))
			.map((entry) =>
				normalizeSpec({
					languageId: entry.languageId!,
					extensions: entry.extensions ?? [],
					servers: entry.servers ?? [],
				}),
			);
	} catch {
		return [];
	}
}

function allLanguageSpecs() {
	return [...loadConfigLanguages(), ...BUILTIN_LANGUAGES.map(normalizeSpec)];
}

export function commandAvailable(command: string) {
	const pathValue = process.env.PATH ?? "";
	const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	return pathValue.split(path.delimiter).some((dir) =>
		extensions.some((ext) => fsSync.existsSync(path.join(dir, `${command}${ext}`))),
	);
}

export function resolveLanguageSpec(file: string) {
	const ext = path.extname(file).toLowerCase();
	return allLanguageSpecs().find((spec) => spec.extensions.includes(ext));
}

function languageIdFor(file: string) {
	return resolveLanguageSpec(file)?.languageId ?? (path.extname(file).replace(/^\./, "") || "plaintext");
}

export function serverFor(file: string): ServerSpec | undefined {
	const spec = resolveLanguageSpec(file);
	if (!spec) return undefined;
	return spec.servers.find((server) => commandAvailable(server.command)) ?? spec.servers[0];
}

async function getClient(cwd: string, filePath: string) {
	const spec = serverFor(filePath);
	if (!spec)
		throw new Error(
			`No lightweight LSP server mapping for ${path.extname(filePath) || filePath}`,
		);
	const key = `${cwd}:${spec.command}`;
	let c = clients.get(key);
	if (!c) {
		c = new LspClient(spec.command, spec.args, cwd);
		clients.set(key, c);
	}
	return c;
}

function workspaceProbeFile(cwd: string) {
	const basenames = ["src/index", "index", "src/main", "main", "src/app", "app"];
	const exts = [...new Set(BUILTIN_LANGUAGES.flatMap((spec) => spec.extensions))];
	const candidates = basenames.flatMap((base) => exts.map((ext) => `${base}${ext}`));
	const found = candidates
		.map((candidate) => path.join(cwd, candidate))
		.find((candidate) => fsSync.existsSync(candidate) && serverFor(candidate));
	if (!found) {
		throw new Error(
			"Workspace symbol search needs a source-file language server probe, but no supported source file was found. Provide filePath for document symbols instead.",
		);
	}
	return found;
}

function lspPos(line: number, character: number) {
	return { line: Math.max(0, line - 1), character: Math.max(0, character - 1) };
}
const MAX_JSON_ITEMS = 80;
const MAX_TEXT_CHARS = 24_000;

function truncateText(value: string, max = MAX_TEXT_CHARS) {
	return value.length <= max
		? value
		: `${value.slice(0, max)}\n\n[truncated ${value.length - max} chars; refine query or position]`;
}

function pretty(value: Json) {
	return truncateText(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function relativeUri(cwd: string, uri: string | undefined) {
	if (!uri?.startsWith("file://")) return uri ?? "";
	try {
		const file = decodeURIComponent(new URL(uri).pathname);
		return path.relative(cwd, file) || path.basename(file);
	} catch {
		return uri;
	}
}

function compactRange(range: any) {
	const start = range?.start;
	if (!start) return "";
	return `${Number(start.line ?? 0) + 1}:${Number(start.character ?? 0) + 1}`;
}

function compactLocation(cwd: string, location: any) {
	const loc = Array.isArray(location) ? location[0] : location;
	return `${relativeUri(cwd, loc?.uri ?? loc?.targetUri)}:${compactRange(loc?.range ?? loc?.targetRange)}`;
}

function compactSymbol(cwd: string, symbol: any) {
	const loc = symbol.location ?? { uri: symbol.uri, range: symbol.range ?? symbol.selectionRange };
	const container = symbol.containerName ? ` ${symbol.containerName}.` : " ";
	return `${symbol.name ?? "<unnamed>"}${container}${compactLocation(cwd, loc)}`;
}

function formatLimitedList(cwd: string, items: any[], compact: (cwd: string, item: any) => string) {
	const total = items.length;
	const shown = items.slice(0, MAX_JSON_ITEMS).map((item) => compact(cwd, item));
	const suffix = total > shown.length ? `\n... ${total - shown.length} more; refine query` : "";
	return `${shown.join("\n")}${suffix}`;
}

function requireQuery(query: unknown) {
	const value = String(query ?? "").trim();
	if (!value) throw new Error("query is required when filePath is omitted");
	return value;
}

const LSP_PROMPT_SNIPPET =
	"Tool routing: use LSP first for known symbols, definitions, references, hover/types, diagnostics, and callsite tracing.";
const LSP_PROMPT_GUIDELINES = [
	"Use LSP tools as the first choice for known symbols, definitions, references, hover/types, diagnostics, and callsite tracing; use Semble for behavior discovery, AST for structural patterns, and grep for exact literals.",
];

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		updateLspStatus(ctx as ToolCtx);
	});
	pi.registerTool({
		name: "lsp_definition",
		label: "LSP Definition",
		description: "Jump to definition at a 1-based file position.",
		promptSnippet: LSP_PROMPT_SNIPPET,
		promptGuidelines: LSP_PROMPT_GUIDELINES,
		parameters: Type.Object({
			filePath: Type.String(),
			line: Type.Number(),
			character: Type.Number(),
		}),
		async execute(
			_id: string,
			p: any,
			_s: AbortSignal,
			_u: unknown,
			ctx: ToolCtx,
		) {
			const file = resolvePath(ctx.cwd, p.filePath);
			const cwd = ctx.cwd ?? process.cwd();
			const c = await getClient(cwd, file);
			const uri = await c.open(file);
			updateLspStatus(ctx);
			const result = await c.request("textDocument/definition", {
				textDocument: { uri },
				position: lspPos(p.line, p.character),
			});
			return text(pretty(result));
		},
	} as any);

	pi.registerTool({
		name: "lsp_references",
		label: "LSP References",
		description: "Find references at a 1-based file position.",
		promptSnippet: LSP_PROMPT_SNIPPET,
		promptGuidelines: LSP_PROMPT_GUIDELINES,
		parameters: Type.Object({
			filePath: Type.String(),
			line: Type.Number(),
			character: Type.Number(),
			includeDeclaration: Type.Optional(Type.Boolean()),
		}),
		async execute(
			_id: string,
			p: any,
			_s: AbortSignal,
			_u: unknown,
			ctx: ToolCtx,
		) {
			const file = resolvePath(ctx.cwd, p.filePath);
			const cwd = ctx.cwd ?? process.cwd();
			const c = await getClient(cwd, file);
			const uri = await c.open(file);
			updateLspStatus(ctx);
			const result = await c.request("textDocument/references", {
				textDocument: { uri },
				position: lspPos(p.line, p.character),
				context: { includeDeclaration: p.includeDeclaration ?? true },
			});
			return text(Array.isArray(result) ? formatLimitedList(cwd, result, compactLocation) : pretty(result));
		},
	} as any);

	pi.registerTool({
		name: "lsp_hover",
		label: "LSP Hover",
		description: "Show hover/type info at a 1-based file position.",
		promptSnippet: LSP_PROMPT_SNIPPET,
		promptGuidelines: LSP_PROMPT_GUIDELINES,
		parameters: Type.Object({
			filePath: Type.String(),
			line: Type.Number(),
			character: Type.Number(),
		}),
		async execute(
			_id: string,
			p: any,
			_s: AbortSignal,
			_u: unknown,
			ctx: ToolCtx,
		) {
			const file = resolvePath(ctx.cwd, p.filePath);
			const cwd = ctx.cwd ?? process.cwd();
			const c = await getClient(cwd, file);
			const uri = await c.open(file);
			updateLspStatus(ctx);
			const result = await c.request("textDocument/hover", {
				textDocument: { uri },
				position: lspPos(p.line, p.character),
			});
			return text(pretty(result));
		},
	} as any);

	pi.registerTool({
		name: "lsp_symbols",
		label: "LSP Symbols",
		description:
			"List document symbols for a file, or workspace symbols when filePath is omitted and query is provided.",
		promptSnippet: LSP_PROMPT_SNIPPET,
		promptGuidelines: LSP_PROMPT_GUIDELINES,
		parameters: Type.Object({
			filePath: Type.Optional(Type.String()),
			query: Type.Optional(Type.String()),
		}),
		async execute(
			_id: string,
			p: any,
			_s: AbortSignal,
			_u: unknown,
			ctx: ToolCtx,
		) {
			const cwd = ctx.cwd ?? process.cwd();
			if (!p.filePath) {
				const q = requireQuery(p.query);
				const probeFile = workspaceProbeFile(cwd);
				const c = await getClient(cwd, probeFile);
				await c.open(probeFile);
				updateLspStatus(ctx);
				const result = await c.request("workspace/symbol", { query: q });
				return text(Array.isArray(result) ? formatLimitedList(cwd, result, compactSymbol) : pretty(result));
			}

			const file = resolvePath(ctx.cwd, p.filePath);
			const c = await getClient(cwd, file);
			const uri = await c.open(file);
			updateLspStatus(ctx);
			const result = await c.request("textDocument/documentSymbol", {
				textDocument: { uri },
			});
			const q = String(p.query ?? "").toLowerCase();
			const filtered =
				q && Array.isArray(result)
					? result.filter((s: any) =>
							JSON.stringify(s).toLowerCase().includes(q),
						)
					: result;
			return text(Array.isArray(filtered) ? formatLimitedList(cwd, filtered, compactSymbol) : pretty(filtered));
		},
	} as any);

	pi.registerTool({
		name: "lsp_diagnostics",
		label: "LSP Diagnostics",
		description: "Open a file in LSP and return current diagnostics.",
		promptSnippet: LSP_PROMPT_SNIPPET,
		promptGuidelines: LSP_PROMPT_GUIDELINES,
		parameters: Type.Object({
			filePath: Type.String(),
			waitMs: Type.Optional(Type.Number()),
		}),
		async execute(
			_id: string,
			p: any,
			_s: AbortSignal,
			_u: unknown,
			ctx: ToolCtx,
		) {
			const file = resolvePath(ctx.cwd, p.filePath);
			const cwd = ctx.cwd ?? process.cwd();
			const c = await getClient(cwd, file);
			const uri = await c.open(file);
			updateLspStatus(ctx);
			await new Promise((r) =>
				setTimeout(r, Math.max(0, Math.min(5000, p.waitMs ?? 800))),
			);
			return text(pretty(c.getDiagnostics(uri)));
		},
	} as any);
}
