import { createHash } from "node:crypto";
import { type Dirent, type FSWatcher, type Stats, watch } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import ignore from "ignore";
import type { WorkspaceEmbeddingRuntimeManager } from "./workspace-embedding-runtime-manager.ts";
import { parseWorkspaceChunks, type WorkspaceSemanticChunk } from "./workspace-parser.ts";

export type WorkspaceSemanticIndexStatus = "not_started" | "scanning" | "lexical_ready" | "failed";
export type WorkspaceSemanticVectorStatus = "disabled" | "not_started" | "building" | "ready" | "failed";

export interface WorkspaceSemanticEmbeddingProvider {
	/** Optional stable identity for callers that persist or share embedding configuration. */
	id?: string;
	embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface WorkspaceSemanticRerankCandidate {
	chunkId: string;
	path: string;
	fileRevision: string;
	startLine: number;
	endLine: number;
	text: string;
	snippet: string;
	lexicalScore: number;
	semanticScore?: number;
	languageTier: WorkspaceSemanticChunk["languageTier"];
	symbolName?: string;
	symbolKind?: string;
}

export interface WorkspaceSemanticRerankProvider {
	/** Optional stable identity for callers that persist or share reranker configuration. */
	id?: string;
	rerank(query: string, candidates: WorkspaceSemanticRerankCandidate[], signal?: AbortSignal): Promise<number[]>;
}

export interface WorkspaceSemanticRelatedContext {
	kind: "test";
	path: string;
	why: string;
	readRequest: {
		path: string;
		mode: "range";
		startLine: number;
		maxLines: number;
	};
}

export interface WorkspaceSemanticIndexResult {
	chunkId: string;
	path: string;
	fileRevision: string;
	startLine: number;
	endLine: number;
	retrievalType: "lexical" | "semantic" | "hybrid";
	lexicalScore: number;
	semanticScore?: number;
	rerankScore?: number;
	snippet: string;
	why: string;
	languageTier: WorkspaceSemanticChunk["languageTier"];
	symbolName?: string;
	symbolKind?: string;
	related?: WorkspaceSemanticRelatedContext[];
	readRequest: {
		path: string;
		mode: "range";
		startLine: number;
		maxLines: number;
	};
}

export interface WorkspaceSemanticSearchResponse {
	results: WorkspaceSemanticIndexResult[];
	status: WorkspaceSemanticIndexStatus;
	vectorStatus: WorkspaceSemanticVectorStatus;
	completeness: "complete" | "incomplete";
	freshness: "clean" | "unknown";
	indexRevision: string;
	indexedFiles: number;
	novelResults: number;
	overlapWarning?: string;
	recommendedNextAction?: "narrow_query";
	vectorWarning?: string;
	rerankWarning?: string;
}

export interface WorkspaceSemanticIndexOptions {
	maxFiles?: number;
	maxTotalBytes?: number;
	maxFileSizeBytes?: number;
	watch?: boolean;
	persist?: boolean;
	cachePath?: string;
	maxCacheBytes?: number;
	embeddingBatchSize?: number;
	embedding?: WorkspaceSemanticEmbeddingProvider;
	embeddingRuntime?: WorkspaceEmbeddingRuntimeManager;
	reranker?: WorkspaceSemanticRerankProvider;
}

interface IndexedFile {
	path: string;
	chunks: WorkspaceSemanticChunk[];
	revision: string;
}

function isWorkspaceSemanticChunk(value: unknown): value is WorkspaceSemanticChunk {
	if (!value || typeof value !== "object") return false;
	const chunk = value as Record<string, unknown>;
	return (
		typeof chunk.text === "string" &&
		typeof chunk.startLine === "number" &&
		typeof chunk.endLine === "number" &&
		Number.isInteger(chunk.startLine) &&
		Number.isInteger(chunk.endLine) &&
		chunk.startLine >= 1 &&
		chunk.endLine >= chunk.startLine &&
		(chunk.languageTier === "structured" || chunk.languageTier === "line-window") &&
		(chunk.symbolName === undefined || typeof chunk.symbolName === "string") &&
		(chunk.symbolKind === undefined || typeof chunk.symbolKind === "string")
	);
}

function isIndexedFile(path: string, value: unknown): value is IndexedFile {
	if (!value || typeof value !== "object") return false;
	const file = value as Record<string, unknown>;
	return (
		file.path === path &&
		typeof file.revision === "string" &&
		Array.isArray(file.chunks) &&
		file.chunks.every((chunk: unknown) => isWorkspaceSemanticChunk(chunk))
	);
}

interface LexicalIndexCache {
	schemaVersion: 1;
	parserVersion: "workspace-parser-v1";
	chunkSchemaVersion: 1;
	root: string;
	indexRevision: string;
	files: Record<string, IndexedFile>;
}

const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILE_SIZE_BYTES = 512 * 1024;
const DEFAULT_CACHE_NAME = ".semantic_search/index.json";
const DEFAULT_MAX_CACHE_BYTES = 8 * 1024 * 1024;
const DEFAULT_EMBEDDING_BATCH_SIZE = 32;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "target", ".semantic_search"]);

