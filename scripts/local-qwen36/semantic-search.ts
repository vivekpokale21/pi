import type { AgentTool } from "../../packages/agent/src/index.ts";
import { Type, type Static } from "../../packages/ai/src/index.ts";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, readdir, rm, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createParserAdapterForLanguage } from "./parser-adapters.ts";

export type SemanticSearchLanguageTier = "full" | "structured" | "line-window";

export interface SemanticSearchChunk {
	id: string;
	path: string;
	language: string;
	languageTier: SemanticSearchLanguageTier;
	symbolName?: string;
	symbolKind?: string;
	startLine: number;
	endLine: number;
	text: string;
	textWithHeader: string;
}

export interface SemanticSearchResult {
	path: string;
	startLine: number;
	endLine: number;
	score: number;
	languageTier: SemanticSearchLanguageTier;
	symbolName?: string;
	symbolKind?: string;
	snippet: string;
}

export type SemanticSearchFreshness = "clean" | "dirty" | "unknown";
export type SemanticSearchCompleteness = "complete" | "incomplete" | "unknown";
export type SemanticSearchRecommendedAction =
	| "use_bundle"
	| "narrow_query"
	| "raise_budget"
	| "refresh_index"
	| "fetch_skipped_candidate"
	| "manual_review";

export interface SemanticSearchSkippedCandidate {
	path: string;
	startLine: number;
	endLine: number;
	score: number;
	languageTier: SemanticSearchLanguageTier;
	symbolName?: string;
	symbolKind?: string;
}

export interface SemanticSearchImportEdge {
	fromPath: string;
	specifier: string;
	kind: "static" | "dynamic" | "reexport";
	confidence: "high" | "medium" | "low";
}

export interface SemanticSearchReceipt {
	freshness: SemanticSearchFreshness;
	indexRevision: string;
	returnedTotal: number;
	skippedTotal: number;
	contextComplete: SemanticSearchCompleteness;
	contextCompleteReason: string;
	recommendedNextAction: SemanticSearchRecommendedAction;
	skippedCandidates: SemanticSearchSkippedCandidate[];
}

export interface SemanticSearchOutput {
	query: string;
	root: string;
	mode: "lexical" | "hybrid";
	indexRebuilt: boolean;
	cachePath?: string;
	indexedFiles: number;
	indexedChunks: number;
	receipt: SemanticSearchReceipt;
	results: SemanticSearchResult[];
	warnings: string[];
}

export interface ChunkTextInput {
	path: string;
	language: string;
	text: string;
	chunkLines?: number;
	chunkOverlapLines?: number;
	symbolChunks?: boolean;
	languageTier?: SemanticSearchLanguageTier;
}

export interface SemanticSearchInput {
	root: string;
	query: string;
	extensions?: string[];
	maxResults?: number;
	chunkLines?: number;
	chunkOverlapLines?: number;
	maxFileSizeBytes?: number;
	useCache?: boolean;
	reindex?: boolean;
	symbolChunks?: boolean;
	useEmbeddings?: boolean;
	embedBaseUrl?: string;
	embedEndpoint?: string;
	embedModel?: string;
	useHyde?: boolean;
	hydeBaseUrl?: string;
	hydeEndpoint?: string;
	hydeModel?: string;
	useRerank?: boolean;
	rerankBaseUrl?: string;
	rerankEndpoint?: string;
	rerankModel?: string;
	qdrantBaseUrl?: string;
	qdrantCollection?: string;
}

interface ScoredChunk {
	chunk: SemanticSearchChunk;
	score: number;
}

export interface EmbedTextsInput {
	baseUrl: string;
	model: string;
	texts: string[];
	endpoint?: string;
	fetchImpl?: typeof fetch;
}

export interface ExpandQueryWithHydeInput {
	baseUrl: string;
	model: string;
	query: string;
	endpoint?: string;
	fetchImpl?: typeof fetch;
}

export interface RerankCandidate {
	path: string;
	text: string;
}

export interface RerankSearchResultsInput {
	baseUrl: string;
	model: string;
	query: string;
	candidates: RerankCandidate[];
	endpoint?: string;
	fetchImpl?: typeof fetch;
}

export interface RerankSearchResult {
	index: number;
	score: number;
}

export interface QdrantVectorPoint {
	id: string;
	vector: number[];
	payload: { chunkId: string };
}

export interface UpsertQdrantVectorsInput {
	baseUrl: string;
	collection: string;
	points: QdrantVectorPoint[];
	fetchImpl?: typeof fetch;
}

export interface QueryQdrantVectorsInput {
	baseUrl: string;
	collection: string;
	vector: number[];
	limit: number;
	fetchImpl?: typeof fetch;
}

export interface QdrantVectorHit {
	chunkId: string;
	score: number;
}

interface CachedFileEntry {
	mtimeMs: number;
	size: number;
	chunks: SemanticSearchChunk[];
}

interface LexicalIndexCache {
	version: 2;
	root: string;
	extensions: string[];
	chunkLines: number;
	chunkOverlapLines: number;
	symbolChunks: boolean;
	files: Record<string, CachedFileEntry>;
}

