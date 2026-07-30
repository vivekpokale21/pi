#!/usr/bin/env -S node --import tsx
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	chunkText,
	createSemanticSearchTool,
	embedTexts,
	expandQueryWithHyde,
	normalizeExtensions,
	queryQdrantVectors,
	rerankSearchResults,
	runSemanticSearch,
	upsertQdrantVectors,
} from "./semantic-search.ts";
import { createTypeScriptParserAdapter } from "./parser-adapters.ts";
import { EXECUTOR_TOOL_NAMES, isPlannerToolAllowed, PLANNER_TOOL_NAMES } from "./read-only.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-semantic-search-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function withEmbeddingServer(
	handler: (body: { model: string; input: string[] }, response: ServerResponse) => void,
	fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
	const server = createServer(async (request, response) => {
		if (request.url !== "/v1/embeddings" || request.method !== "POST") {
			response.writeHead(404).end();
			return;
		}
		const body = JSON.parse(await readRequestBody(request)) as { model: string; input: string[] };
		handler(body, response);
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	try {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("embedding server did not expose a TCP port");
		await fn(`http://127.0.0.1:${address.port}/v1`);
	} finally {
		await new Promise<void>((resolveClose, rejectClose) => {
			server.close((error) => (error ? rejectClose(error) : resolveClose()));
		});
	}
}

async function withSemanticServer(
	options: { completionStatus?: number; rerankStatus?: number; qdrantStatus?: number },
	fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
	const storedQdrantPoints: Array<{ id: string; vector: number[]; payload: { chunkId: string } }> = [];
	const server = createServer(async (request, response) => {
		if (request.url === "/v1/embeddings" && request.method === "POST") {
			const body = JSON.parse(await readRequestBody(request)) as { model: string; input: string[] };
			response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: vectorForText(text) })) }));
			return;
		}
		if (request.url === "/v1/completions" && request.method === "POST") {
			await readRequestBody(request);
			if (options.completionStatus && options.completionStatus >= 400) {
				response.writeHead(options.completionStatus, { "content-type": "application/json" }).end(JSON.stringify({ error: "hyde failed" }));
				return;
			}
			response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ choices: [{ text: "function login() { return readCredential(); }" }] }));
			return;
		}
		if (request.url === "/v1/rerank" && request.method === "POST") {
			const body = JSON.parse(await readRequestBody(request)) as { query: string; documents: string[] };
			if (options.rerankStatus && options.rerankStatus >= 400) {
				response.writeHead(options.rerankStatus, { "content-type": "application/json" }).end(JSON.stringify({ error: "rerank failed" }));
				return;
			}
			const results = body.documents.map((document, index) => ({
				index,
				relevance_score: document.includes("drawCanvas") ? 0.99 : 0.1,
			}));
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ results }));
			return;
		}
		if (request.url === "/collections/pi-test/points?wait=true" && request.method === "PUT") {
			const body = JSON.parse(await readRequestBody(request)) as {
				points: Array<{ id: string; vector: number[]; payload: { chunkId: string } }>;
			};
			storedQdrantPoints.splice(0, storedQdrantPoints.length, ...body.points);
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: { operation_id: 1 } }));
			return;
		}
		if (request.url === "/collections/pi-test/points/search" && request.method === "POST") {
			if (options.qdrantStatus && options.qdrantStatus >= 400) {
				response.writeHead(options.qdrantStatus, { "content-type": "application/json" }).end(JSON.stringify({ error: "qdrant failed" }));
				return;
			}
			const body = JSON.parse(await readRequestBody(request)) as { vector: number[]; limit: number };
			const result = storedQdrantPoints
				.map((point) => ({
					id: point.id,
					score: point.vector[0] * body.vector[0] + point.vector[1] * body.vector[1],
					payload: point.payload,
				}))
				.sort((left, right) => right.score - left.score)
				.slice(0, body.limit);
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result }));
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	try {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("semantic server did not expose a TCP port");
		await fn(`http://127.0.0.1:${address.port}/v1`);
	} finally {
		await new Promise<void>((resolveClose, rejectClose) => {
			server.close((error) => (error ? rejectClose(error) : resolveClose()));
		});
	}
}

