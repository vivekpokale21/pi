#!/usr/bin/env -S node --import tsx
import { mkdir, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { runSemanticSearch, type SemanticSearchInput } from "../semantic-search.ts";

type RetrievalBenchmarkModeId = "lexical" | "dense-current" | "hybrid-current" | "dense-coderank" | "hybrid-coderank";

interface RetrievalBenchmarkQuery {
	id: string;
	query: string;
	requiredPaths: string[];
	requiredSymbols?: string[];
	extensions?: string[];
	fixture: "repo" | "synthetic";
}

interface RetrievalBenchmarkMode {
	id: RetrievalBenchmarkModeId;
	useEmbeddings: boolean;
	embeddingProfile?: "default" | "coderank";
	embedModel?: string;
	embedBaseUrl?: string;
}

interface RetrievalBenchmarkResult {
	queryId: string;
	modeId: RetrievalBenchmarkModeId;
	recallAt1: number;
	recallAt3: number;
	recallAt5: number;
	reciprocalRank: number;
	requiredSymbolHits: number;
	queryMs: number;
	indexedFiles: number;
	indexedChunks: number;
	embeddingRequestCount: number;
	embeddingMs: number;
	encodeQueryCalls: number;
	encodeDocumentCalls: number;
	encodedDocumentCount: number;
	warnings: string[];
	fallbackMode?: "lexical";
	resultPaths: string[];
}

interface BenchmarkArgs {
	repo: string;
	modes: RetrievalBenchmarkModeId[];
	embedBaseUrl: string;
	currentModel: string;
	coderankModel: string;
	chunkLines: number;
	chunkOverlapLines: number;
}

const DEFAULT_EMBED_BASE_URL = "http://127.0.0.1:8129/v1";
const DEFAULT_CURRENT_MODEL = "nomic-embed-text-v1.5";
const DEFAULT_CODERANK_MODEL = "nomic-ai/CodeRankEmbed";
const ARTIFACT_DIR = resolve(".artifacts", "retrieval-benchmark");
const JSONL_PATH = resolve(ARTIFACT_DIR, "coderankembed-results.jsonl");
const RESULT_DOC_PATH = resolve("docs", "ports", "10-coderankembed-retrieval-evaluation-result.md");
const SYNTHETIC_ROOT = resolve(ARTIFACT_DIR, "synthetic-fixtures");

const QUERIES: RetrievalBenchmarkQuery[] = [
	{
		id: "api-day-etag",
		query: "where does the API return available playback hours and ETag handling for day endpoint",
		requiredPaths: ["app/api.py"],
		requiredSymbols: ["get_day", "_raw_json_response", "_etag_matches_request"],
		extensions: ["py"],
		fixture: "repo",
	},
	{
		id: "availability-range",
		query: "min max event dates availability endpoint contract",
		requiredPaths: ["app/api.py", "app/db.py"],
		requiredSymbols: ["get_availability", "availability"],
		extensions: ["py"],
		fixture: "repo",
	},
	{
		id: "ingest-log-metrics",
		query: "log every polling cycle comments scanned events below threshold duplicates skipped",
		requiredPaths: ["app/ingestor.py", "app/db.py", "schema.sql"],
		requiredSymbols: ["run_single_poll_cycle", "log_ingest_run", "ingest_log"],
		extensions: ["py", "sql"],
		fixture: "repo",
	},
	{
		id: "reddit-reply-rate-limit",
		query: "maximum ten reply fetch operations sleep between reply fetches praw ratelimit seconds",
		requiredPaths: ["app/ingestor.py", "app/reddit_rate_limit.py", "app/reddit_client.py"],
		requiredSymbols: ["reply", "rate", "limit", "sleep"],
		extensions: ["py"],
		fixture: "repo",
	},
	{
		id: "frontend-heatmap-weight",
		query: "convert geojson feature confidence source count into google maps weighted heatmap",
		requiredPaths: ["frontend/map_data.js", "frontend/map.js"],
		requiredSymbols: ["heatmap", "weight"],
		extensions: ["js"],
		fixture: "repo",
	},
	{
		id: "auth-bypass-session",
		query: "private demo auth bypass creates session with bypass token",
		requiredPaths: ["app/api.py", "app/config.py"],
		requiredSymbols: ["auth", "bypass", "session"],
		extensions: ["py"],
		fixture: "repo",
	},
	{
		id: "credentials-synonym",
		query: "user sign in secret retrieval",
		requiredPaths: ["src/auth.ts"],
		requiredSymbols: ["login", "readCredential"],
		extensions: ["ts"],
		fixture: "synthetic",
	},
	{
		id: "rendering-synonym",
		query: "paint visual surface",
		requiredPaths: ["src/canvas.ts"],
		requiredSymbols: ["drawCanvas"],
		extensions: ["ts"],
		fixture: "synthetic",
	},
	{
		id: "persistence-synonym",
		query: "save durable record",
		requiredPaths: ["src/store.ts"],
		requiredSymbols: ["upsertEvent"],
		extensions: ["ts"],
		fixture: "synthetic",
	},
];

function parseArgs(argv: string[]): BenchmarkArgs {
	const args = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token.startsWith("--")) continue;
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) {
			args.set(token.slice(2), "true");
			continue;
		}
		args.set(token.slice(2), value);
		index += 1;
	}
	const rawModes = args.get("modes") ?? "lexical,hybrid-coderank";
	const modes = rawModes.split(",").map((mode) => mode.trim()).filter((mode) => mode.length > 0);
	const allowedModes = new Set<RetrievalBenchmarkModeId>([
		"lexical",
		"dense-current",
		"hybrid-current",
		"dense-coderank",
		"hybrid-coderank",
	]);
	const parsedModes = modes.map((mode) => {
		if (!allowedModes.has(mode as RetrievalBenchmarkModeId)) {
			throw new Error(`unsupported mode: ${mode}`);
		}
		return mode as RetrievalBenchmarkModeId;
	});
	return {
		repo: resolve(args.get("repo") ?? "/mnt/d/Projects/dubai_boom_monitor"),
		modes: parsedModes,
		embedBaseUrl: args.get("embed-base-url") ?? DEFAULT_EMBED_BASE_URL,
		currentModel: args.get("embed-model") ?? DEFAULT_CURRENT_MODEL,
		coderankModel: args.get("coderank-model") ?? DEFAULT_CODERANK_MODEL,
		chunkLines: Number.parseInt(args.get("chunk-lines") ?? "40", 10),
		chunkOverlapLines: Number.parseInt(args.get("chunk-overlap-lines") ?? "10", 10),
	};
}