function isBinary(buffer: Buffer): boolean {
	return buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
}

function queryTerms(query: string): string[] {
	return [
		...new Set(
			query
				.toLowerCase()
				.split(/[^a-z0-9_$.-]+/)
				.filter((term) => term.length > 0),
		),
	];
}

function chunkId(path: string, revision: string, startLine: number, endLine: number, text: string): string {
	return createHash("sha256").update(`${path}:${revision}:${startLine}:${endLine}:${text}`).digest("hex");
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

function isVector(value: unknown): value is number[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
	);
}

function fileStem(path: string): string {
	return basename(path, extname(path)).replace(/\.(test|spec)$/u, "");
}

function isTestPath(path: string): boolean {
	return /\.(test|spec)\.[cm]?[jt]sx?$/u.test(path);
}

export class WorkspaceSemanticIndex {
	readonly root: string;
	readonly cachePath: string;
	private readonly options: Omit<
		Required<WorkspaceSemanticIndexOptions>,
		"embedding" | "embeddingRuntime" | "reranker"
	> & {
		embedding?: WorkspaceSemanticEmbeddingProvider;
		reranker?: WorkspaceSemanticRerankProvider;
	};
	private readonly files = new Map<string, IndexedFile>();
	private readonly returnedChunkIds = new Set<string>();
	private readonly watchers: FSWatcher[] = [];
	private readonly scannedDirectories = new Set<string>();
	private readonly vectors = new Map<string, number[]>();
	private refreshTimer?: ReturnType<typeof setTimeout>;
	private controller?: AbortController;
	private resolveReady!: () => void;
	private readyPromise!: Promise<void>;
	private resolveVectorsReady!: () => void;
	private vectorsReadyPromise!: Promise<void>;
	private _status: WorkspaceSemanticIndexStatus = "not_started";
	private _vectorStatus: WorkspaceSemanticVectorStatus;
	private _vectorWarning?: string;
	private _indexRevision = "empty";
	private _loadedFromCache = false;
	private _cacheCompacted = false;

	constructor(root: string, options: WorkspaceSemanticIndexOptions = {}) {
		this.root = resolve(root);
		this.cachePath = resolve(options.cachePath ?? resolve(this.root, DEFAULT_CACHE_NAME));
		this.options = {
			maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
			maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
			maxFileSizeBytes: options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES,
			watch: options.watch ?? false,
			persist: options.persist ?? true,
			cachePath: this.cachePath,
			maxCacheBytes: options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES,
			embeddingBatchSize: Number.isFinite(options.embeddingBatchSize)
				? Math.max(1, Math.floor(options.embeddingBatchSize as number))
				: DEFAULT_EMBEDDING_BATCH_SIZE,
			embedding: options.embedding,
			reranker: options.reranker,
		};
		this._vectorStatus = this.options.embedding ? "not_started" : "disabled";
		this.resetReadyPromise();
		this.resetVectorsReadyPromise();
	}

	get status(): WorkspaceSemanticIndexStatus {
		return this._status;
	}

	get indexRevision(): string {
		return this._indexRevision;
	}

	get ready(): Promise<void> {
		return this.readyPromise;
	}

	get vectorStatus(): WorkspaceSemanticVectorStatus {
		return this._vectorStatus;
	}

	get vectorProviderId(): string | undefined {
		return this.options.embedding?.id;
	}

	get vectorsReady(): Promise<void> {
		return this.vectorsReadyPromise;
	}

	get loadedFromCache(): boolean {
		return this._loadedFromCache;
	}

	get cacheCompacted(): boolean {
		return this._cacheCompacted;
	}

	start(): void {
		if (this._status === "scanning" || this._status === "lexical_ready") return;
		this.resetReadyPromise();
		this.controller = new AbortController();
		this._status = "scanning";
		void this.build(this.controller.signal);
	}