interface IndexedChunks {
	chunks: SemanticSearchChunk[];
	indexedFiles: number;
	indexRebuilt: boolean;
	freshness: SemanticSearchFreshness;
	indexRevision: string;
	cachePath?: string;
}

const DEFAULT_CHUNK_LINES = 80;
const DEFAULT_CHUNK_OVERLAP_LINES = 20;
const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_MAX_FILE_SIZE_BYTES = 512 * 1024;
const LEXICAL_CACHE_VERSION = 2;
const DEFAULT_EMBED_BASE_URL = "http://127.0.0.1:8129/v1";
const DEFAULT_EMBED_ENDPOINT = "/embeddings";
const DEFAULT_EMBED_MODEL = "nomic-embed-text-v1.5";
const DEFAULT_HYDE_ENDPOINT = "/completions";
const DEFAULT_HYDE_MODEL = "qwen3.6-hyde";
const DEFAULT_RERANK_ENDPOINT = "/rerank";
const DEFAULT_RERANK_MODEL = "qwen3.6-rerank";
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "target", ".port_sessions", ".semantic_search"]);
const DEFAULT_EXTENSIONS = [
	".rs",
	".py",
	".ts",
	".tsx",
	".js",
	".jsx",
	".json",
	".toml",
	".yaml",
	".yml",
	".md",
	".go",
	".java",
	".cpp",
	".c",
	".h",
	".hpp",
	".cs",
	".rb",
	".php",
	".swift",
	".sql",
	".sh",
	".bash",
	".zsh",
	".ps1",
	".ini",
	".cfg",
];

export function normalizeExtensions(extensions: string[] | undefined): string[] {
	const values = extensions?.length ? extensions : DEFAULT_EXTENSIONS;
	const normalized = values
		.map((extension) => extension.trim().toLowerCase())
		.filter((extension) => extension.length > 0)
		.map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));
	return [...new Set(normalized)].sort();
}

function languageForExtension(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".go":
			return "go";
		case ".py":
			return "python";
		case ".ts":
		case ".tsx":
		case ".js":
		case ".jsx":
			return "typescript";
		case ".md":
			return "markdown";
		case ".yaml":
		case ".yml":
			return "yaml";
		case ".toml":
			return "toml";
		default:
			return extname(path).slice(1).toLowerCase() || "text";
	}
}

function chunkId(path: string, startLine: number, endLine: number, text: string): string {
	return createHash("sha256").update(`${path}\n${startLine}\n${endLine}\n${text}`).digest("hex");
}

interface SymbolRange {
	name: string;
	kind: string;
	startLine: number;
	endLine: number;
}

function symbolPatternForLanguage(language: string): RegExp | undefined {
	if (language === "typescript") {
		return /^(?:export\s+)?(?:abstract\s+)?(class|interface|function)\s+([A-Za-z_$][\w$]*)/;
	}
	if (language === "python") {
		return /^(class|def)\s+([A-Za-z_]\w*)/;
	}
	if (language === "go") {
		return /^(type|func)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/;
	}
	return undefined;
}

function extractSymbolRanges(language: string, lines: string[]): SymbolRange[] {
	const pattern = symbolPatternForLanguage(language);
	if (!pattern) return [];
	const starts: Array<{ name: string; kind: string; startLine: number }> = [];
	for (let index = 0; index < lines.length; index += 1) {
		const match = pattern.exec(lines[index].trimStart());
		if (!match) continue;
		starts.push({ kind: match[1] === "def" ? "function" : match[1], name: match[2], startLine: index + 1 });
	}
	return starts.map((start, index) => {
		let endLine = (starts[index + 1]?.startLine ?? lines.length + 1) - 1;
		while (endLine > start.startLine && lines[endLine - 1]?.trim() === "") {
			endLine -= 1;
		}
		return { ...start, endLine };
	});
}

function buildChunk(input: {
	path: string;
	language: string;
	startLine: number;
	endLine: number;
	text: string;
	languageTier?: SemanticSearchLanguageTier;
	symbolName?: string;
	symbolKind?: string;
}): SemanticSearchChunk {
	const languageTier = input.languageTier ?? "line-window";
	const symbolHeader =
		input.symbolName && input.symbolKind ? [`# Symbol: ${input.symbolKind} ${input.symbolName}`] : [];
	return {
		id: chunkId(input.path, input.startLine, input.endLine, input.text),
		path: input.path,
		language: input.language,
		languageTier,
		symbolName: input.symbolName,
		symbolKind: input.symbolKind,
		startLine: input.startLine,
		endLine: input.endLine,
		text: input.text,
		textWithHeader: [
			`# File: ${input.path}`,
			`# Lines: ${input.startLine}-${input.endLine}`,
			`# Language: ${input.language}`,
			`# Language tier: ${languageTier}`,
			...symbolHeader,
			input.text,
		].join("\n"),
	};
}

export function buildSemanticSearchChunk(input: {
	path: string;
	language: string;
	startLine: number;
	endLine: number;
	text: string;
	languageTier?: SemanticSearchLanguageTier;
	symbolName?: string;
	symbolKind?: string;
}): SemanticSearchChunk {
	return buildChunk(input);
}

