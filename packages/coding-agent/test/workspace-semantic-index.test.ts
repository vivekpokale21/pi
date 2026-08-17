import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	createSemanticIndexOptionsFromEnv,
} from "../src/core/agent-session-services.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createReadTool, type ReadToolInput } from "../src/core/tools/read.ts";
import { createSemanticSearchToolDefinition } from "../src/core/tools/semantic-search.ts";
import { WorkspaceSemanticIndex } from "../src/core/workspace-semantic-index.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-semantic-index-"));
	tempDirs.push(path);
	return path;
}

afterEach(() => {
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("WorkspaceSemanticIndex", () => {
	it("activates semantic_search in a default native session", async () => {
		const root = tempDir();
		const index = new WorkspaceSemanticIndex(root, { persist: false });
		index.start();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.create(root, root),
			semanticIndex: index,
		});

		try {
			expect(session.getActiveToolNames()).toContain("semantic_search");
		} finally {
			session.dispose();
			index.cancel();
		}
	});

	it("creates a cwd-bound index for direct SDK sessions", async () => {
		const root = tempDir();
		writeFileSync(join(root, "headless.ts"), "export const headlessSearch = true;\n");
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.create(root, root),
		});

		try {
			const semanticSearch = session.agent.state.tools.find((tool) => tool.name === "semantic_search");
			expect(semanticSearch).toBeDefined();
			const result = await semanticSearch!.execute(
				"headless-search",
				{ query: "headlessSearch" },
				undefined,
				undefined,
			);
			expect(result.details?.results[0]?.path).toBe("headless.ts");
		} finally {
			session.dispose();
		}
	});

	it("passes shared semantic index options through service-created sessions", async () => {
		const root = tempDir();
		writeFileSync(join(root, "vector.ts"), "export const serviceVectorNeedle = true;\n");
		const embeddedBatches: string[][] = [];
		const services = await createAgentSessionServices({
			cwd: root,
			agentDir: root,
			settingsManager: SettingsManager.create(root, root),
			semanticIndexOptions: {
				persist: false,
				embedding: {
					id: "test-vector-provider",
					embed: async (texts) => {
						embeddedBatches.push(texts);
						return texts.map((text) =>
							text.includes("serviceVectorNeedle") || text.includes("semantic query") ? [1, 0] : [0, 1],
						);
					},
				},
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(root),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});

		try {
			await services.semanticIndex.ready;
			await services.semanticIndex.vectorsReady;
			const semanticSearch = session.agent.state.tools.find((tool) => tool.name === "semantic_search");
			const result = await semanticSearch!.execute(
				"search",
				{ query: "semantic query", limit: 1 },
				undefined,
				undefined,
			);

			expect(services.semanticIndex.vectorStatus).toBe("ready");
			expect(result.details?.vectorStatus).toBe("ready");
			expect(result.details?.results[0]).toMatchObject({
				path: "vector.ts",
				retrievalType: "semantic",
				semanticScore: 1,
			});
			expect(embeddedBatches.length).toBeGreaterThan(1);
		} finally {
			session.dispose();
			await services.dispose?.();
		}
	});

	it("builds shared semantic index options from Pi embedding environment settings", () => {
		const options = createSemanticIndexOptionsFromEnv({
			PI_SEMANTIC_EMBEDDING_BASE_URL: "http://127.0.0.1:8129/v1",
			PI_SEMANTIC_EMBEDDING_MODEL: "nomic-ai/CodeRankEmbed",
			PI_SEMANTIC_EMBEDDING_BATCH_SIZE: "4",
		});

		expect(options.embedding?.id).toBe("nomic-ai/CodeRankEmbed");
		expect(options.embeddingBatchSize).toBe(4);
	});

	it("starts in the background and searches lexical content before readiness", async () => {
		const root = tempDir();
		writeFileSync(join(root, "runtime.ts"), "export function startRuntime() { return true; }\n");

		const index = new WorkspaceSemanticIndex(root);
		index.start();

		expect(index.status).toBe("scanning");
		const partial = await index.search("startRuntime");
		expect(partial.results[0]?.path).toBe("runtime.ts");
		expect(partial.completeness).toBe("incomplete");
		expect(partial).toMatchObject({ status: "scanning" });

		await index.ready;
		expect(index.status).toBe("lexical_ready");
		const complete = await index.search("startRuntime");
		expect(complete.completeness).toBe("complete");
		expect(complete).toMatchObject({ status: "lexical_ready" });
		expect(complete.results[0]?.retrievalType).toBe("lexical");
		expect(complete.results[0]?.fileRevision).toMatch(/^[a-f0-9]{64}$/);
	});

	it("uses optional vectors for semantic matches absent from lexical terms", async () => {
		const root = tempDir();
		writeFileSync(join(root, "canvas.ts"), "export function drawCanvas() { return true; }\n");
		writeFileSync(join(root, "auth.ts"), "export function readCredential() { return true; }\n");
		const options = {
			embedding: {
				embed: async (texts: string[]) =>
					texts.map((text) =>
						text.toLowerCase().includes("canvas") || text.includes("visual") ? [1, 0] : [0, 1],
					),
			},
		};
		const index = new WorkspaceSemanticIndex(root, options);
		index.start();
		await index.ready;
		await index.vectorsReady;
		expect(index.vectorStatus).toBe("ready");

		const result = await index.search("visual behavior");

		expect(result.results[0]?.path).toBe("canvas.ts");
		expect(result.vectorStatus).toBe("ready");
		expect(result.results[0]).toMatchObject({ retrievalType: "semantic", semanticScore: 1 });
	});

	it("uses an optional reranker to reorder candidates and report rerank scores", async () => {
		const root = tempDir();
		writeFileSync(join(root, "first.ts"), "export const rerankNeedle = 'less relevant';\n");
		writeFileSync(join(root, "second.ts"), "export const rerankNeedle = 'more relevant';\n");
		const index = new WorkspaceSemanticIndex(root, {
			reranker: {
				rerank: async (_query, candidates) =>
					candidates.map((candidate) => (candidate.path === "second.ts" ? 10 : 1)),
			},
		});
		index.start();
		await index.ready;

		const result = await index.search("rerankNeedle", { limit: 2 });

		expect(result.results.map((item) => item.path)).toEqual(["second.ts", "first.ts"]);
		expect(result.results[0]?.rerankScore).toBe(10);
		expect(result.rerankWarning).toBeUndefined();
	});

	it("falls back to lexical ranking when optional reranking fails", async () => {
		const root = tempDir();
		writeFileSync(join(root, "a.ts"), "export const rerankFallback = 'a';\n");
		writeFileSync(join(root, "b.ts"), "export const rerankFallback = 'b';\n");
		const index = new WorkspaceSemanticIndex(root, {
			reranker: {
				rerank: async () => {
					throw new Error("reranker unavailable");
				},
			},
		});
		index.start();
		await index.ready;

		const result = await index.search("rerankFallback", { limit: 2 });

		expect(result.results.map((item) => item.path)).toEqual(["a.ts", "b.ts"]);
		expect(result.results[0]?.rerankScore).toBeUndefined();
		expect(result.rerankWarning).toContain("Reranking failed");
	});

	it("bounds document embedding requests by batch size", async () => {
		const root = tempDir();
		for (const name of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) {
			writeFileSync(join(root, name), `export const ${name[0]} = true;\n`);
		}
		const batchSizes: number[] = [];
		const index = new WorkspaceSemanticIndex(root, {
			embeddingBatchSize: 2,
			embedding: {
				embed: async (texts) => {
					batchSizes.push(texts.length);
					return texts.map(() => [1, 0]);
				},
			},
		});
		index.start();
		await index.ready;
		await index.vectorsReady;

		expect(batchSizes).toEqual([2, 2, 1]);
	});

	it("falls back to lexical search when vector indexing fails", async () => {
		const root = tempDir();
		writeFileSync(join(root, "fallback.ts"), "export const lexicalFallback = true;\n");
		const index = new WorkspaceSemanticIndex(root, {
			embedding: {
				embed: async () => {
					throw new Error("embedding service unavailable");
				},
			},
		});
		index.start();
		await index.ready;
		await index.vectorsReady;

		expect(index.vectorStatus).toBe("failed");
		const result = await index.search("lexicalFallback");

		expect(result.results[0]).toMatchObject({ path: "fallback.ts", retrievalType: "lexical" });
		expect(result.vectorWarning).toContain("Vector index build failed");
	});

	it("cancels vector indexing after lexical readiness", async () => {
		const root = tempDir();
		writeFileSync(join(root, "slow.ts"), "export const slowVectorBuild = true;\n");
		let resolveStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			resolveStarted = resolve;
		});
		let aborted = false;
		const index = new WorkspaceSemanticIndex(root, {
			embedding: {
				embed: async (_texts, signal) => {
					resolveStarted();
					await new Promise<void>((_resolve, reject) => {
						if (signal?.aborted) {
							aborted = true;
							reject(new Error("aborted"));
							return;
						}
						signal?.addEventListener(
							"abort",
							() => {
								aborted = true;
								reject(new Error("aborted"));
							},
							{ once: true },
						);
					});
					return [];
				},
			},
		});
		index.start();
		await index.ready;
		await started;

		index.cancel();
		await index.vectorsReady;

		expect(aborted).toBe(true);
		expect(index.status).toBe("not_started");
	});

	it("aborts vector indexing before refreshing the lexical index", async () => {
		const root = tempDir();
		writeFileSync(join(root, "refresh.ts"), "export const refreshVectorBuild = true;\n");
		let calls = 0;
		let resolveStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			resolveStarted = resolve;
		});
		let aborted = false;
		const index = new WorkspaceSemanticIndex(root, {
			embedding: {
				embed: async (texts, signal) => {
					calls += 1;
					if (calls > 1) return texts.map(() => [1, 0]);
					resolveStarted();
					await new Promise<void>((_resolve, reject) => {
						signal?.addEventListener(
							"abort",
							() => {
								aborted = true;
								reject(new Error("aborted"));
							},
							{ once: true },
						);
					});
					return [];
				},
			},
		});
		index.start();
		await index.ready;
		await started;

		await index.refresh();

		expect(aborted).toBe(true);
		index.cancel();
	});

	it("respects gitignore, binary files, and size limits", async () => {
		const root = tempDir();
		mkdirSync(join(root, "ignored"));
		writeFileSync(join(root, ".gitignore"), "ignored/\n");
		writeFileSync(join(root, "ignored", "secret.ts"), "needle");
		writeFileSync(join(root, "kept.ts"), "needle");
		writeFileSync(join(root, "large.ts"), "needle-".repeat(100));
		writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3, 4]));

		const index = new WorkspaceSemanticIndex(root, { maxFileSizeBytes: 32 });
		index.start();
		await index.ready;

		const result = await index.search("needle");
		expect(result.results.map((item) => item.path)).toEqual(["kept.ts"]);
		expect(result.indexedFiles).toBe(1);
	});

	it("cancels a background scan without keeping the process alive", async () => {
		const root = tempDir();
		writeFileSync(join(root, "file.ts"), "const value = 1;\n");

		const index = new WorkspaceSemanticIndex(root);
		index.start();
		index.cancel();

		await index.ready;
		expect(index.status).toBe("not_started");
	});

	it("exposes the shared index through the native semantic_search tool", async () => {
		const root = tempDir();
		writeFileSync(join(root, "feature.ts"), "export const nativeSearch = true;\n");
		const index = new WorkspaceSemanticIndex(root);
		index.start();
		const tool = createSemanticSearchToolDefinition(root, { index });

		const result = await tool.execute("search", { query: "nativeSearch" }, undefined, undefined, undefined as never);
		expect(result.details?.results[0]?.path).toBe("feature.ts");
		expect(result.content[0]?.type).toBe("text");
	});

	it("labels TypeScript symbol chunks instead of claiming line-window semantics", async () => {
		const root = tempDir();
		writeFileSync(join(root, "symbols.ts"), "export function loadWorkspace() { return true; }\n");
		const index = new WorkspaceSemanticIndex(root);
		index.start();
		await index.ready;

		const result = await index.search("loadWorkspace");
		expect(result.results[0]?.symbolName).toBe("loadWorkspace");
		expect(result.results[0]?.languageTier).toBe("structured");
	});

	it("refreshes changed files and publishes a new index revision", async () => {
		const root = tempDir();
		const file = join(root, "changing.ts");
		writeFileSync(file, "export const beforeRefresh = true;\n");
		const index = new WorkspaceSemanticIndex(root);
		index.start();
		await index.ready;
		const oldRevision = index.indexRevision;

		writeFileSync(file, "export const afterRefresh = true;\n");
		await index.refresh();

		expect(index.indexRevision).not.toBe(oldRevision);
		expect((await index.search("beforeRefresh")).results).toEqual([]);
		expect((await index.search("afterRefresh")).results[0]?.path).toBe("changing.ts");
	});

	it("changes search chunk identities when a file revision changes outside the matched chunk", async () => {
		const root = tempDir();
		const file = join(root, "revision-aware.ts");
		writeFileSync(file, "export const stableNeedle = true;\nexport const oldValue = true;\n");
		const index = new WorkspaceSemanticIndex(root);
		index.start();
		await index.ready;
		const first = await index.search("stableNeedle");

		writeFileSync(file, "export const stableNeedle = true;\nexport const newValue = true;\n");
		await index.refresh();
		const second = await index.search("stableNeedle");

		expect(second.results[0]?.fileRevision).not.toBe(first.results[0]?.fileRevision);
		expect(second.results[0]?.chunkId).not.toBe(first.results[0]?.chunkId);
	});

	it("warns when repeated retrieval returns no novel chunks", async () => {
		const root = tempDir();
		writeFileSync(join(root, "retrieval.ts"), "export function stableSearch() { return true; }\n");
		const index = new WorkspaceSemanticIndex(root);
		index.start();
		await index.ready;

		await index.search("stableSearch");
		const repeated = await index.search("stableSearch");
		expect(repeated.novelResults).toBe(0);
		expect(repeated.overlapWarning).toContain("little novel context");
		expect(repeated.recommendedNextAction).toBe("narrow_query");
	});

	it("provides an exact read request without minting a read receipt", async () => {
		const root = tempDir();
		writeFileSync(join(root, "promote.ts"), "export function promoteMe() { return true; }\n");
		const index = new WorkspaceSemanticIndex(root);
		index.start();
		await index.ready;

		const result = await index.search("promoteMe");
		const searchResult = result.results[0];
		expect(searchResult?.readRequest).toEqual({
			path: "promote.ts",
			mode: "range",
			startLine: 1,
			maxLines: 1,
		});
		expect(searchResult && "receipt" in searchResult).toBe(false);

		const readResult = await createReadTool(root).execute("promote-read", searchResult?.readRequest as ReadToolInput);
		expect(readResult.details?.receipt?.path).toContain("promote.ts");
	});

	it("adds bounded related-test read requests without minting read receipts", async () => {
		const root = tempDir();
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "feature.ts"), "export function implementationNeedle() { return true; }\n");
		writeFileSync(join(root, "src", "feature.test.ts"), "test('feature behavior', () => expect(true).toBe(true));\n");
		const index = new WorkspaceSemanticIndex(root);
		index.start();
		await index.ready;

		const result = await index.search("implementationNeedle");
		const related = result.results[0]?.related?.[0];

		expect(related).toEqual({
			kind: "test",
			path: "src/feature.test.ts",
			why: "same basename test/spec file",
			readRequest: {
				path: "src/feature.test.ts",
				mode: "range",
				startLine: 1,
				maxLines: 1,
			},
		});
		expect(related && "receipt" in related).toBe(false);
	});

	it("debounces direct file changes when watching is enabled", async () => {
		const root = tempDir();
		const file = join(root, "watched.ts");
		writeFileSync(file, "export const oldValue = true;\n");
		const index = new WorkspaceSemanticIndex(root, { watch: true });
		index.start();
		await index.ready;

		writeFileSync(file, "export const newValue = true;\n");
		const deadline = Date.now() + 1500;
		while (Date.now() < deadline) {
			if ((await index.search("newValue")).results.length > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect((await index.search("newValue")).results[0]?.path).toBe("watched.ts");
		index.cancel();
	});

	it("persists a versioned cache and reuses it before a fresh scan completes", async () => {
		const root = tempDir();
		writeFileSync(join(root, "cached.ts"), "export const cachedValue = true;\n");
		const first = new WorkspaceSemanticIndex(root);
		first.start();
		await first.ready;
		expect(first.cachePath).toContain(".semantic_search");

		const second = new WorkspaceSemanticIndex(root);
		second.start();
		const cached = await second.search("cachedValue");
		expect(second.loadedFromCache).toBe(true);
		expect(cached.results[0]?.path).toBe("cached.ts");
		expect(cached.completeness).toBe("incomplete");
		await second.ready;
		second.cancel();
	});

	it("ignores malformed cached chunks during early fallback search", async () => {
		const root = tempDir();
		writeFileSync(join(root, "valid.ts"), "export const validCacheValue = true;\n");
		const cachePath = join(root, ".semantic_search", "index.json");
		mkdirSync(join(root, ".semantic_search"));
		writeFileSync(
			cachePath,
			JSON.stringify({
				schemaVersion: 1,
				parserVersion: "workspace-parser-v1",
				chunkSchemaVersion: 1,
				root,
				indexRevision: "cached",
				files: {
					"malformed.ts": {
						path: "malformed.ts",
						revision: "cached",
						chunks: [{ text: 42, startLine: 1, endLine: 1, languageTier: "structured" }],
					},
				},
			}),
		);

		const index = new WorkspaceSemanticIndex(root);
		index.start();
		const result = await index.search("validCacheValue");

		expect(result.results[0]?.path).toBe("valid.ts");
		index.cancel();
	});

	it("watches nested directories and refreshes their files", async () => {
		const root = tempDir();
		mkdirSync(join(root, "nested"));
		writeFileSync(join(root, "nested", "watched.ts"), "export const nestedOld = true;\n");
		const index = new WorkspaceSemanticIndex(root, { watch: true });
		index.start();
		await index.ready;

		writeFileSync(join(root, "nested", "watched.ts"), "export const nestedNew = true;\n");
		const deadline = Date.now() + 1500;
		while (Date.now() < deadline) {
			if ((await index.search("nestedNew")).results.length > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect((await index.search("nestedNew")).results[0]?.path).toBe("nested/watched.ts");
		index.cancel();
	});

	it("refreshes when a new directory is created after the initial scan", async () => {
		const root = tempDir();
		const index = new WorkspaceSemanticIndex(root, { watch: true });
		index.start();
		await index.ready;

		mkdirSync(join(root, "created"));
		writeFileSync(join(root, "created", "new.ts"), "export const createdValue = true;\n");
		const deadline = Date.now() + 1500;
		while (Date.now() < deadline) {
			if ((await index.search("createdValue")).results.length > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect((await index.search("createdValue")).results[0]?.path).toBe("created/new.ts");
		index.cancel();
	});

	it("compacts the persisted cache under its configured byte limit", async () => {
		const root = tempDir();
		for (const name of ["a.ts", "b.ts", "c.ts"]) {
			writeFileSync(join(root, name), `export const ${name[0]} = "${"value".repeat(80)}";\n`);
		}
		const index = new WorkspaceSemanticIndex(root, { maxCacheBytes: 1200 });
		index.start();
		await index.ready;

		const cache = await Promise.all([fsStat(index.cachePath), fsReadFile(index.cachePath, "utf8")]);
		expect(cache[0].size).toBeLessThanOrEqual(1200);
		expect(JSON.parse(cache[1]).schemaVersion).toBe(1);
		expect(index.cacheCompacted).toBe(true);
	});
});