function buildModes(args: BenchmarkArgs): RetrievalBenchmarkMode[] {
	return args.modes.map((id) => {
		switch (id) {
			case "lexical":
				return { id, useEmbeddings: false };
			case "dense-current":
			case "hybrid-current":
				return { id, useEmbeddings: true, embeddingProfile: "default", embedBaseUrl: args.embedBaseUrl, embedModel: args.currentModel };
			case "dense-coderank":
			case "hybrid-coderank":
				return {
					id,
					useEmbeddings: true,
					embeddingProfile: "coderank",
					embedBaseUrl: args.embedBaseUrl,
					embedModel: args.coderankModel,
				};
		}
	});
}

async function writeSyntheticFixtures(): Promise<void> {
	await rm(resolve(SYNTHETIC_ROOT, "src"), { recursive: true, force: true });
	await mkdir(resolve(SYNTHETIC_ROOT, "src"), { recursive: true });
	await writeFile(
		resolve(SYNTHETIC_ROOT, "src", "auth.ts"),
		[
			"export function login(userName: string) {",
			"  const secret = readCredential(userName);",
			"  return createSession(secret);",
			"}",
			"",
			"function readCredential(userName: string) {",
			"  return `token:${userName}`;",
			"}",
			"",
			"function createSession(secret: string) {",
			"  return { secret };",
			"}",
		].join("\n"),
		"utf8",
	);
	await writeFile(
		resolve(SYNTHETIC_ROOT, "src", "canvas.ts"),
		[
			"export function drawCanvas(context: CanvasRenderingContext2D) {",
			"  context.clearRect(0, 0, 100, 100);",
			"  context.fillRect(10, 10, 40, 40);",
			"}",
		].join("\n"),
		"utf8",
	);
	await writeFile(
		resolve(SYNTHETIC_ROOT, "src", "store.ts"),
		[
			"export function upsertEvent(eventId: string, payload: unknown) {",
			"  return persist({ eventId, payload, updatedAt: Date.now() });",
			"}",
			"",
			"function persist(record: unknown) {",
			"  return record;",
			"}",
		].join("\n"),
		"utf8",
	);
}