function vectorForText(text: string): number[] {
	const lower = text.toLowerCase();
	if (lower.includes("credential") || lower.includes("oauth") || lower.includes("login")) return [1, 0];
	if (lower.includes("paint") || lower.includes("canvas")) return [0, 1];
	return [0.2, 0.2];
}

function chunksTextWithOverlap(): void {
	const chunks = chunkText({
		path: "src/auth.ts",
		language: "typescript",
		text: ["one", "two", "three", "four", "five"].join("\n"),
		chunkLines: 3,
		chunkOverlapLines: 1,
	});

	assert.equal(chunks.length, 2);
	assert.equal(chunks[0].startLine, 1);
	assert.equal(chunks[0].endLine, 3);
	assert.equal(chunks[1].startLine, 3);
	assert.equal(chunks[1].endLine, 5);
	assert.match(chunks[0].id, /^[a-f0-9]{64}$/);
	assert.match(chunks[0].textWithHeader, /# File: src\/auth.ts/);
}

function chunksTextBySymbolsWhenEnabled(): void {
	const chunks = chunkText({
		path: "src/service.ts",
		language: "typescript",
		text: [
			"export class AuthService {",
			"  login() {",
			"    return true;",
			"  }",
			"}",
			"",
			"export function validateToken(token: string) {",
			"  return token.length > 10;",
			"}",
		].join("\n"),
		symbolChunks: true,
	});

	assert.equal(chunks.length, 3);
	assert.equal(chunks[0].symbolName, "AuthService");
	assert.equal(chunks[0].symbolKind, "class");
	assert.equal(chunks[0].languageTier, "structured");
	assert.equal(chunks[0].startLine, 1);
	assert.equal(chunks[0].endLine, 5);
	assert.match(chunks[0].textWithHeader, /# Symbol: class AuthService/);
	assert.equal(chunks[1].symbolName, "AuthService.login");
	assert.equal(chunks[1].symbolKind, "method");
	assert.equal(chunks[2].symbolName, "validateToken");
	assert.equal(chunks[2].symbolKind, "function");
}

function typeScriptParserExtractsSymbolsImportsAndTier(): void {
	const adapter = createTypeScriptParserAdapter();
	const result = adapter.extract({
		path: "src/service.ts",
		text: [
			"import { readCredential } from './credentials';",
			"import logger from '../logger';",
			"",
			"export interface AuthConfig {",
			"  token: string;",
			"}",
			"",
			"export class AuthService {",
			"  login() {",
			"    return readCredential();",
			"  }",
			"}",
			"",
			"export function validateToken(token: string) {",
			"  return token.length > 10;",
			"}",
		].join("\n"),
	});

	assert.deepEqual(result.warnings, []);
	assert.deepEqual(
		result.chunks.map((chunk) => [chunk.symbolKind, chunk.symbolName, chunk.startLine, chunk.endLine, chunk.languageTier]),
		[
			["interface", "AuthConfig", 4, 6, "structured"],
			["class", "AuthService", 8, 12, "structured"],
			["method", "AuthService.login", 9, 11, "structured"],
			["function", "validateToken", 14, 16, "structured"],
		],
	);
	assert.deepEqual(
		result.imports.map((edge) => [edge.fromPath, edge.specifier, edge.kind, edge.confidence]),
		[
			["src/service.ts", "./credentials", "static", "high"],
			["src/service.ts", "../logger", "static", "high"],
		],
	);
	assert.match(result.chunks[0]?.textWithHeader ?? "", /# Language tier: structured/);
}

function parserAdapterFallsBackToLineWindowOnParseFailure(): void {
	const adapter = createTypeScriptParserAdapter();
	const result = adapter.extract({
		path: "src/broken.ts",
		text: "export function broken(\n",
	});

	assert.equal(result.chunks.length, 1);
	assert.equal(result.chunks[0]?.languageTier, "line-window");
	assert.equal(result.chunks[0]?.symbolName, undefined);
	assert.equal(result.imports.length, 0);
	assert.match(result.warnings[0] ?? "", /parser failed/);
}

async function lexicalSearchRanksExpectedChunk(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await mkdir(join(dir, "node_modules", "ignored"), { recursive: true });
		await mkdir(join(dir, ".venv", "lib"), { recursive: true });
		await writeFile(
			join(dir, "src", "auth.ts"),
			[
				"export function validateToken(token: string) {",
				"  return authenticationMiddleware(token);",
				"}",
				"function authenticationMiddleware(token: string) {",
				"  return token.length > 10;",
				"}",
			].join("\n"),
			"utf8",
		);
		await writeFile(join(dir, "src", "logging.ts"), "export const logger = console;\n", "utf8");
		await writeFile(join(dir, "node_modules", "ignored", "auth.ts"), "authentication token ignored dependency\n", "utf8");
		await writeFile(join(dir, ".venv", "lib", "auth.ts"), "authentication token ignored virtualenv\n", "utf8");

		const result = await runSemanticSearch({
			root: dir,
			query: "authentication token middleware",
			extensions: ["ts"],
			chunkLines: 4,
			chunkOverlapLines: 1,
			maxResults: 5,
		});

		assert.equal(result.mode, "lexical");
		assert.equal(result.indexedFiles, 2);
		assert.equal(result.results[0]?.path, "src/auth.ts");
		assert.match(result.results[0]?.snippet ?? "", /authenticationMiddleware/);
		assert.equal(result.results.some((entry) => entry.path.includes("node_modules")), false);
		assert.equal(result.results.some((entry) => entry.path.includes(".venv")), false);
	});
}

async function symbolChunkSearchReturnsSymbolMetadata(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(
			join(dir, "src", "service.ts"),
			[
				"export class AuthService {",
				"  login() {",
				"    return readCredential();",
				"  }",
				"}",
				"",
				"export function drawCanvas() {",
				"  return true;",
				"}",
			].join("\n"),
			"utf8",
		);

		const result = await runSemanticSearch({
			root: dir,
			query: "AuthService login credential",
			extensions: ["ts"],
			symbolChunks: true,
		});
		assert.equal(result.results[0]?.path, "src/service.ts");
		assert.equal(result.results[0]?.symbolName, "AuthService.login");
		assert.equal(result.results[0]?.symbolKind, "method");
		assert.equal(result.results[0]?.languageTier, "structured");
	});
}