	async refresh(): Promise<void> {
		this.closeWatchers();
		const isScanning = this._status === "scanning";
		const isVectorBuilding = this._vectorStatus === "building";
		if (isScanning || isVectorBuilding) {
			this.controller?.abort();
			if (isScanning) this.resolveReady();
			if (isVectorBuilding) this.resolveVectorsReady();
		}
		this.controller = new AbortController();
		this.files.clear();
		this.vectors.clear();
		this.returnedChunkIds.clear();
		this._loadedFromCache = false;
		this._indexRevision = "empty";
		this._vectorStatus = this.options.embedding ? "not_started" : "disabled";
		this._vectorWarning = undefined;
		this.resetReadyPromise();
		this.resetVectorsReadyPromise();
		this._status = "scanning";
		await this.build(this.controller.signal);
	}

	cancel(): void {
		const isIndexing = this._status === "scanning" || this._vectorStatus === "building";
		if (isIndexing) this.controller?.abort();
		this.closeWatchers();
		if (!isIndexing) return;
		this.controller = undefined;
		this.files.clear();
		this.vectors.clear();
		this.returnedChunkIds.clear();
		this._loadedFromCache = false;
		this._indexRevision = "empty";
		this._vectorStatus = this.options.embedding ? "not_started" : "disabled";
		this._vectorWarning = undefined;
		this._status = "not_started";
		this.resolveReady();
		this.resolveVectorsReady();
	}

	async search(
		query: string,
		options: { limit?: number; signal?: AbortSignal } = {},
	): Promise<WorkspaceSemanticSearchResponse> {
		const terms = queryTerms(query);
		if (terms.length === 0) return this.response([], this._status !== "lexical_ready");
		const wasScanning = this._status === "scanning";

		if (this.files.size === 0 && this._status === "scanning") await this.loadCache(options.signal);
		if (this.files.size === 0 && this._status === "scanning") await this.scanFiles(options.signal, true);
		const semantic = await this.semanticScores(query, options.signal);
		const limit = Math.max(1, options.limit ?? 8);
		const rankedResults = [...this.files.values()].flatMap((file) =>
			file.chunks.flatMap((chunk) => {
				const chunkIdValue = chunkId(file.path, file.revision, chunk.startLine, chunk.endLine, chunk.text);
				const lower = chunk.text.toLowerCase();
				const matches = terms.filter((term) => lower.includes(term)).length;
				const lexicalScore = matches / terms.length;
				const semanticScore = semantic.scores.get(chunkIdValue);
				if (matches === 0 && semanticScore === undefined) return [];
				const firstTerm = terms.find((term) => lower.includes(term)) ?? terms[0];
				const offset = Math.max(0, lower.indexOf(firstTerm));
				const start = Math.max(0, chunk.text.lastIndexOf("\n", offset) + 1);
				const end = chunk.text.indexOf("\n", offset);
				const snippet = chunk.text.slice(start, end === -1 ? chunk.text.length : end).trim();
				const retrievalType: WorkspaceSemanticIndexResult["retrievalType"] =
					semanticScore === undefined ? "lexical" : matches === 0 ? "semantic" : "hybrid";
				const rank = semanticScore === undefined ? lexicalScore : semanticScore + lexicalScore * 0.001;
				return [
					{
						rank,
						text: chunk.text,
						result: {
							chunkId: chunkIdValue,
							path: file.path,
							fileRevision: file.revision,
							startLine: chunk.startLine + chunk.text.slice(0, offset).split("\n").length - 1,
							endLine:
								chunk.startLine +
								chunk.text.slice(0, end === -1 ? chunk.text.length : end).split("\n").length -
								1,
							retrievalType,
							lexicalScore,
							semanticScore,
							snippet,
							why:
								semanticScore === undefined
									? `matched ${matches} of ${terms.length} query terms`
									: `semantic similarity ${semanticScore.toFixed(3)}${matches > 0 ? `; matched ${matches} of ${terms.length} query terms` : ""}`,
							languageTier: chunk.languageTier,
							symbolName: chunk.symbolName,
							symbolKind: chunk.symbolKind,
							readRequest: {
								path: file.path,
								mode: "range" as const,
								startLine: chunk.startLine,
								maxLines: chunk.endLine - chunk.startLine + 1,
							},
						},
					},
				];
			}),
		);
		const reranked = await this.rerank(query, rankedResults, options.signal);
		const results = reranked.results
			.sort(
				(left, right) =>
					right.rank - left.rank ||
					left.result.path.localeCompare(right.result.path) ||
					left.result.startLine - right.result.startLine,
			)
			.slice(0, limit);
		const resultValues = results.map((entry) => ({
			...entry.result,
			related: this.relatedTests(entry.result),
		}));
		const novelResults = resultValues.filter((result) => !this.returnedChunkIds.has(result.chunkId)).length;
		for (const result of resultValues) this.returnedChunkIds.add(result.chunkId);
		return this.response(
			resultValues,
			wasScanning || this._status !== "lexical_ready",
			novelResults,
			semantic.warning,
			reranked.warning,
		);
	}