export function chunkText(input: ChunkTextInput): SemanticSearchChunk[] {
	const chunkLines = Math.max(1, input.chunkLines ?? DEFAULT_CHUNK_LINES);
	const chunkOverlapLines = Math.min(Math.max(0, input.chunkOverlapLines ?? DEFAULT_CHUNK_OVERLAP_LINES), chunkLines - 1);
	const lines = input.text.replace(/\r?\n$/, "").split(/\r?\n/);
	if (lines.length === 1 && lines[0] === "") return [];
	if (input.symbolChunks) {
		const parserAdapter = createParserAdapterForLanguage(input.language);
		if (parserAdapter) {
			const parserResult = parserAdapter.extract({ path: input.path, text: input.text });
			if (parserResult.chunks.length > 0) return parserResult.chunks;
		}
		const symbolChunks = extractSymbolRanges(input.language, lines)
			.map((range) => {
				const selected = lines.slice(range.startLine - 1, range.endLine);
				const text = selected.join("\n");
				if (text.trim().length === 0) return undefined;
				return buildChunk({
					path: input.path,
					language: input.language,
					startLine: range.startLine,
					endLine: range.endLine,
					text,
					languageTier: "structured",
					symbolName: range.name,
					symbolKind: range.kind,
				});
			})
			.filter((chunk): chunk is SemanticSearchChunk => chunk !== undefined);
		if (symbolChunks.length > 0) return symbolChunks;
	}

	const chunks: SemanticSearchChunk[] = [];
	const step = Math.max(1, chunkLines - chunkOverlapLines);
	for (let index = 0; index < lines.length; index += step) {
		const selected = lines.slice(index, index + chunkLines);
		const text = selected.join("\n");
		if (text.trim().length === 0) continue;
		const startLine = index + 1;
		const endLine = index + selected.length;
		chunks.push(
			buildChunk({
				path: input.path,
				language: input.language,
				startLine,
				endLine,
				text,
				languageTier: input.languageTier ?? "line-window",
			}),
		);
		if (index + chunkLines >= lines.length) break;
	}
	return chunks;
}

function tokenize(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[^a-zA-Z0-9]+/)
		.map((token) => token.trim().toLowerCase())
		.filter((token) => token.length > 0);
}

function scoreChunks(query: string, chunks: SemanticSearchChunk[], maxResults: number): ScoredChunk[] {
	const queryTerms = tokenize(query);
	if (queryTerms.length === 0) return [];

	const termFrequencies = new Map<string, Map<string, number>>();
	const documentFrequencies = new Map<string, number>();
	let totalLength = 0;

	for (const chunk of chunks) {
		const tokens = tokenize(chunk.textWithHeader);
		totalLength += tokens.length;
		const frequencies = new Map<string, number>();
		for (const token of tokens) {
			frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
		}
		termFrequencies.set(chunk.id, frequencies);
		for (const term of new Set(frequencies.keys())) {
			documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
		}
	}

	const totalDocs = chunks.length;
	const averageDocumentLength = totalDocs === 0 ? 1 : totalLength / totalDocs;
	const k1 = 1.5;
	const b = 0.75;
	const scored: ScoredChunk[] = [];

	for (const chunk of chunks) {
		const frequencies = termFrequencies.get(chunk.id);
		if (!frequencies) continue;
		const documentLength = [...frequencies.values()].reduce((sum, value) => sum + value, 0);
		let score = 0;
		for (const term of queryTerms) {
			const tf = frequencies.get(term) ?? 0;
			if (tf === 0) continue;
			const df = documentFrequencies.get(term) ?? 0;
			const idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1);
			const denominator = tf + k1 * (1 - b + b * (documentLength / Math.max(averageDocumentLength, 0.000001)));
			score += idf * ((tf * (k1 + 1)) / Math.max(denominator, 0.000001));
		}
		if (score > 0) scored.push({ chunk, score });
	}

	return scored
		.sort(
			(left, right) =>
				right.score - left.score ||
				left.chunk.path.localeCompare(right.chunk.path) ||
				left.chunk.startLine - right.chunk.startLine,
		)
		.slice(0, maxResults);
}

function cosineSimilarity(left: number[], right: number[]): number {
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
		dot += left[index] * right[index];
		leftNorm += left[index] * left[index];
		rightNorm += right[index] * right[index];
	}
	if (leftNorm === 0 || rightNorm === 0) return 0;
	return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function scoreDenseChunks(queryEmbedding: number[], chunkEmbeddings: number[][], chunks: SemanticSearchChunk[]): ScoredChunk[] {
	const scored: ScoredChunk[] = [];
	for (let index = 0; index < chunks.length; index += 1) {
		const score = cosineSimilarity(queryEmbedding, chunkEmbeddings[index] ?? []);
		if (score > 0) scored.push({ chunk: chunks[index], score });
	}
	return scored.sort(
		(left, right) =>
			right.score - left.score || left.chunk.path.localeCompare(right.chunk.path) || left.chunk.startLine - right.chunk.startLine,
	);
}

function scoreKey(entry: ScoredChunk): string {
	return `${entry.chunk.path}\0${entry.chunk.startLine}\0${entry.chunk.endLine}\0${entry.chunk.id}`;
}

function chunkRevisionKey(chunk: SemanticSearchChunk): string {
	return `${chunk.path}\0${chunk.startLine}\0${chunk.endLine}\0${chunk.id}`;
}