async function semanticSearchUsesParserChunksWhenAvailable(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(
			join(dir, "src", "service.ts"),
			[
				"export class AuthService {",
				"  login() {",
				"    return readCredential();",
				"  }",
				"}",
				"",
				"export function drawCanvas() {",
				"  return true;",
				"}",
			].join("\n"),
			"utf8",
		);

		const result = await runSemanticSearch({
			root: dir,
			query: "login credential",
			extensions: ["ts"],
			symbolChunks: true,
		});
		assert.equal(result.results[0]?.path, "src/service.ts");
		assert.equal(result.results[0]?.symbolName, "AuthService.login");
		assert.equal(result.results[0]?.symbolKind, "method");
		assert.equal(result.results[0]?.languageTier, "structured");
	});
}

async function persistentCacheReusesAndRefreshesIndex(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		const authPath = join(dir, "src", "auth.ts");
		await writeFile(authPath, "export const authToken = 'token';\n", "utf8");

		const first = await runSemanticSearch({
			root: dir,
			query: "auth token",
			extensions: ["ts"],
			useCache: true,
			reindex: true,
		});
		assert.equal(first.indexRebuilt, true);
		assert.equal(first.cachePath.endsWith(".semantic_search/lexical-index.json"), true);
		assert.equal(first.results[0]?.path, "src/auth.ts");
		const cacheRaw = JSON.parse(await readFile(join(dir, ".semantic_search", "lexical-index.json"), "utf8"));
		assert.equal(cacheRaw.version, 2);
		assert.equal(cacheRaw.files["src/auth.ts"].chunks.length, 1);
		assert.equal(cacheRaw.files["src/auth.ts"].chunks[0].languageTier, "line-window");

		const second = await runSemanticSearch({
			root: dir,
			query: "auth token",
			extensions: ["ts"],
			useCache: true,
		});
		assert.equal(second.indexRebuilt, false);
		assert.equal(second.indexedFiles, 1);

		await writeFile(authPath, "export const paymentToken = 'token';\n", "utf8");
		const third = await runSemanticSearch({
			root: dir,
			query: "payment token",
			extensions: ["ts"],
			useCache: true,
		});
		assert.equal(third.indexRebuilt, true);
		assert.equal(third.results[0]?.path, "src/auth.ts");
		assert.match(third.results[0]?.snippet ?? "", /paymentToken/);
	});
}

