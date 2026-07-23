#!/usr/bin/env -S node --import tsx
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	buildLspSymbolContext,
	createLspSymbolRegistry,
	createLspSymbolsTool,
	languageForPath,
} from "./lsp-symbols.ts";
import { EXECUTOR_TOOL_NAMES, isPlannerToolAllowed, PLANNER_TOOL_NAMES } from "./read-only.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-lsp-symbols-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function mapsLanguagesAndFiltersSymbols(): void {
	const registry = createLspSymbolRegistry({ now: () => 1000 });
	registry.registerServer({
		language: "typescript",
		status: "connected",
		rootPath: "/repo",
		capabilities: ["documentSymbolProvider", "workspaceSymbolProvider"],
	});
	registry.registerServer({ language: "rust", status: "connected", rootPath: "/repo", capabilities: ["documentSymbolProvider"] });
	registry.addSymbols("typescript", [
		{ name: "AgentRunner", kind: "class", path: "src/agent.ts", line: 12, character: 7, containerName: "agent" },
		{ name: "runAgent", kind: "function", path: "src/agent.ts", line: 44, character: 16 },
		{ name: "renderFooter", kind: "function", path: "src/footer.ts", line: 5, character: 0 },
	]);
	registry.addSymbols("rust", [{ name: "LspRegistry", kind: "struct", path: "src/lsp.rs", line: 8, character: 11 }]);

	assert.equal(languageForPath("src/main.rs"), "rust");
	assert.equal(languageForPath("src/index.ts"), "typescript");
	assert.equal(languageForPath("notes.md"), undefined);
	assert.equal(registry.findServerForPath("src/index.ts")?.language, "typescript");

	const result = registry.dispatch({ action: "symbols", path: "src/agent.ts", query: "agent", limit: 5 });
	assert.equal(result.action, "symbols");
	assert.equal(result.language, "typescript");
	assert.equal(result.symbols.length, 2);
	assert.deepEqual(
		result.symbols.map((symbol) => symbol.name),
		["AgentRunner", "runAgent"],
	);
}

function cooldownBlocksRepeatedDisconnectedDispatches(): void {
	let now = 1000;
	const registry = createLspSymbolRegistry({
		now: () => now,
		maxConsecutiveFailures: 2,
		cooldownMs: 5000,
	});
	registry.registerServer({ language: "typescript", status: "disconnected", rootPath: "/repo", capabilities: [] });

	assert.throws(
		() => registry.dispatch({ action: "symbols", path: "src/index.ts" }),
		/LSP server for 'typescript' is not connected/,
	);
	assert.throws(
		() => registry.dispatch({ action: "symbols", path: "src/index.ts" }),
		/LSP server for 'typescript' is not connected/,
	);
	assert.throws(() => registry.dispatch({ action: "symbols", path: "src/index.ts" }), /cooldown active/);

	const health = registry.dispatch({ action: "health" });
	assert.equal(health.health.typescript.consecutiveFailures, 2);
	assert.equal(health.health.typescript.cooldownRemainingSeconds, 5);

	now = 1006;
	assert.throws(
		() => registry.dispatch({ action: "symbols", path: "src/index.ts" }),
		/LSP server for 'typescript' is not connected/,
	);
}

function contextBlockIsStable(): void {
	const registry = createLspSymbolRegistry({ now: () => 1000 });
	registry.registerServer({ language: "typescript", status: "connected", rootPath: "/repo", capabilities: ["documentSymbolProvider"] });
	registry.addSymbols("typescript", [
		{ name: "beta", kind: "function", path: "src/a.ts", line: 10, character: 2 },
		{ name: "alpha", kind: "class", path: "src/a.ts", line: 1, character: 0 },
	]);

	const context = buildLspSymbolContext({ registry, path: "src/a.ts", limit: 10 });

	assert.match(context, /<lsp_symbols>/);
	assert.match(context, /language: typescript/);
	assert.match(context, /- class alpha src\/a.ts:1:0/);
	assert.match(context, /- function beta src\/a.ts:10:2/);
	assert.match(context, /<\/lsp_symbols>/);
}

async function toolRejectsWorkspaceEscapesAndReturnsSymbols(): Promise<void> {
	await withTempDir(async (dir) => {
		const src = join(dir, "src");
		const file = join(src, "index.ts");
		await mkdir(src, { recursive: true });
		await writeFile(file, "export function main() {}\n", "utf8");
		const registry = createLspSymbolRegistry({ now: () => 1000 });
		registry.registerServer({ language: "typescript", status: "connected", rootPath: dir, capabilities: ["documentSymbolProvider"] });
		registry.addSymbols("typescript", [{ name: "main", kind: "function", path: "src/index.ts", line: 1, character: 16 }]);
		const tool = createLspSymbolsTool(dir, registry);

		const result = await tool.execute("call-1", { path: "src/index.ts", query: "main", limit: 3 });
		assert.equal(result.details.symbols.length, 1);
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /function main/);

		await assert.rejects(
			() => tool.execute("call-2", { path: resolve(dir, "..", "outside.ts"), limit: 3 }),
			/path escapes workspace/,
		);
	});
}

assert.equal(isPlannerToolAllowed("lsp_symbols"), true);
assert.equal(PLANNER_TOOL_NAMES.includes("lsp_symbols"), true);
assert.equal(EXECUTOR_TOOL_NAMES.includes("lsp_symbols"), true);
mapsLanguagesAndFiltersSymbols();
cooldownBlocksRepeatedDisconnectedDispatches();
contextBlockIsStable();
await toolRejectsWorkspaceEscapesAndReturnsSymbols();

console.log("lsp-symbols-unit: ok");