function recallAt(resultPaths: string[], requiredPaths: string[], limit: number): number {
	const topPaths = new Set(resultPaths.slice(0, limit));
	const hits = requiredPaths.filter((path) => topPaths.has(path)).length;
	return requiredPaths.length === 0 ? 0 : hits / requiredPaths.length;
}

function reciprocalRank(resultPaths: string[], requiredPaths: string[]): number {
	for (let index = 0; index < resultPaths.length; index += 1) {
		if (requiredPaths.includes(resultPaths[index])) return 1 / (index + 1);
	}
	return 0;
}

function requiredSymbolHits(snippets: string[], requiredSymbols: string[] | undefined): number {
	if (!requiredSymbols?.length) return 0;
	const combined = snippets.join("\n").toLowerCase();
	return requiredSymbols.filter((symbol) => combined.includes(symbol.toLowerCase())).length;
}

function uniquePaths(paths: string[]): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const path of paths) {
		if (seen.has(path)) continue;
		seen.add(path);
		unique.push(path);
	}
	return unique;
}

async function runQuery(args: BenchmarkArgs, mode: RetrievalBenchmarkMode, query: RetrievalBenchmarkQuery): Promise<RetrievalBenchmarkResult> {
	const root = query.fixture === "repo" ? args.repo : SYNTHETIC_ROOT;
	const input: SemanticSearchInput = {
		root,
		query: query.query,
		extensions: query.extensions,
		maxResults: 10,
		chunkLines: args.chunkLines,
		chunkOverlapLines: args.chunkOverlapLines,
		symbolChunks: true,
		useCache: true,
		reindex: mode.id === args.modes[0],
		useEmbeddings: mode.useEmbeddings,
		embeddingProfile: mode.embeddingProfile,
		embedBaseUrl: mode.embedBaseUrl,
		embedModel: mode.embedModel,
	};
	const started = performance.now();
	const output = await runSemanticSearch(input);
	const queryMs = Math.round(performance.now() - started);
	const resultPaths = uniquePaths(output.results.map((result) => result.path));
	const embeddingFailed = mode.useEmbeddings && output.mode === "lexical";
	return {
		queryId: query.id,
		modeId: mode.id,
		recallAt1: recallAt(resultPaths, query.requiredPaths, 1),
		recallAt3: recallAt(resultPaths, query.requiredPaths, 3),
		recallAt5: recallAt(resultPaths, query.requiredPaths, 5),
		reciprocalRank: reciprocalRank(resultPaths, query.requiredPaths),
		requiredSymbolHits: requiredSymbolHits(
			output.results.map((result) => `${result.symbolName ?? ""}\n${result.snippet}`),
			query.requiredSymbols,
		),
		queryMs,
		indexedFiles: output.indexedFiles,
		indexedChunks: output.indexedChunks,
		embeddingRequestCount: output.embeddingStats.embeddingRequestCount,
		embeddingMs: output.embeddingStats.embeddingMs,
		encodeQueryCalls: output.embeddingStats.encodeQueryCalls,
		encodeDocumentCalls: output.embeddingStats.encodeDocumentCalls,
		encodedDocumentCount: output.embeddingStats.encodedDocumentCount,
		warnings: output.warnings,
		fallbackMode: embeddingFailed ? "lexical" : undefined,
		resultPaths,
	};
}