async function searchReceiptReportsFreshnessAndRevision(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		const alphaPath = join(dir, "src", "alpha.ts");
		await writeFile(alphaPath, "export const alphaToken = 'alpha';\n", "utf8");

		const uncached = await runSemanticSearch({
			root: dir,
			query: "alpha token",
			extensions: ["ts"],
			useCache: false,
		});
		assert.match(uncached.receipt.indexRevision, /^[a-f0-9]{12}$/);
		assert.equal(uncached.receipt.freshness, "clean");
		assert.equal(uncached.receipt.returnedTotal, uncached.results.length);
		assert.equal(uncached.receipt.contextComplete, "complete");
		assert.equal(uncached.receipt.recommendedNextAction, "use_bundle");

		const indexed = await runSemanticSearch({
			root: dir,
			query: "alpha token",
			extensions: ["ts"],
			useCache: true,
			reindex: true,
		});
		assert.equal(indexed.receipt.indexRevision, uncached.receipt.indexRevision);
		assert.equal(indexed.receipt.freshness, "clean");

		const cached = await runSemanticSearch({
			root: dir,
			query: "alpha token",
			extensions: ["ts"],
			useCache: true,
		});
		assert.equal(cached.indexRebuilt, false);
		assert.equal(cached.receipt.indexRevision, indexed.receipt.indexRevision);
		assert.equal(cached.receipt.freshness, "clean");

		await writeFile(alphaPath, "export const betaToken = 'beta';\n", "utf8");
		const dirty = await runSemanticSearch({
			root: dir,
			query: "beta token",
			extensions: ["ts"],
			useCache: true,
		});
		assert.equal(dirty.receipt.freshness, "dirty");
		assert.notEqual(dirty.receipt.indexRevision, cached.receipt.indexRevision);
		assert.equal(dirty.receipt.recommendedNextAction, "refresh_index");

		const refreshed = await runSemanticSearch({
			root: dir,
			query: "beta token",
			extensions: ["ts"],
			useCache: true,
			reindex: true,
		});
		assert.equal(refreshed.receipt.freshness, "clean");
		assert.equal(refreshed.receipt.indexRevision, dirty.receipt.indexRevision);
	});
}

async function searchReceiptAccountsForSkippedCandidates(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src", "first.ts"), "export const sharedTokenOne = 'shared token';\n", "utf8");
		await writeFile(join(dir, "src", "second.ts"), "export const sharedTokenTwo = 'shared token';\n", "utf8");
		await writeFile(join(dir, "src", "third.ts"), "export const sharedTokenThree = 'shared token';\n", "utf8");

		const result = await runSemanticSearch({
			root: dir,
			query: "shared token",
			extensions: ["ts"],
			maxResults: 1,
		});

		assert.equal(result.results.length, 1);
		assert.equal(result.receipt.returnedTotal, 1);
		assert.equal(result.receipt.skippedTotal, 2);
		assert.equal(result.receipt.skippedCandidates.length, 2);
		assert.equal(result.receipt.contextComplete, "incomplete");
		assert.equal(result.receipt.contextCompleteReason, "candidate_budget_exhausted");
		assert.equal(result.receipt.recommendedNextAction, "fetch_skipped_candidate");
		assert.match(result.receipt.skippedCandidates[0]?.path ?? "", /^src\//);
	});
}

function normalizesExtensions(): void {
	assert.deepEqual(normalizeExtensions(["ts", ".tsx", "TS"]), [".ts", ".tsx"]);
	assert.equal(normalizeExtensions([]).includes(".md"), true);
}

async function toolRejectsWorkspaceEscapesAndReturnsResults(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src", "auth.ts"), "export const authToken = 'token';\n", "utf8");
		const tool = createSemanticSearchTool(dir);

		const result = await tool.execute("call-1", { query: "auth token", path: "src", maxResults: 2 });
		assert.equal(result.details.results.length, 1);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.match(text, /^semantic_search mode=lexical indexed_files=1 indexed_chunks=1\nreceipt freshness=clean revision=[a-f0-9]{12} complete=complete next=use_bundle returned=1 skipped=0/m);
		assert.match(text, /auth.ts:1-1/);

		await assert.rejects(
			() => tool.execute("call-2", { query: "auth", path: resolve(dir, ".."), maxResults: 2 }),
			/path escapes workspace/,
		);
	});
}

