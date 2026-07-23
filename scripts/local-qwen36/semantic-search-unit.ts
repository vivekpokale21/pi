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

	assert.equal(chunks.length, 2);
	assert.equal(chunks[0].symbolName, "AuthService");
	assert.equal(chunks[0].symbolKind, "class");
	assert.equal(chunks[0].startLine, 1);
	assert.equal(chunks[0].endLine, 5);
	assert.match(chunks[0].textWithHeader, /# Symbol: class AuthService/);
	assert.equal(chunks[1].symbolName, "validateToken");
	assert.equal(chunks[1].symbolKind, "function");
}

async function lexicalSearchRanksExpectedChunk(): Promise<void> {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await mkdir(join(dir, "node_modules", "ignored"), { recursive: true });
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
		assert.equal(result.results[0]?.symbolName, "AuthService");
		assert.equal(result.results[0]?.symbolKind, "class");
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
		assert.equal(cacheRaw.version, 1);
		assert.equal(cacheRaw.files["src/auth.ts"].chunks.length, 1);

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
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /auth.ts:1-1/);

		await assert.rejects(
			() => tool.execute("call-2", { query: "auth", path: resolve(dir, ".."), maxResults: 2 }),
			/path escapes workspace/,
		);
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
normalizesExtensions();
await lexicalSearchRanksExpectedChunk();
await symbolChunkSearchReturnsSymbolMetadata();
await persistentCacheReusesAndRefreshesIndex();
await toolRejectsWorkspaceEscapesAndReturnsResults();
await embedsTextsInInputOrder();
await denseSearchRanksSemanticHitAndFallsBackOnFailure();
await hydeExpansionDrivesDenseQueryAndFallsBackOnFailure();
await rerankerReordersCandidatesAndFallsBackOnFailure();
await qdrantAdapterRanksAndFallsBack();

console.log("semantic-search-unit: ok");