	private response(
		results: WorkspaceSemanticIndexResult[],
		incomplete: boolean,
		novelResults = results.length,
		vectorWarning?: string,
		rerankWarning?: string,
	): WorkspaceSemanticSearchResponse {
		return {
			results,
			status: this._status,
			vectorStatus: this._vectorStatus,
			completeness: incomplete ? "incomplete" : "complete",
			freshness: this._status === "lexical_ready" ? "clean" : "unknown",
			indexRevision: this._indexRevision,
			indexedFiles: this.files.size,
			novelResults,
			overlapWarning:
				results.length > 0 && novelResults === 0
					? "This retrieval added little novel context; narrow the query or read a larger scope."
					: undefined,
			recommendedNextAction: results.length > 0 && novelResults === 0 ? "narrow_query" : undefined,
			vectorWarning: vectorWarning ?? this._vectorWarning,
			rerankWarning,
		};
	}

	private async rerank(
		query: string,
		rankedResults: Array<{ rank: number; text: string; result: WorkspaceSemanticIndexResult }>,
		signal: AbortSignal | undefined,
	): Promise<{
		results: Array<{ rank: number; result: WorkspaceSemanticIndexResult }>;
		warning?: string;
	}> {
		if (!this.options.reranker || rankedResults.length === 0) return { results: rankedResults };
		try {
			const candidates = rankedResults.map(
				({ result, text }): WorkspaceSemanticRerankCandidate => ({
					chunkId: result.chunkId,
					path: result.path,
					fileRevision: result.fileRevision,
					startLine: result.startLine,
					endLine: result.endLine,
					text,
					snippet: result.snippet,
					lexicalScore: result.lexicalScore,
					semanticScore: result.semanticScore,
					languageTier: result.languageTier,
					symbolName: result.symbolName,
					symbolKind: result.symbolKind,
				}),
			);
			const scores = await this.options.reranker.rerank(query, candidates, signal);
			if (
				scores.length !== rankedResults.length ||
				!scores.every((score) => typeof score === "number" && Number.isFinite(score))
			) {
				throw new Error("reranker returned an invalid score batch");
			}
			return {
				results: rankedResults.map((entry, index) => ({
					rank: scores[index],
					result: { ...entry.result, rerankScore: scores[index] },
				})),
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			return {
				results: rankedResults,
				warning: `Reranking failed (${error instanceof Error ? error.message : String(error)}); using lexical/semantic ranking`,
			};
		}
	}

	private relatedTests(result: WorkspaceSemanticIndexResult): WorkspaceSemanticRelatedContext[] | undefined {
		if (isTestPath(result.path)) return undefined;
		const sourceStem = fileStem(result.path);
		const related = [...this.files.values()]
			.filter((file) => file.path !== result.path && isTestPath(file.path) && fileStem(file.path) === sourceStem)
			.sort((left, right) => left.path.localeCompare(right.path))
			.flatMap((file) => {
				const chunk = file.chunks[0];
				if (!chunk) return [];
				return [
					{
						kind: "test" as const,
						path: file.path,
						why: "same basename test/spec file",
						readRequest: {
							path: file.path,
							mode: "range" as const,
							startLine: chunk.startLine,
							maxLines: Math.min(80, chunk.endLine - chunk.startLine + 1),
						},
					},
				];
			})
			.slice(0, 2);
		return related.length > 0 ? related : undefined;
	}

	private async semanticScores(
		query: string,
		signal: AbortSignal | undefined,
	): Promise<{ scores: Map<string, number>; warning?: string }> {
		if (!this.options.embedding || this._vectorStatus !== "ready") return { scores: new Map() };
		try {
			const vectors = await this.options.embedding.embed([query], signal);
			const queryVector = vectors[0];
			if (!isVector(queryVector)) throw new Error("embedding provider returned an invalid query vector");
			const scores = new Map<string, number>();
			for (const file of this.files.values()) {
				for (const chunk of file.chunks) {
					const vector = this.vectors.get(
						chunkId(file.path, file.revision, chunk.startLine, chunk.endLine, chunk.text),
					);
					if (!vector || vector.length !== queryVector.length) continue;
					const score = cosineSimilarity(queryVector, vector);
					if (score > 0)
						scores.set(chunkId(file.path, file.revision, chunk.startLine, chunk.endLine, chunk.text), score);
				}
			}
			return { scores };
		} catch (error) {
			if (signal?.aborted) throw error;
			return {
				scores: new Map(),
				warning: `Vector query failed (${error instanceof Error ? error.message : String(error)}); using lexical search`,
			};
		}
	}

	private resetReadyPromise(): void {
		this.readyPromise = new Promise<void>((resolveReady) => {
			this.resolveReady = resolveReady;
		});
	}

	private resetVectorsReadyPromise(): void {
		this.vectorsReadyPromise = new Promise<void>((resolveVectorsReady) => {
			this.resolveVectorsReady = resolveVectorsReady;
		});
		if (!this.options.embedding) this.resolveVectorsReady();
	}

	private startWatcher(): void {
		if (this.watchers.length > 0) return;
		for (const directory of this.scannedDirectories) {
			try {
				this.watchers.push(
					watch(directory, { persistent: false }, () => {
						if (this._status !== "scanning") this.scheduleRefresh();
					}),
				);
			} catch {
				// A workspace directory may not support watching; lexical search remains usable.
			}
		}
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refresh();
		}, 50);
	}

	private closeWatchers(): void {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
		for (const watcher of this.watchers.splice(0)) watcher.close();
	}

	private async build(signal: AbortSignal): Promise<void> {
		try {
			await this.loadCache(signal);
			await this.scanFiles(signal, false);
			if (signal.aborted) return;
			this._indexRevision = createHash("sha256")
				.update([...this.files.values()].map((file) => `${file.path}:${file.revision}`).join("\n"))
				.digest("hex");
			await this.persistCache(signal);
			this._status = "lexical_ready";
			if (this.options.watch) this.startWatcher();
			this.resolveReady();
			if (this.options.embedding) void this.buildVectors(signal);
			else this.resolveVectorsReady();
		} catch {
			if (!signal.aborted) {
				this._status = "failed";
				if (this.options.embedding) {
					this._vectorStatus = "failed";
					this.resolveVectorsReady();
				} else {
					this.resolveVectorsReady();
				}
				this.resolveReady();
			}
		}
	}

	private async buildVectors(signal: AbortSignal): Promise<void> {
		const embedding = this.options.embedding;
		if (!embedding) return;
		this._vectorStatus = "building";
		const chunks = [...this.files.values()].flatMap((file) => file.chunks.map((chunk) => ({ file, chunk })));
		if (chunks.length === 0) {
			this._vectorStatus = "ready";
			this.resolveVectorsReady();
			return;
		}
		try {
			const vectors: number[][] = [];
			for (let start = 0; start < chunks.length; start += this.options.embeddingBatchSize) {
				if (signal.aborted) return;
				const batch = chunks.slice(start, start + this.options.embeddingBatchSize);
				const batchVectors = await embedding.embed(
					batch.map(({ chunk }) => chunk.text),
					signal,
				);
				if (batchVectors.length !== batch.length || !batchVectors.every(isVector)) {
					throw new Error("embedding provider returned an invalid document vector batch");
				}
				vectors.push(...batchVectors);
			}
			if (signal.aborted) return;
			const dimension = vectors[0].length;
			if (vectors.some((vector) => vector.length !== dimension)) {
				throw new Error("embedding provider returned inconsistent vector dimensions");
			}
			this.vectors.clear();
			for (let index = 0; index < chunks.length; index += 1) {
				const { file, chunk } = chunks[index];
				this.vectors.set(
					chunkId(file.path, file.revision, chunk.startLine, chunk.endLine, chunk.text),
					vectors[index],
				);
			}
			this._vectorStatus = "ready";
			this._vectorWarning = undefined;
			this.resolveVectorsReady();
		} catch (error) {
			if (!signal.aborted) {
				this.vectors.clear();
				this._vectorStatus = "failed";
				this._vectorWarning = `Vector index build failed (${error instanceof Error ? error.message : String(error)}); using lexical search`;
				this.resolveVectorsReady();
			}
		}
	}

	private async scanFiles(signal: AbortSignal | undefined, fallback: boolean): Promise<void> {
		const matcher = ignore();
		try {
			const gitignore = await readFile(resolve(this.root, ".gitignore"), "utf8");
			matcher.add(gitignore);
		} catch {
			// A workspace does not need a .gitignore to be searchable.
		}
		let totalBytes = 0;
		let count = 0;
		const scannedFiles = new Map<string, IndexedFile>();
		if (!fallback) this.scannedDirectories.clear();
		const visit = async (directory: string): Promise<void> => {
			if (!fallback) this.scannedDirectories.add(directory);
			if (signal?.aborted || count >= this.options.maxFiles || (fallback && count >= 50)) return;
			let entries: Dirent[];
			try {
				entries = await readdir(directory, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (signal?.aborted || count >= this.options.maxFiles || (fallback && count >= 50)) return;
				if (entry.name === ".gitignore") continue;
				const absolutePath = resolve(directory, entry.name);
				const relativePath = relative(this.root, absolutePath).replaceAll("\\", "/");
				if (entry.isDirectory()) {
					if (!IGNORED_DIRECTORIES.has(entry.name) && !matcher.ignores(`${relativePath}/`))
						await visit(absolutePath);
					continue;
				}
				if (!entry.isFile() || matcher.ignores(relativePath)) continue;
				let fileStat: Stats;
				try {
					fileStat = await stat(absolutePath);
				} catch {
					continue;
				}
				if (
					fileStat.size > this.options.maxFileSizeBytes ||
					totalBytes + fileStat.size > this.options.maxTotalBytes
				)
					continue;
				const buffer = await readFile(absolutePath);
				if (isBinary(buffer)) continue;
				totalBytes += buffer.length;
				const text = buffer.toString("utf8");
				scannedFiles.set(relativePath, {
					path: relativePath,
					chunks: parseWorkspaceChunks(relativePath, text),
					revision: createHash("sha256").update(buffer).digest("hex"),
				});
				count++;
			}
		};
		await visit(this.root);
		if (!fallback) this.files.clear();
		for (const [path, file] of scannedFiles) this.files.set(path, file);
	}

	private async loadCache(signal: AbortSignal | undefined): Promise<void> {
		if (!this.options.persist || this._loadedFromCache || signal?.aborted) return;
		this._loadedFromCache = true;
		try {
			const parsed = JSON.parse(await readFile(this.cachePath, "utf8")) as Partial<LexicalIndexCache>;
			if (
				parsed.schemaVersion !== 1 ||
				parsed.parserVersion !== "workspace-parser-v1" ||
				parsed.chunkSchemaVersion !== 1 ||
				parsed.root !== this.root ||
				typeof parsed.indexRevision !== "string" ||
				!parsed.files
			)
				return;
			this.files.clear();
			for (const [path, file] of Object.entries(parsed.files as Record<string, unknown>)) {
				if (!isIndexedFile(path, file)) continue;
				this.files.set(path, file);
			}
			this._indexRevision = parsed.indexRevision;
		} catch {
			// A missing or invalid cache falls back to a fresh bounded scan.
		}
	}

	private async persistCache(signal: AbortSignal): Promise<void> {
		if (!this.options.persist || signal.aborted) return;
		let cache: LexicalIndexCache = {
			schemaVersion: 1,
			parserVersion: "workspace-parser-v1",
			chunkSchemaVersion: 1,
			root: this.root,
			indexRevision: this._indexRevision,
			files: Object.fromEntries(this.files),
		};
		this._cacheCompacted = false;
		let serialized = JSON.stringify(cache);
		const entries = Object.entries(cache.files);
		while (Buffer.byteLength(serialized, "utf8") > this.options.maxCacheBytes && entries.length > 0) {
			entries.sort(
				(left, right) =>
					Buffer.byteLength(JSON.stringify(right[1]), "utf8") -
						Buffer.byteLength(JSON.stringify(left[1]), "utf8") || left[0].localeCompare(right[0]),
			);
			const entry = entries.shift();
			if (!entry) break;
			cache = { ...cache, files: Object.fromEntries(entries) };
			serialized = JSON.stringify(cache);
			this._cacheCompacted = true;
		}
		if (Buffer.byteLength(serialized, "utf8") > this.options.maxCacheBytes) return;
		try {
			await mkdir(dirname(this.cachePath), { recursive: true });
			await writeFile(this.cachePath, serialized, "utf8");
		} catch {
			// Search remains available when the workspace cache is not writable.
		}
	}
}