function percentile(values: number[], percentileValue: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.floor((percentileValue / 100) * sorted.length));
	return sorted[index];
}

function formatNumber(value: number): string {
	return value.toFixed(3).replace(/\.?0+$/, "");
}

function summarizeMode(modeId: RetrievalBenchmarkModeId, results: RetrievalBenchmarkResult[]): string {
	const selected = results.filter((result) => result.modeId === modeId);
	const recallAt5 = selected.reduce((sum, result) => sum + result.recallAt5, 0) / Math.max(1, selected.length);
	const mrr = selected.reduce((sum, result) => sum + result.reciprocalRank, 0) / Math.max(1, selected.length);
	const latencies = selected.map((result) => result.queryMs);
	const fallbackRate = selected.filter((result) => result.fallbackMode === "lexical").length / Math.max(1, selected.length);
	return `| ${modeId} | ${formatNumber(recallAt5)} | ${formatNumber(mrr)} | ${percentile(latencies, 50)} | ${percentile(latencies, 95)} | ${formatNumber(fallbackRate)} |`;
}

function lexicalMissesRecovered(results: RetrievalBenchmarkResult[], modeId: RetrievalBenchmarkModeId): number {
	const lexicalByQuery = new Map(results.filter((result) => result.modeId === "lexical").map((result) => [result.queryId, result]));
	return results.filter((result) => {
		if (result.modeId !== modeId) return false;
		const lexical = lexicalByQuery.get(result.queryId);
		return lexical !== undefined && lexical.recallAt5 === 0 && result.recallAt5 > 0;
	}).length;
}

function averageRecallAt5(results: RetrievalBenchmarkResult[], modeId: RetrievalBenchmarkModeId): number {
	const selected = results.filter((result) => result.modeId === modeId);
	return selected.reduce((sum, result) => sum + result.recallAt5, 0) / Math.max(1, selected.length);
}

function meanReciprocalRank(results: RetrievalBenchmarkResult[], modeId: RetrievalBenchmarkModeId): number {
	const selected = results.filter((result) => result.modeId === modeId);
	return selected.reduce((sum, result) => sum + result.reciprocalRank, 0) / Math.max(1, selected.length);
}

function p50Latency(results: RetrievalBenchmarkResult[], modeId: RetrievalBenchmarkModeId): number {
	return percentile(
		results.filter((result) => result.modeId === modeId).map((result) => result.queryMs),
		50,
	);
}

function relativeImprovement(next: number, baseline: number): number {
	return baseline === 0 ? 0 : (next - baseline) / baseline;
}

