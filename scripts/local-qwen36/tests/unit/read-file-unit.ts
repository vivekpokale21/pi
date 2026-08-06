#!/usr/bin/env -S node --import tsx
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadFileTool } from "../../read-file.ts";
import { EXECUTOR_TOOL_NAMES, isPlannerToolAllowed, PLANNER_TOOL_NAMES } from "../../read-only.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-read-file-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function readsBoundedLineRange(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "app"), { recursive: true });
		await writeFile(join(dir, "app", "api.py"), "one\ntwo\nthree\nfour\n", "utf8");
		const tool = createReadFileTool(dir);
		const result = await tool.execute(
			"read-api",
			{ path: "app/api.py", startLine: 2, maxLines: 2 },
			undefined,
			undefined,
			undefined,
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.match(text, /app\/api.py:2-3/);
		assert.match(text, /2: two/);
		assert.match(text, /3: three/);
		assert.doesNotMatch(text, /4: four/);
	});
}

async function returnsHierarchicalFileMapWithoutBodyText(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(
			join(dir, "src", "auth.ts"),
			[
				"export class AuthService {",
				"  login(user: string): string {",
				"    return user;",
				"  }",
				"}",
				"",
				"export function readCredential(): string {",
				'  return "secret";',
				"}",
				"",
			].join("\n"),
			"utf8",
		);
		const tool = createReadFileTool(dir);
		const result = await tool.execute("read-map", { path: "src/auth.ts", mode: "map" } as any, undefined, undefined, undefined);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		assert.match(text, /<read_map path="src\/auth.ts" lines="10">/);
		assert.match(text, /symbol class AuthService lines 1-5/);
		assert.match(text, /symbol function readCredential lines 7-9/);
		assert.match(text, /"tool":"read_file"/);
		assert.match(text, /"mode":"symbol"/);
		assert.match(text, /"symbol":"readCredential"/);
		assert.doesNotMatch(text, /return "secret"/);
		assert.equal(result.details?.mode, "map");
		assert.equal(result.details?.symbols?.some((symbol) => symbol.symbolName === "readCredential"), true);
		const classSymbol = result.details?.symbols?.find((symbol) => symbol.symbolName === "AuthService");
		assert.equal(classSymbol?.lspSymbolKind, 5);
		assert.equal(classSymbol?.lspSymbolKindName, "Class");
		const functionSymbol = result.details?.symbols?.find((symbol) => symbol.symbolName === "readCredential");
		assert.equal(functionSymbol?.lspSymbolKind, 12);
		assert.equal(functionSymbol?.lspSymbolKindName, "Function");
	});
}

async function reusesParserSymbolsAndDisambiguatesByParentOrStartLine(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(
			join(dir, "src", "handlers.ts"),
			[
				"export class ApiHandler {",
				"  handleRequest(): string {",
				'    return "api";',
				"  }",
				"}",
				"",
				"export class WebHandler {",
				"  handleRequest(): string {",
				'    return "web";',
				"  }",
				"}",
				"",
			].join("\n"),
			"utf8",
		);
		const tool = createReadFileTool(dir);
		const map = await tool.execute("read-map", { path: "src/handlers.ts", mode: "map" } as any, undefined, undefined, undefined);
		const symbols = map.details?.symbols ?? [];

		assert.equal(symbols.some((symbol) => symbol.symbolName === "ApiHandler.handleRequest"), true);
		assert.equal(symbols.some((symbol) => symbol.symbolName === "WebHandler.handleRequest"), true);

		await assert.rejects(
			() =>
				tool.execute(
					"ambiguous-symbol",
					{ path: "src/handlers.ts", mode: "symbol", symbol: "handleRequest" } as any,
					undefined,
					undefined,
					undefined,
				),
			/ambiguous symbol handleRequest/,
		);

		const parentResult = await tool.execute(
			"parent-symbol",
			{ path: "src/handlers.ts", mode: "symbol", symbol: "handleRequest", parent: "WebHandler" } as any,
			undefined,
			undefined,
			undefined,
		);
		const parentText = parentResult.content[0]?.type === "text" ? parentResult.content[0].text : "";
		assert.match(parentText, /return "web"/);
		assert.doesNotMatch(parentText, /return "api"/);

		const startLineResult = await tool.execute(
			"line-symbol",
			{ path: "src/handlers.ts", mode: "symbol", symbol: "handleRequest", startLine: 2 } as any,
			undefined,
			undefined,
			undefined,
		);
		const startLineText = startLineResult.content[0]?.type === "text" ? startLineResult.content[0].text : "";
		assert.match(startLineText, /return "api"/);
		assert.doesNotMatch(startLineText, /return "web"/);
	});
}

