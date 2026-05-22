import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const LANGS = [
	"bash",
	"c",
	"cpp",
	"csharp",
	"css",
	"elixir",
	"go",
	"haskell",
	"html",
	"java",
	"javascript",
	"json",
	"kotlin",
	"lua",
	"nix",
	"php",
	"python",
	"ruby",
	"rust",
	"scala",
	"solidity",
	"swift",
	"tsx",
	"typescript",
	"yaml",
] as const;
const MAX_OUTPUT = 60_000;

type Json = any;
type ToolCtx = {
	cwd?: string;
	ui?: {
		setStatus?: (id: string, text: string | undefined) => void;
		setWidget?: (id: string, widget: string[] | undefined, options?: { placement: "belowEditor" }) => void;
		theme?: { fg?: (color: "success" | "error" | "accent", text: string) => string };
	};
};

function text(content: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: content }], details };
}

function resolvePath(cwd: string | undefined, p: string) {
	return path.isAbsolute(p) ? p : path.resolve(cwd ?? process.cwd(), p);
}

async function run(
	cmd: string,
	args: string[],
	cwd?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return await new Promise((resolve) => {
		const child = spawn(cmd, args, { cwd: cwd ?? process.cwd(), shell: false });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += String(d);
			if (stdout.length > MAX_OUTPUT) child.kill();
		});
		child.stderr.on("data", (d) => {
			stderr += String(d);
			if (stderr.length > MAX_OUTPUT) child.kill();
		});
		child.on("error", (err) =>
			resolve({ code: 127, stdout, stderr: String(err) }),
		);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

async function sg(args: string[], cwd?: string) {
	let res = await run("sg", args, cwd);
	if (res.code === 127)
		res = await run("npx", ["--yes", "@ast-grep/cli", ...args], cwd);
	return res;
}

function formatSgJson(stdout: string, stderr: string) {
	const raw = stdout.trim();
	if (!raw) return stderr.trim() || "No matches";
	try {
		const data = JSON.parse(raw);
		const arr = Array.isArray(data) ? data : [data];
		if (arr.length === 0) return "No matches";
		return arr
			.slice(0, 100)
			.map((m: any) => {
				const file = m.file ?? m.path ?? "?";
				const start = m.range?.start;
				const line = typeof start?.line === "number" ? start.line + 1 : "?";
				const body = String(m.text ?? m.lines ?? "").trim();
				return `${file}:${line}\n${body}`;
			})
			.join("\n\n---\n");
	} catch {
		return raw || stderr.trim();
	}
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
	uiCtx?.ui?.setStatus?.("pi-lsp-lite-lsp", rendered);
	uiCtx?.ui?.setWidget?.("pi-lsp-lite", [`pi-lsp-lite: ${rendered}`], {
		placement: "belowEditor",
	});
}

function languageIdFor(file: string) {
	const ext = path.extname(file);
	if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext))
		return ext.includes("ts") ? "typescript" : "javascript";
	if (ext === ".py") return "python";
	if (ext === ".go") return "go";
	if (ext === ".rs") return "rust";
	if (ext === ".swift") return "swift";
	if ([".json", ".jsonc"].includes(ext)) return "json";
	if ([".yml", ".yaml"].includes(ext)) return "yaml";
	return ext.replace(/^\./, "") || "plaintext";
}

function serverFor(
	file: string,
): { command: string; args: string[] } | undefined {
	const ext = path.extname(file);
	if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext))
		return { command: "typescript-language-server", args: ["--stdio"] };
	if (ext === ".py")
		return { command: "pyright-langserver", args: ["--stdio"] };
	if (ext === ".go") return { command: "gopls", args: [] };
	if (ext === ".rs") return { command: "rust-analyzer", args: [] };
	if (ext === ".swift") return { command: "sourcekit-lsp", args: [] };
	if ([".json", ".jsonc"].includes(ext))
		return { command: "vscode-json-language-server", args: ["--stdio"] };
	if ([".yml", ".yaml"].includes(ext))
		return { command: "yaml-language-server", args: ["--stdio"] };
	return undefined;
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

function lspPos(line: number, character: number) {
	return { line: Math.max(0, line - 1), character: Math.max(0, character - 1) };
}
function pretty(value: Json) {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		updateLspStatus(ctx as ToolCtx);
	});
	pi.registerTool({
		name: "ast_grep_search",
		label: "AST Search",
		description:
			"AST-aware code search. Use code-shaped patterns, not regex/text. Examples: foo($$$ARGS), function $NAME($$$ARGS) { $$$BODY }.",
		parameters: Type.Object({
			pattern: Type.String(),
			lang: Type.String({ enum: [...LANGS] as string[] }),
			paths: Type.Optional(Type.Array(Type.String())),
			context: Type.Optional(Type.Number()),
		}),
		async execute(
			_id: string,
			params: any,
			_signal: AbortSignal,
			_update: unknown,
			ctx: ToolCtx,
		) {
			const args = [
				"run",
				"-p",
				params.pattern,
				"--lang",
				params.lang,
				"--json=compact",
			];
			if (params.context != null)
				args.push("--context", String(params.context));
			args.push(...(params.paths?.length ? params.paths : [ctx.cwd ?? "."]));
			const res = await sg(args, ctx.cwd);
			return text(formatSgJson(res.stdout, res.stderr), { code: res.code });
		},
	} as any);

	pi.registerTool({
		name: "ast_grep_replace",
		label: "AST Replace",
		description:
			"AST-aware replacement. Dry-run by default; set apply=true to write changes.",
		parameters: Type.Object({
			pattern: Type.String(),
			rewrite: Type.String(),
			lang: Type.String({ enum: [...LANGS] as string[] }),
			paths: Type.Array(Type.String()),
			apply: Type.Optional(Type.Boolean()),
		}),
		async execute(
			_id: string,
			params: any,
			_signal: AbortSignal,
			_update: unknown,
			ctx: ToolCtx,
		) {
			const args = [
				"run",
				"-p",
				params.pattern,
				"-r",
				params.rewrite,
				"--lang",
				params.lang,
			];
			if (params.apply) args.push("--update-all");
			else args.push("--json=compact");
			args.push(...params.paths);
			const res = await sg(args, ctx.cwd);
			return text(
				params.apply
					? res.stderr || res.stdout || "Applied"
					: formatSgJson(res.stdout, res.stderr),
				{ code: res.code, applied: !!params.apply },
			);
		},
	} as any);

	pi.registerTool({
		name: "lsp_definition",
		label: "LSP Definition",
		description: "Jump to definition at a 1-based file position.",
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
			return text(pretty(result));
		},
	} as any);

	pi.registerTool({
		name: "lsp_hover",
		label: "LSP Hover",
		description: "Show hover/type info at a 1-based file position.",
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
			"List document symbols for a file, optionally filtered by query.",
		parameters: Type.Object({
			filePath: Type.String(),
			query: Type.Optional(Type.String()),
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
			return text(pretty(filtered));
		},
	} as any);

	pi.registerTool({
		name: "lsp_diagnostics",
		label: "LSP Diagnostics",
		description: "Open a file in LSP and return current diagnostics.",
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