async function semanticSearchToolAcceptsFilePath(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "app"), { recursive: true });
		await writeFile(
			join(dir, "app", "api.py"),
			[
				"def get_day():",
				"    return raw_json_response()",
				"",
				"def get_availability():",
				"    return {'available': True}",
			].join("\n"),
			"utf8",
		);
		await writeFile(join(dir, "app", "other.py"), "def unrelated():\n    pass\n", "utf8");

		const tool = createSemanticSearchTool(dir);
		const result = await tool.execute(
			"search-file-path",
			{ path: "app/api.py", query: "get_day availability", maxResults: 5 },
			undefined,
			undefined,
			undefined,
		);

		assert.equal(result.details?.indexedFiles, 1);
		assert.equal(result.details?.results.every((entry) => entry.path === "app/api.py"), true);
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /app\/api.py/);
	});
}

async function embedsTextsInInputOrder(): Promise<void> {
	await withEmbeddingServer((body, response) => {
		assert.equal(body.model, "local-embed");
		response
			.writeHead(200, { "content-type": "application/json" })
			.end(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: vectorForText(text) })) }));
	}, async (baseUrl) => {
		const vectors = await embedTexts({
			baseUrl,
			model: "local-embed",
			texts: ["paint canvas", "oauth credential login"],
		});
		assert.deepEqual(vectors, [
			[0, 1],
			[1, 0],
		]);
	});
}

async function denseSearchRanksSemanticHitAndFallsBackOnFailure(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src", "auth.ts"), "export function login() { return readCredential(); }\n", "utf8");
		await writeFile(join(dir, "src", "paint.ts"), "export function paint() { return drawCanvas(); }\n", "utf8");

		await withEmbeddingServer((body, response) => {
			response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: vectorForText(text) })) }));
		}, async (baseUrl) => {
			const result = await runSemanticSearch({
				root: dir,
				query: "oauth",
				extensions: ["ts"],
				useEmbeddings: true,
				embedBaseUrl: baseUrl,
				embedModel: "local-embed",
			});
			assert.equal(result.mode, "hybrid");
			assert.equal(result.results[0]?.path, "src/auth.ts");
		});

		await withEmbeddingServer((_body, response) => {
			response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "boom" }));
		}, async (baseUrl) => {
			const result = await runSemanticSearch({
				root: dir,
				query: "paint canvas",
				extensions: ["ts"],
				useEmbeddings: true,
				embedBaseUrl: baseUrl,
				embedModel: "local-embed",
			});
			assert.equal(result.mode, "lexical");
			assert.match(result.warnings[0] ?? "", /embedding path failed/);
			assert.equal(result.results[0]?.path, "src/paint.ts");
		});
	});
}

async function coderankEmbeddingProfileAppliesQueryPrefixAndModelDefaults(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src", "auth.ts"), "export function login() { return readCredential(); }\n", "utf8");

		const requests: Array<{ model: string; input: string[] }> = [];
		await withEmbeddingServer((body, response) => {
			requests.push(body);
			response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: vectorForText(text) })) }));
		}, async (baseUrl) => {
			const coderank = await runSemanticSearch({
				root: dir,
				query: "user sign in secret retrieval",
				extensions: ["ts"],
				useEmbeddings: true,
				embeddingProfile: "coderank",
				embedBaseUrl: baseUrl,
			});
			assert.equal(coderank.mode, "hybrid");
			assert.equal(requests[0]?.model, "nomic-ai/CodeRankEmbed");
			assert.match(requests[0]?.input[0] ?? "", /^# File: src\/auth\.ts/);
			assert.doesNotMatch(requests[0]?.input[0] ?? "", /^Represent this code/);
			assert.equal(requests[1]?.model, "nomic-ai/CodeRankEmbed");
			assert.deepEqual(requests[1]?.input, ["Represent this query for searching relevant code: user sign in secret retrieval"]);

			await runSemanticSearch({
				root: dir,
				query: "user sign in secret retrieval",
				extensions: ["ts"],
				useEmbeddings: true,
				embeddingProfile: "coderank",
				embedBaseUrl: baseUrl,
				embedModel: "override-embed",
			});
			assert.equal(requests[2]?.model, "override-embed");
			assert.equal(requests[3]?.model, "override-embed");

			await runSemanticSearch({
				root: dir,
				query: "user sign in secret retrieval",
				extensions: ["ts"],
				useEmbeddings: true,
				embedBaseUrl: baseUrl,
			});
			assert.equal(requests[4]?.model, "nomic-embed-text-v1.5");
			assert.equal(requests[5]?.model, "nomic-embed-text-v1.5");
			assert.deepEqual(requests[5]?.input, ["user sign in secret retrieval"]);
		});
	});
}