function uniqueScoredChunks(entries: ScoredChunk[]): ScoredChunk[] {
	const byKey = new Map<string, ScoredChunk>();
	for (const entry of entries) {
		const key = scoreKey(entry);
		const existing = byKey.get(key);
		if (!existing || entry.score > existing.score) {
			byKey.set(key, entry);
		}
	}
	return [...byKey.values()].sort(
		(left, right) =>
			right.score - left.score || left.chunk.path.localeCompare(right.chunk.path) || left.chunk.startLine - right.chunk.startLine,
	);
}

function reciprocalRankFuse(dense: ScoredChunk[], lexical: ScoredChunk[], topN: number): ScoredChunk[] {
	const byId = new Map<string, { chunk: SemanticSearchChunk; score: number }>();
	const add = (entries: ScoredChunk[], weight: number) => {
		for (let index = 0; index < entries.length; index += 1) {
			const entry = entries[index];
			const existing = byId.get(entry.chunk.id) ?? { chunk: entry.chunk, score: 0 };
			existing.score += weight / (60 + index + 1);
			byId.set(entry.chunk.id, existing);
		}
	};
	add(dense, 1);
	add(lexical, 1);
	return [...byId.values()]
		.sort(
			(left, right) =>
				right.score - left.score || left.chunk.path.localeCompare(right.chunk.path) || left.chunk.startLine - right.chunk.startLine,
		)
		.slice(0, topN);
}

function computeIndexRevision(chunks: SemanticSearchChunk[]): string {
	const hash = createHash("sha256");
	for (const chunk of [...chunks].sort((left, right) => chunkRevisionKey(left).localeCompare(chunkRevisionKey(right)))) {
		hash.update(chunk.id);
		hash.update("\0");
		hash.update(chunk.path);
		hash.update("\0");
		hash.update(String(chunk.startLine));
		hash.update("\0");
		hash.update(String(chunk.endLine));
		hash.update("\0");
	}
	return hash.digest("hex").slice(0, 12);
}

export async function embedTexts(input: EmbedTextsInput): Promise<number[][]> {
	if (input.texts.length === 0) return [];
	const fetchImpl = input.fetchImpl ?? fetch;
	const baseUrl = input.baseUrl.replace(/\/$/, "");
	const endpoint = input.endpoint ?? DEFAULT_EMBED_ENDPOINT;
	const url = `${baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
	const response = await fetchImpl(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: input.model, input: input.texts }),
	});
	if (!response.ok) {
		throw new Error(`embedding request failed with HTTP ${response.status}`);
	}
	const payload = (await response.json()) as { data?: Array<{ index?: number; embedding?: unknown }> };
	if (!Array.isArray(payload.data)) throw new Error("embedding response missing data array");
	const ordered = [...payload.data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
	return ordered.map((entry) => {
		if (!Array.isArray(entry.embedding) || !entry.embedding.every((value) => typeof value === "number")) {
			throw new Error("embedding response contains a non-numeric vector");
		}
		return entry.embedding;
	});
}

export async function expandQueryWithHyde(input: ExpandQueryWithHydeInput): Promise<string> {
	const query = input.query.trim();
	if (!query) throw new Error("query must not be empty");
	const fetchImpl = input.fetchImpl ?? fetch;
	const baseUrl = input.baseUrl.replace(/\/$/, "");
	const endpoint = input.endpoint ?? DEFAULT_HYDE_ENDPOINT;
	const url = `${baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
	const prompt = [
		"You are a code search assistant.",
		"Given a task or question about a codebase, write a short realistic code snippet that would plausibly answer it.",
		"Output only code, no explanation.",
		"",
		`Task: ${query}`,
	].join("\n");
	const response = await fetchImpl(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: input.model,
			prompt,
			n_predict: 256,
			temperature: 0.2,
			stop: ["```"],
		}),
	});
	if (!response.ok) {
		throw new Error(`HyDE completion failed with HTTP ${response.status}`);
	}
	const payload = (await response.json()) as {
		content?: string;
		completion?: string;
		choices?: Array<{ text?: string; message?: { content?: string } }>;
	};
	const hypothetical =
		payload.content ??
		payload.completion ??
		payload.choices?.[0]?.text ??
		payload.choices?.[0]?.message?.content ??
		"";
	return `${query}\n${hypothetical.trim()}`.trim();
}