async function readsSymbolBodyWithNavigationHandles(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(
			join(dir, "src", "auth.ts"),
			[
				"export function first(): string {",
				'  return "first";',
				"}",
				"",
				"export function target(value: number): number {",
				"  const doubled = value * 2;",
				"  return doubled;",
				"}",
				"",
				"export function last(): string {",
				'  return "last";',
				"}",
				"",
			].join("\n"),
			"utf8",
		);
		const tool = createReadFileTool(dir);
		const result = await tool.execute(
			"read-symbol",
			{ path: "src/auth.ts", mode: "symbol", symbol: "target" } as any,
			undefined,
			undefined,
			undefined,
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		assert.match(text, /<read_context path="src\/auth.ts" mode="symbol" lines="5-8"/);
		assert.match(text, /export function target/);
		assert.match(text, /return doubled/);
		assert.doesNotMatch(text, /return "first"/);
		assert.doesNotMatch(text, /return "last"/);
		assert.match(text, /above: \{"tool":"read_file","args":\{"path":"src\/auth.ts","mode":"range","startLine":1,"maxLines":4\}\}/);
		assert.match(text, /below: \{"tool":"read_file","args":\{"path":"src\/auth.ts","mode":"range","startLine":9,"maxLines":4\}\}/);
		assert.equal(result.details?.handles?.above?.startLine, 1);
		assert.equal(result.details?.handles?.below?.startLine, 9);
	});
}

async function readsContextAroundLineWithExpansionHandles(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src", "store.ts"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n", "utf8");
		const tool = createReadFileTool(dir);
		const result = await tool.execute(
			"read-around",
			{ path: "src/store.ts", mode: "around", line: 4, before: 1, after: 2 } as any,
			undefined,
			undefined,
			undefined,
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		assert.match(text, /src\/store.ts:3-6/);
		assert.match(text, /3: three/);
		assert.match(text, /6: six/);
		assert.doesNotMatch(text, /2: two/);
		assert.match(text, /above: \{"tool":"read_file","args":\{"path":"src\/store.ts","mode":"range","startLine":1,"maxLines":2\}\}/);
		assert.match(text, /below: \{"tool":"read_file","args":\{"path":"src\/store.ts","mode":"range","startLine":7,"maxLines":1\}\}/);
		assert.equal(result.details?.mode, "around");
	});
}

async function readResultsIncludeRevisionAndChunkIdentity(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(
			join(dir, "src", "auth.ts"),
			[
				"export function target(value: number): number {",
				"  return value + 1;",
				"}",
				"",
			].join("\n"),
			"utf8",
		);
		const tool = createReadFileTool(dir);
		const result = await tool.execute(
			"read-symbol",
			{ path: "src/auth.ts", mode: "symbol", symbol: "target" } as any,
			undefined,
			undefined,
			undefined,
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		assert.match(result.details?.fileRevision ?? "", /^[a-f0-9]{64}$/);
		assert.match(result.details?.chunkId ?? "", /^src\/auth\.ts::target@line-1:[a-f0-9]{12}$/);
		assert.match(text, /revision="[a-f0-9]{12}"/);
		assert.match(text, /chunk="src\/auth\.ts::target@line-1:[a-f0-9]{12}"/);
	});
}

async function repeatedOverlappingReadsReportLowNovelty(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src", "store.ts"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n", "utf8");
		const tool = createReadFileTool(dir);

		const first = await tool.execute(
			"read-first",
			{ path: "src/store.ts", mode: "range", startLine: 1, maxLines: 4 } as any,
			undefined,
			undefined,
			undefined,
		);
		const second = await tool.execute(
			"read-second",
			{ path: "src/store.ts", mode: "range", startLine: 2, maxLines: 4 } as any,
			undefined,
			undefined,
			undefined,
		);
		const secondText = second.content[0]?.type === "text" ? second.content[0].text : "";

		assert.equal(first.details?.retrieval?.novelLines, 4);
		assert.equal(second.details?.retrieval?.overlapLines, 3);
		assert.equal(second.details?.retrieval?.novelLines, 1);
		assert.match(secondText, /retrieval overlap=3 novel=1/);
		assert.equal(second.details?.retrieval?.recommendedNextAction, "expand_or_act");
	});
}

async function rejectsWorkspaceEscape(): Promise<void> {
	await withTempDir(async (dir) => {
		const tool = createReadFileTool(dir);
		await assert.rejects(
			() => tool.execute("read-escape", { path: "../outside.txt" }, undefined, undefined, undefined),
			/path escapes workspace/,
		);
	});
}

function toolIsReadOnlyForProfiles(): void {
	const tool = createReadFileTool(process.cwd());
	assert.equal(tool.name, "read_file");
	assert.equal(isPlannerToolAllowed(tool.name), true);
	assert.equal(PLANNER_TOOL_NAMES.includes("read_file"), true);
	assert.equal(EXECUTOR_TOOL_NAMES.includes("read_file"), true);
}

await readsBoundedLineRange();
await returnsHierarchicalFileMapWithoutBodyText();
await reusesParserSymbolsAndDisambiguatesByParentOrStartLine();
await readsSymbolBodyWithNavigationHandles();
await readsContextAroundLineWithExpansionHandles();
await readResultsIncludeRevisionAndChunkIdentity();
await repeatedOverlappingReadsReportLowNovelty();
await rejectsWorkspaceEscape();
toolIsReadOnlyForProfiles();
console.log("read-file-unit: ok");