function buildMarkdown(args: BenchmarkArgs, modes: RetrievalBenchmarkMode[], results: RetrievalBenchmarkResult[]): string {
	const modeIds = modes.map((mode) => mode.id);
	const lexicalRecallAt5 = averageRecallAt5(results, "lexical");
	const lexicalMrr = meanReciprocalRank(results, "lexical");
	const coderankRecallAt5 = averageRecallAt5(results, "hybrid-coderank");
	const coderankMrr = meanReciprocalRank(results, "hybrid-coderank");
	const coderankP50 = p50Latency(results, "hybrid-coderank");
	const recoveredMisses = lexicalMissesRecovered(results, "hybrid-coderank");
	const coderankGatePassed =
		modeIds.includes("hybrid-coderank") &&
		relativeImprovement(coderankRecallAt5, lexicalRecallAt5) >= 0.15 &&
		relativeImprovement(coderankMrr, lexicalMrr) >= 0.1 &&
		coderankP50 < 2500 &&
		recoveredMisses >= 1;
	const lines = [
		"# CodeRankEmbed Retrieval Evaluation Result",
		"",
		`Date: ${new Date().toISOString()}`,
		"",
		"## Benchmark Run",
		"",
		`Repository: \`${args.repo}\``,
		`Embedding base URL: \`${args.embedBaseUrl}\``,
		`Current dense model: \`${args.currentModel}\``,
		`CodeRankEmbed model: \`${args.coderankModel}\``,
		`Chunk lines: \`${args.chunkLines}\``,
		`Chunk overlap lines: \`${args.chunkOverlapLines}\``,
		"",
		"Modes are lexical-only or hybrid dense/BM25. The `dense-*` aliases currently use the same hybrid path as `runSemanticSearch()` because there is no production dense-only search path.",
		"",
		"## Aggregate Metrics",
		"",
		"| Mode | Required-file recall@5 | MRR | p50 ms | p95 ms | Fallback rate |",
		"|---|---:|---:|---:|---:|---:|",
		...modeIds.map((modeId) => summarizeMode(modeId, results)),
		"",
		`Lexical misses recovered by hybrid-coderank: ${recoveredMisses}`,
		"",
		"## Gate Status",
		"",
		modeIds.includes("hybrid-coderank")
			? `CodeRankEmbed gate: ${coderankGatePassed ? "passed" : "not passed"}`
			: "CodeRankEmbed gate: not evaluated",
		"",
		"| Requirement | Observed | Passed |",
		"|---|---:|---|",
		`| Recall@5 improvement >= 15% | ${formatNumber(relativeImprovement(coderankRecallAt5, lexicalRecallAt5) * 100)}% | ${relativeImprovement(coderankRecallAt5, lexicalRecallAt5) >= 0.15 ? "yes" : "no"} |`,
		`| MRR improvement >= 10% | ${formatNumber(relativeImprovement(coderankMrr, lexicalMrr) * 100)}% | ${relativeImprovement(coderankMrr, lexicalMrr) >= 0.1 ? "yes" : "no"} |`,
		`| p50 latency < 2500 ms | ${coderankP50} ms | ${coderankP50 < 2500 ? "yes" : "no"} |`,
		`| Embedding fallback rate = 0 | ${formatNumber(results.filter((result) => result.modeId === "hybrid-coderank" && result.fallbackMode === "lexical").length)} | ${results.some((result) => result.modeId === "hybrid-coderank" && result.fallbackMode === "lexical") ? "no" : "yes"} |`,
		`| Lexical miss recovered | ${recoveredMisses} | ${recoveredMisses >= 1 ? "yes" : "no"} |`,
		"",
		"## Query Results",
		"",
		"| Query | Mode | R@1 | R@3 | R@5 | RR | Symbols | ms | Embed ms | EncQ | EncDocs | Doc count | Warnings | Top paths |",
		"|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|",
		...results.map((result) =>
			[
				`| ${result.queryId}`,
				result.modeId,
				formatNumber(result.recallAt1),
				formatNumber(result.recallAt3),
				formatNumber(result.recallAt5),
				formatNumber(result.reciprocalRank),
				String(result.requiredSymbolHits),
				String(result.queryMs),
				String(result.embeddingMs),
				String(result.encodeQueryCalls),
				String(result.encodeDocumentCalls),
				String(result.encodedDocumentCount),
				result.warnings.length ? result.warnings.join("<br>") : "",
				result.resultPaths.slice(0, 5).join("<br>"),
				"|",
			].join(" | "),
		),
		"",
		"## Evaluation Decision",
		"",
		modeIds.includes("hybrid-coderank")
			? "Do not change default retrieval behavior from this benchmark alone. CodeRankEmbed remains opt-in and lexical/BM25 remains the default control."
			: "CodeRankEmbed was not run in this benchmark invocation. Do not change retrieval behavior.",
		"",
	];
	return lines.join("\n");
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const modes = buildModes(args);
	await mkdir(ARTIFACT_DIR, { recursive: true });
	await writeSyntheticFixtures();
	const results: RetrievalBenchmarkResult[] = [];
	for (const query of QUERIES) {
		for (const mode of modes) {
			results.push(await runQuery(args, mode, query));
		}
	}
	await writeFile(JSONL_PATH, `${results.map((result) => JSON.stringify(result)).join("\n")}\n`, "utf8");
	await writeFile(RESULT_DOC_PATH, buildMarkdown(args, modes, results), "utf8");
	console.log(`wrote ${JSONL_PATH}`);
	console.log(`wrote ${RESULT_DOC_PATH}`);
}

await main();