export async function rerankSearchResults(input: RerankSearchResultsInput): Promise<RerankSearchResult[]> {
	if (input.candidates.length === 0) return [];
	const fetchImpl = input.fetchImpl ?? fetch;
	const baseUrl = input.baseUrl.replace(/\/$/, "");
	const endpoint = input.endpoint ?? DEFAULT_RERANK_ENDPOINT;
	const url = `${baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
	const response = await fetchImpl(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: input.model,
			query: input.query,
			documents: input.candidates.map((candidate) => candidate.text),
		}),
	});
	if (!response.ok) {
		throw new Error(`reranker request failed with HTTP ${response.status}`);
	}
	const payload = (await response.json()) as { results?: Array<{ index?: number; relevance_score?: number; score?: number }> };
	if (!Array.isArray(payload.results)) throw new Error("reranker response missing results array");
	return payload.results
		.map((entry) => ({
			index: entry.index,
			score: entry.relevance_score ?? entry.score,
		}))
		.filter((entry): entry is RerankSearchResult => Number.isInteger(entry.index) && typeof entry.score === "number")
		.sort((left, right) => right.score - left.score || left.index - right.index);
}

function qdrantCollectionUrl(baseUrl: string, collection: string, suffix: string): string {
	const cleanedBaseUrl = baseUrl.replace(/\/$/, "");
	const encodedCollection = encodeURIComponent(collection);
	return `${cleanedBaseUrl}/collections/${encodedCollection}${suffix}`;
}

export async function upsertQdrantVectors(input: UpsertQdrantVectorsInput): Promise<void> {
	if (input.points.length === 0) return;
	const response = await (input.fetchImpl ?? fetch)(qdrantCollectionUrl(input.baseUrl, input.collection, "/points?wait=true"), {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ points: input.points }),
	});
	if (!response.ok) {
		throw new Error(`Qdrant upsert failed with HTTP ${response.status}`);
	}
}

export async function queryQdrantVectors(input: QueryQdrantVectorsInput): Promise<QdrantVectorHit[]> {
	const response = await (input.fetchImpl ?? fetch)(qdrantCollectionUrl(input.baseUrl, input.collection, "/points/search"), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ vector: input.vector, limit: input.limit, with_payload: true }),
	});
	if (!response.ok) {
		throw new Error(`Qdrant search failed with HTTP ${response.status}`);
	}
	const payload = (await response.json()) as {
		result?: Array<{ score?: number; payload?: { chunkId?: string; chunk_id?: string } }>;
	};
	if (!Array.isArray(payload.result)) throw new Error("Qdrant search response missing result array");
	return payload.result
		.map((entry) => ({
			chunkId: entry.payload?.chunkId ?? entry.payload?.chunk_id,
			score: entry.score,
		}))
		.filter((entry): entry is QdrantVectorHit => typeof entry.chunkId === "string" && typeof entry.score === "number");
}

async function collectFiles(root: string, allowedExtensions: Set<string>, maxFileSizeBytes: number): Promise<string[]> {
	const files: string[] = [];
	async function visit(directory: string): Promise<void> {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(join(directory, entry.name));
				continue;
			}
			if (!entry.isFile()) continue;
			const absolutePath = join(directory, entry.name);
			if (!allowedExtensions.has(extname(entry.name).toLowerCase())) continue;
			const info = await stat(absolutePath);
			if (info.size > maxFileSizeBytes) continue;
			files.push(absolutePath);
		}
	}
	await visit(root);
	return files.sort();
}

async function loadCache(cachePath: string): Promise<LexicalIndexCache | undefined> {
	try {
		const parsed = JSON.parse(await readFile(cachePath, "utf8"));
		if (parsed?.version !== LEXICAL_CACHE_VERSION || typeof parsed.root !== "string" || typeof parsed.files !== "object") {
			return undefined;
		}
		return parsed as LexicalIndexCache;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ENOTDIR")
		) {
			return undefined;
		}
		throw error;
	}
}

async function saveCache(cachePath: string, cache: LexicalIndexCache): Promise<void> {
	await mkdir(resolve(cachePath, ".."), { recursive: true });
	await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function cacheMatchesOptions(
	cache: LexicalIndexCache | undefined,
	root: string,
	extensions: string[],
	chunkLines: number,
	chunkOverlapLines: number,
	symbolChunks: boolean,
): cache is LexicalIndexCache {
	return (
		cache !== undefined &&
		cache.root === root &&
		cache.chunkLines === chunkLines &&
		cache.chunkOverlapLines === chunkOverlapLines &&
		cache.symbolChunks === symbolChunks &&
		JSON.stringify(cache.extensions) === JSON.stringify(extensions)
	);
}

async function buildChunks(input: {
	root: string;
	files: string[];
	extensions: string[];
	chunkLines: number;
	chunkOverlapLines: number;
	symbolChunks: boolean;
	useCache: boolean;
	reindex: boolean;
}): Promise<IndexedChunks> {
	const cachePath = resolve(input.root, ".semantic_search", "lexical-index.json");
	if (input.reindex) {
		await rm(cachePath, { force: true });
	}
	const loadedCache = input.useCache ? await loadCache(cachePath) : undefined;
	const cache = cacheMatchesOptions(
		loadedCache,
		input.root,
		input.extensions,
		input.chunkLines,
		input.chunkOverlapLines,
		input.symbolChunks,
	)
		? loadedCache
		: {
				version: LEXICAL_CACHE_VERSION,
				root: input.root,
				extensions: input.extensions,
				chunkLines: input.chunkLines,
				chunkOverlapLines: input.chunkOverlapLines,
				symbolChunks: input.symbolChunks,
				files: {},
			};
	const nextFiles: Record<string, CachedFileEntry> = {};
	const chunks: SemanticSearchChunk[] = [];
	let indexRebuilt = input.reindex || loadedCache === undefined || cache !== loadedCache;
	let foundStaleCacheState = input.useCache && !input.reindex && loadedCache !== undefined && cache !== loadedCache;

	for (const absolutePath of input.files) {
		const path = relative(input.root, absolutePath).replaceAll("\\", "/");
		const info = await stat(absolutePath);
		const cached = cache.files[path];
		if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
			nextFiles[path] = cached;
			chunks.push(...cached.chunks);
			continue;
		}
		if (input.useCache && !input.reindex && loadedCache !== undefined) {
			foundStaleCacheState = true;
		}

		const text = await readFile(absolutePath, "utf8");
		const fileChunks = chunkText({
			path,
			language: languageForExtension(path),
			text,
			chunkLines: input.chunkLines,
			chunkOverlapLines: input.chunkOverlapLines,
			symbolChunks: input.symbolChunks,
		});
		nextFiles[path] = { mtimeMs: info.mtimeMs, size: info.size, chunks: fileChunks };
		chunks.push(...fileChunks);
		indexRebuilt = true;
	}

	if (input.useCache && !input.reindex && loadedCache !== undefined && Object.keys(cache.files).length !== input.files.length) {
		foundStaleCacheState = true;
	}

	if (input.useCache && (indexRebuilt || Object.keys(cache.files).length !== Object.keys(nextFiles).length)) {
		indexRebuilt = true;
		await saveCache(cachePath, { ...cache, files: nextFiles });
	}

	const freshness: SemanticSearchFreshness = foundStaleCacheState ? "dirty" : "clean";
	return {
		chunks,
		indexedFiles: input.files.length,
		indexRebuilt,
		freshness,
		indexRevision: computeIndexRevision(chunks),
		cachePath: input.useCache ? cachePath : undefined,
	};
}

function snippet(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length <= 500 ? collapsed : `${collapsed.slice(0, 497)}...`;
}

function toSkippedCandidate(entry: ScoredChunk): SemanticSearchSkippedCandidate {
	return {
		path: entry.chunk.path,
		startLine: entry.chunk.startLine,
		endLine: entry.chunk.endLine,
		score: Math.round(entry.score * 1000) / 1000,
		languageTier: entry.chunk.languageTier ?? "line-window",
		symbolName: entry.chunk.symbolName,
		symbolKind: entry.chunk.symbolKind,
	};
}

function buildReceipt(input: {
	freshness: SemanticSearchFreshness;
	indexRevision: string;
	returned: ScoredChunk[];
	candidates: ScoredChunk[];
}): SemanticSearchReceipt {
	const returnedKeys = new Set(input.returned.map(scoreKey));
	const skippedCandidates = uniqueScoredChunks(input.candidates)
		.filter((entry) => !returnedKeys.has(scoreKey(entry)))
		.map(toSkippedCandidate);
	const skippedTotal = skippedCandidates.length;
	if (input.freshness === "dirty") {
		return {
			freshness: input.freshness,
			indexRevision: input.indexRevision,
			returnedTotal: input.returned.length,
			skippedTotal,
			contextComplete: "unknown",
			contextCompleteReason: "stale_index",
			recommendedNextAction: "refresh_index",
			skippedCandidates,
		};
	}
	if (skippedTotal > 0) {
		return {
			freshness: input.freshness,
			indexRevision: input.indexRevision,
			returnedTotal: input.returned.length,
			skippedTotal,
			contextComplete: "incomplete",
			contextCompleteReason: "candidate_budget_exhausted",
			recommendedNextAction: "fetch_skipped_candidate",
			skippedCandidates,
		};
	}
	if (input.returned.length === 0) {
		return {
			freshness: input.freshness,
			indexRevision: input.indexRevision,
			returnedTotal: 0,
			skippedTotal: 0,
			contextComplete: "unknown",
			contextCompleteReason: "no_matching_candidates",
			recommendedNextAction: "narrow_query",
			skippedCandidates: [],
		};
	}
	return {
		freshness: input.freshness,
		indexRevision: input.indexRevision,
		returnedTotal: input.returned.length,
		skippedTotal: 0,
		contextComplete: "complete",
		contextCompleteReason: "returned_all_candidates",
		recommendedNextAction: "use_bundle",
		skippedCandidates: [],
	};
}

export async function runSemanticSearch(input: SemanticSearchInput): Promise<SemanticSearchOutput> {
	const query = input.query.trim();
	if (!query) throw new Error("query must not be empty");
	const root = await realpath(input.root);
	const extensions = normalizeExtensions(input.extensions);
	const maxResults = Math.max(1, input.maxResults ?? DEFAULT_MAX_RESULTS);
	const chunkLines = Math.max(1, input.chunkLines ?? DEFAULT_CHUNK_LINES);
	const chunkOverlapLines = Math.max(0, input.chunkOverlapLines ?? DEFAULT_CHUNK_OVERLAP_LINES);
	const maxFileSizeBytes = Math.max(1, input.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES);
	const files = await collectFiles(root, new Set(extensions), maxFileSizeBytes);
	const warnings: string[] = [];
	const indexed = await buildChunks({
		root,
		files,
		extensions,
		chunkLines,
		chunkOverlapLines,
		symbolChunks: input.symbolChunks ?? false,
		useCache: input.useCache ?? false,
		reindex: input.reindex ?? false,
	});

	const lexicalScored = scoreChunks(query, indexed.chunks, indexed.chunks.length);
	let mode: "lexical" | "hybrid" = "lexical";
	let candidatePool = lexicalScored;
	let scored = lexicalScored.slice(0, maxResults);
	if (input.useEmbeddings && indexed.chunks.length > 0) {
		try {
			let queryForEmbedding = query;
			if (input.useHyde) {
				try {
					queryForEmbedding = await expandQueryWithHyde({
						baseUrl: input.hydeBaseUrl ?? input.embedBaseUrl ?? DEFAULT_EMBED_BASE_URL,
						endpoint: input.hydeEndpoint,
						model: input.hydeModel ?? DEFAULT_HYDE_MODEL,
						query,
					});
				} catch (error) {
					warnings.push(`HyDE completion failed (${error instanceof Error ? error.message : String(error)}); using plain query embedding`);
				}
			}
			const embeddings = await embedTexts({
				baseUrl: input.embedBaseUrl ?? DEFAULT_EMBED_BASE_URL,
				endpoint: input.embedEndpoint,
				model: input.embedModel ?? DEFAULT_EMBED_MODEL,
				texts: [queryForEmbedding, ...indexed.chunks.map((chunk) => chunk.textWithHeader)],
			});
			const queryEmbedding = embeddings[0] ?? [];
			let denseScored = scoreDenseChunks(queryEmbedding, embeddings.slice(1), indexed.chunks);
			if (input.qdrantBaseUrl && input.qdrantCollection) {
				try {
					const chunkEmbeddings = embeddings.slice(1);
					await upsertQdrantVectors({
						baseUrl: input.qdrantBaseUrl,
						collection: input.qdrantCollection,
						points: indexed.chunks.map((chunk, index) => ({
							id: chunk.id,
							vector: chunkEmbeddings[index] ?? [],
							payload: { chunkId: chunk.id },
						})),
					});
					const qdrantHits = await queryQdrantVectors({
						baseUrl: input.qdrantBaseUrl,
						collection: input.qdrantCollection,
						vector: queryEmbedding,
						limit: indexed.chunks.length,
					});
					const chunksById = new Map(indexed.chunks.map((chunk) => [chunk.id, chunk]));
					const qdrantScored = qdrantHits
						.map((hit) => {
							const chunk = chunksById.get(hit.chunkId);
							return chunk ? { chunk, score: hit.score } : undefined;
						})
						.filter((entry): entry is ScoredChunk => entry !== undefined);
					if (qdrantScored.length > 0) {
						denseScored = qdrantScored;
					}
				} catch (error) {
					warnings.push(`Qdrant path failed (${error instanceof Error ? error.message : String(error)}); using in-memory dense ranking`);
				}
			}
			candidatePool = reciprocalRankFuse(denseScored, lexicalScored, indexed.chunks.length);
			scored = candidatePool.slice(0, maxResults);
			mode = "hybrid";
		} catch (error) {
			warnings.push(`embedding path failed (${error instanceof Error ? error.message : String(error)}); falling back to lexical semantic search`);
		}
	}
	if (input.useRerank && scored.length > 0) {
		try {
			const reranked = await rerankSearchResults({
				baseUrl: input.rerankBaseUrl ?? input.embedBaseUrl ?? DEFAULT_EMBED_BASE_URL,
				endpoint: input.rerankEndpoint,
				model: input.rerankModel ?? DEFAULT_RERANK_MODEL,
				query,
				candidates: scored.map((entry) => ({ path: entry.chunk.path, text: entry.chunk.textWithHeader })),
			});
			const byIndex = reranked
				.filter((entry) => entry.index >= 0 && entry.index < scored.length)
				.map((entry) => ({ chunk: scored[entry.index].chunk, score: entry.score }));
			if (byIndex.length > 0) {
				scored = byIndex;
				candidatePool = uniqueScoredChunks([...byIndex, ...candidatePool]);
			}
		} catch (error) {
			warnings.push(`reranker path failed (${error instanceof Error ? error.message : String(error)}); using non-reranked results`);
		}
	}
	const receipt = buildReceipt({
		freshness: indexed.freshness,
		indexRevision: indexed.indexRevision,
		returned: scored,
		candidates: candidatePool,
	});
	return {
		query,
		root,
		mode,
		indexRebuilt: indexed.indexRebuilt,
		cachePath: indexed.cachePath,
		indexedFiles: indexed.indexedFiles,
		indexedChunks: indexed.chunks.length,
		receipt,
		warnings,
		results: scored.map((entry) => ({
			path: entry.chunk.path,
			startLine: entry.chunk.startLine,
			endLine: entry.chunk.endLine,
			score: Math.round(entry.score * 1000) / 1000,
			languageTier: entry.chunk.languageTier ?? "line-window",
			symbolName: entry.chunk.symbolName,
			symbolKind: entry.chunk.symbolKind,
			snippet: snippet(entry.chunk.text),
		})),
	};
}

function isWithinWorkspace(candidate: string, workspaceRoot: string): boolean {
	return candidate === workspaceRoot || candidate.startsWith(`${workspaceRoot}${sep}`);
}

async function resolveSearchRoot(cwd: string, path: string | undefined): Promise<string> {
	const workspaceRoot = await realpath(cwd);
	const rawPath = path?.trim();
	const absolutePath = rawPath ? (isAbsolute(rawPath) ? rawPath : resolve(workspaceRoot, rawPath)) : workspaceRoot;
	const resolvedPath = await realpath(absolutePath);
	if (!isWithinWorkspace(resolvedPath, workspaceRoot)) {
		throw new Error(`path escapes workspace: ${path}`);
	}
	return resolvedPath;
}

const semanticSearchSchema = Type.Object({
	query: Type.String({ description: "Search query." }),
	path: Type.Optional(Type.String({ description: "Optional workspace-relative directory or file subtree to search." })),
	maxResults: Type.Optional(Type.Number({ description: "Maximum results to return." })),
	extensions: Type.Optional(Type.Array(Type.String({ description: "File extension to include, with or without leading dot." }))),
	chunkLines: Type.Optional(Type.Number({ description: "Lines per chunk." })),
	chunkOverlapLines: Type.Optional(Type.Number({ description: "Line overlap between chunks." })),
	symbolChunks: Type.Optional(Type.Boolean({ description: "Use deterministic symbol-aware chunks when available." })),
	useCache: Type.Optional(Type.Boolean({ description: "Persist and reuse a local lexical index cache." })),
	reindex: Type.Optional(Type.Boolean({ description: "Force rebuilding the local lexical index cache." })),
	useEmbeddings: Type.Optional(Type.Boolean({ description: "Use local embeddings and hybrid dense/lexical retrieval." })),
	embedBaseUrl: Type.Optional(Type.String({ description: "OpenAI-compatible embeddings base URL." })),
	embedEndpoint: Type.Optional(Type.String({ description: "Embeddings endpoint path." })),
	embedModel: Type.Optional(Type.String({ description: "Embeddings model name." })),
	useHyde: Type.Optional(Type.Boolean({ description: "Use a local completion endpoint to expand the dense query." })),
	hydeBaseUrl: Type.Optional(Type.String({ description: "OpenAI/llama.cpp-compatible completion base URL for HyDE." })),
	hydeEndpoint: Type.Optional(Type.String({ description: "HyDE completion endpoint path." })),
	hydeModel: Type.Optional(Type.String({ description: "HyDE completion model name." })),
	useRerank: Type.Optional(Type.Boolean({ description: "Use a local reranker endpoint to reorder candidate chunks." })),
	rerankBaseUrl: Type.Optional(Type.String({ description: "Reranker base URL." })),
	rerankEndpoint: Type.Optional(Type.String({ description: "Reranker endpoint path." })),
	rerankModel: Type.Optional(Type.String({ description: "Reranker model name." })),
	qdrantBaseUrl: Type.Optional(Type.String({ description: "Optional Qdrant HTTP base URL for dense vector search." })),
	qdrantCollection: Type.Optional(Type.String({ description: "Qdrant collection name for semantic_search vectors." })),
});

type SemanticSearchParams = Static<typeof semanticSearchSchema>;

export function createSemanticSearchTool(cwd: string): AgentTool<typeof semanticSearchSchema, SemanticSearchOutput> {
	return {
		label: "Semantic search",
		name: "semantic_search",
		description: "Run deterministic lexical semantic search over workspace source files.",
		parameters: semanticSearchSchema,
		executionMode: "parallel",
		execute: async (_toolCallId: string, params: SemanticSearchParams) => {
			const root = await resolveSearchRoot(cwd, params.path);
			const result = await runSemanticSearch({
				root,
				query: params.query,
				extensions: params.extensions,
				maxResults: params.maxResults,
				chunkLines: params.chunkLines,
				chunkOverlapLines: params.chunkOverlapLines,
				symbolChunks: params.symbolChunks,
				useCache: params.useCache,
				reindex: params.reindex,
				useEmbeddings: params.useEmbeddings,
				embedBaseUrl: params.embedBaseUrl,
				embedEndpoint: params.embedEndpoint,
				embedModel: params.embedModel,
				useHyde: params.useHyde,
				hydeBaseUrl: params.hydeBaseUrl,
				hydeEndpoint: params.hydeEndpoint,
				hydeModel: params.hydeModel,
				useRerank: params.useRerank,
				rerankBaseUrl: params.rerankBaseUrl,
				rerankEndpoint: params.rerankEndpoint,
				rerankModel: params.rerankModel,
				qdrantBaseUrl: params.qdrantBaseUrl,
				qdrantCollection: params.qdrantCollection,
			});
			const lines = [
				`semantic_search mode=${result.mode} indexed_files=${result.indexedFiles} indexed_chunks=${result.indexedChunks}`,
				`receipt freshness=${result.receipt.freshness} revision=${result.receipt.indexRevision} complete=${result.receipt.contextComplete} next=${result.receipt.recommendedNextAction} returned=${result.receipt.returnedTotal} skipped=${result.receipt.skippedTotal}`,
				...result.results.map(
					(entry) =>
						`- ${entry.path}:${entry.startLine}-${entry.endLine} score=${entry.score.toFixed(3)} ${entry.snippet}`,
				),
			];
			return {
				content: [{ type: "text", text: `${lines.join("\n")}\n` }],
				details: result,
			};
		},
	};
}