async function denseSearchUsesAllIndexedChunkEmbeddings(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src", "auth.ts"), "export function login() { return readCredential(); }\n", "utf8");
		await writeFile(join(dir, "src", "paint.ts"), "export function paint() { return drawCanvas(); }\n", "utf8");
		await writeFile(join(dir, "src", "store.ts"), "export function upsertEvent() { return true; }\n", "utf8");

		await withEmbeddingServer((body, response) => {
			response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: vectorForText(text) })) }));
		}, async (baseUrl) => {
			const result = await runSemanticSearch({
				root: dir,
				query: "paint canvas",
				extensions: ["ts"],
				useEmbeddings: true,
				embedBaseUrl: baseUrl,
				embedModel: "local-embed",
			});

			assert.equal(result.mode, "hybrid");
			assert.equal(result.embeddingStats.encodedDocumentCount, 3);
			assert.equal(result.results[0]?.path, "src/paint.ts");
		});
	});
}

async function denseSearchRunsWhenLexicalHasNoCandidates(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src", "canvas.ts"), "export function drawCanvas() { return true; }\n", "utf8");

		await withEmbeddingServer((body, response) => {
			response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: vectorForText(text) })) }));
		}, async (baseUrl) => {
			const result = await runSemanticSearch({
				root: dir,
				query: "paint visual surface",
				extensions: ["ts"],
				useEmbeddings: true,
				embedBaseUrl: baseUrl,
				embedModel: "local-embed",
			});

			assert.equal(result.mode, "hybrid");
			assert.equal(result.results[0]?.path, "src/canvas.ts");
		});
	});
}

async function warmDenseSearchEmbedsQueryOnlyAndReusesDocumentEmbeddings(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src", "auth.ts"), "export function login() { return readCredential(); }\n", "utf8");
		await writeFile(join(dir, "src", "canvas.ts"), "export function drawCanvas() { return true; }\n", "utf8");

		const requests: Array<{ model: string; input: string[] }> = [];
		await withEmbeddingServer((body, response) => {
			requests.push(body);
			response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: vectorForText(text) })) }));
		}, async (baseUrl) => {
			const cold = await runSemanticSearch({
				root: dir,
				query: "paint visual surface",
				extensions: ["ts"],
				useCache: true,
				reindex: true,
				useEmbeddings: true,
				embeddingProfile: "coderank",
				embedBaseUrl: baseUrl,
			});
			assert.equal(cold.embeddingStats.encodeQueryCalls, 1);
			assert.equal(cold.embeddingStats.encodeDocumentCalls, 1);
			assert.equal(cold.embeddingStats.encodedDocumentCount, 2);

			requests.splice(0, requests.length);
			const warm = await runSemanticSearch({
				root: dir,
				query: "paint visual surface",
				extensions: ["ts"],
				useCache: true,
				useEmbeddings: true,
				embeddingProfile: "coderank",
				embedBaseUrl: baseUrl,
			});
			assert.equal(warm.mode, "hybrid");
			assert.equal(warm.results[0]?.path, "src/canvas.ts");
			assert.equal(warm.embeddingStats.encodeQueryCalls, 1);
			assert.equal(warm.embeddingStats.encodeDocumentCalls, 0);
			assert.equal(warm.embeddingStats.encodedDocumentCount, 0);
			assert.equal(requests.length, 1);
			assert.equal(requests[0]?.input.length, 1);
			assert.equal(requests[0]?.input[0], "Represent this query for searching relevant code: paint visual surface");
		});
	});
}

async function embeddingCachePreservesChunkVectorsAcrossScopedSearches(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src", "auth.ts"), "export function login() { return readCredential(); }\n", "utf8");
		await writeFile(join(dir, "src", "canvas.js"), "export function drawCanvas() { return true; }\n", "utf8");

		await withEmbeddingServer((body, response) => {
			response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: vectorForText(text) })) }));
		}, async (baseUrl) => {
			const tsCold = await runSemanticSearch({
				root: dir,
				query: "user sign in secret retrieval",
				extensions: ["ts"],
				useCache: true,
				reindex: true,
				useEmbeddings: true,
				embeddingProfile: "coderank",
				embedBaseUrl: baseUrl,
			});
			assert.equal(tsCold.embeddingStats.encodeDocumentCalls, 1);
			assert.equal(tsCold.embeddingStats.encodedDocumentCount, 1);

			const jsCold = await runSemanticSearch({
				root: dir,
				query: "paint visual surface",
				extensions: ["js"],
				useCache: true,
				useEmbeddings: true,
				embeddingProfile: "coderank",
				embedBaseUrl: baseUrl,
			});
			assert.equal(jsCold.embeddingStats.encodeDocumentCalls, 1);
			assert.equal(jsCold.embeddingStats.encodedDocumentCount, 1);

			const tsWarm = await runSemanticSearch({
				root: dir,
				query: "user sign in secret retrieval",
				extensions: ["ts"],
				useCache: true,
				useEmbeddings: true,
				embeddingProfile: "coderank",
				embedBaseUrl: baseUrl,
			});
			assert.equal(tsWarm.embeddingStats.encodeQueryCalls, 1);
			assert.equal(tsWarm.embeddingStats.encodeDocumentCalls, 0);
			assert.equal(tsWarm.embeddingStats.encodedDocumentCount, 0);
		});
	});
}

async function hydeExpansionDrivesDenseQueryAndFallsBackOnFailure(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src", "auth.ts"), "export function login() { return readCredential(); }\n", "utf8");
		await writeFile(join(dir, "src", "paint.ts"), "export function paint() { return drawCanvas(); }\n", "utf8");

		await withSemanticServer({}, async (baseUrl) => {
			const expanded = await expandQueryWithHyde({
				baseUrl,
				model: "local-chat",
				query: "secure session",
			});
			assert.match(expanded, /secure session/);
			assert.match(expanded, /readCredential/);

			const result = await runSemanticSearch({
				root: dir,
				query: "secure session",
				extensions: ["ts"],
				useEmbeddings: true,
				useHyde: true,
				embedBaseUrl: baseUrl,
				hydeBaseUrl: baseUrl,
				embedModel: "local-embed",
				hydeModel: "local-chat",
			});
			assert.equal(result.mode, "hybrid");
			assert.equal(result.results[0]?.path, "src/auth.ts");
		});

		await withSemanticServer({ completionStatus: 500 }, async (baseUrl) => {
			const result = await runSemanticSearch({
				root: dir,
				query: "paint canvas",
				extensions: ["ts"],
				useEmbeddings: true,
				useHyde: true,
				embedBaseUrl: baseUrl,
				hydeBaseUrl: baseUrl,
				embedModel: "local-embed",
				hydeModel: "local-chat",
			});
			assert.equal(result.mode, "hybrid");
			assert.equal(result.results[0]?.path, "src/paint.ts");
			assert.match(result.warnings[0] ?? "", /HyDE completion failed/);
		});
	});
}

async function rerankerReordersCandidatesAndFallsBackOnFailure(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src", "auth.ts"), "export function login() { return readCredential(); }\n", "utf8");
		await writeFile(join(dir, "src", "paint.ts"), "export function paint() { return drawCanvas(); }\n", "utf8");

		await withSemanticServer({}, async (baseUrl) => {
			const reranked = await rerankSearchResults({
				baseUrl,
				model: "local-rerank",
				query: "prefer paint",
				candidates: [
					{ path: "src/auth.ts", text: "readCredential" },
					{ path: "src/paint.ts", text: "drawCanvas" },
				],
			});
			assert.deepEqual(
				reranked.map((entry) => entry.index),
				[1, 0],
			);

			const result = await runSemanticSearch({
				root: dir,
				query: "function",
				extensions: ["ts"],
				maxResults: 2,
				useRerank: true,
				rerankBaseUrl: baseUrl,
				rerankModel: "local-rerank",
			});
			assert.equal(result.results[0]?.path, "src/paint.ts");
		});

		await withSemanticServer({ rerankStatus: 500 }, async (baseUrl) => {
			const result = await runSemanticSearch({
				root: dir,
				query: "login credential",
				extensions: ["ts"],
				maxResults: 2,
				useRerank: true,
				rerankBaseUrl: baseUrl,
				rerankModel: "local-rerank",
			});
			assert.equal(result.results[0]?.path, "src/auth.ts");
			assert.match(result.warnings[0] ?? "", /reranker path failed/);
		});
	});
}

async function qdrantAdapterRanksAndFallsBack(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src", "auth.ts"), "export function login() { return readCredential(); }\n", "utf8");
		await writeFile(join(dir, "src", "paint.ts"), "export function paint() { return drawCanvas(); }\n", "utf8");

		await withSemanticServer({}, async (baseUrl) => {
			const qdrantBaseUrl = baseUrl.replace(/\/v1$/, "");
			await upsertQdrantVectors({
				baseUrl: qdrantBaseUrl,
				collection: "pi-test",
				points: [{ id: "chunk-a", vector: [1, 0], payload: { chunkId: "chunk-a" } }],
			});
			const direct = await queryQdrantVectors({ baseUrl: qdrantBaseUrl, collection: "pi-test", vector: [1, 0], limit: 1 });
			assert.equal(direct[0]?.chunkId, "chunk-a");

			const result = await runSemanticSearch({
				root: dir,
				query: "oauth",
				extensions: ["ts"],
				useEmbeddings: true,
				embedBaseUrl: baseUrl,
				embedModel: "local-embed",
				qdrantBaseUrl,
				qdrantCollection: "pi-test",
			});
			assert.equal(result.mode, "hybrid");
			assert.equal(result.results[0]?.path, "src/auth.ts");
		});

		await withSemanticServer({ qdrantStatus: 500 }, async (baseUrl) => {
			const qdrantBaseUrl = baseUrl.replace(/\/v1$/, "");
			const result = await runSemanticSearch({
				root: dir,
				query: "paint canvas",
				extensions: ["ts"],
				useEmbeddings: true,
				embedBaseUrl: baseUrl,
				embedModel: "local-embed",
				qdrantBaseUrl,
				qdrantCollection: "pi-test",
			});
			assert.equal(result.mode, "hybrid");
			assert.equal(result.results[0]?.path, "src/paint.ts");
			assert.match(result.warnings[0] ?? "", /Qdrant path failed/);
		});
	});
}

assert.equal(isPlannerToolAllowed("semantic_search"), true);
assert.equal(PLANNER_TOOL_NAMES.includes("semantic_search"), true);
assert.equal(EXECUTOR_TOOL_NAMES.includes("semantic_search"), true);
chunksTextWithOverlap();
chunksTextBySymbolsWhenEnabled();
typeScriptParserExtractsSymbolsImportsAndTier();
parserAdapterFallsBackToLineWindowOnParseFailure();
normalizesExtensions();
await lexicalSearchRanksExpectedChunk();
await symbolChunkSearchReturnsSymbolMetadata();
await semanticSearchUsesParserChunksWhenAvailable();
await persistentCacheReusesAndRefreshesIndex();
await searchReceiptReportsFreshnessAndRevision();
await searchReceiptAccountsForSkippedCandidates();
await toolRejectsWorkspaceEscapesAndReturnsResults();
await semanticSearchToolAcceptsFilePath();
await embedsTextsInInputOrder();
await denseSearchRanksSemanticHitAndFallsBackOnFailure();
await coderankEmbeddingProfileAppliesQueryPrefixAndModelDefaults();
await denseSearchUsesAllIndexedChunkEmbeddings();
await denseSearchRunsWhenLexicalHasNoCandidates();
await warmDenseSearchEmbedsQueryOnlyAndReusesDocumentEmbeddings();
await embeddingCachePreservesChunkVectorsAcrossScopedSearches();
await hydeExpansionDrivesDenseQueryAndFallsBackOnFailure();
await rerankerReordersCandidatesAndFallsBackOnFailure();
await qdrantAdapterRanksAndFallsBack();

console.log("semantic-search-unit: ok");
