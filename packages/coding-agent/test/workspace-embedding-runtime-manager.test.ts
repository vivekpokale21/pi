import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionServices, createSemanticIndexOptionsFromEnv } from "../src/core/agent-session-services.ts";
import {
	WorkspaceEmbeddingRuntimeManager,
	type WorkspaceEmbeddingRuntimeProcess,
	type WorkspaceEmbeddingRuntimeStateValue,
} from "../src/core/workspace-embedding-runtime-manager.ts";

class FakeEmbeddingProcess implements WorkspaceEmbeddingRuntimeProcess {
	private readonly emitter = new EventEmitter();
	killCalls = 0;

	onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
		this.emitter.on("exit", listener);
		return () => this.emitter.off("exit", listener);
	}

	kill(): void {
		this.killCalls++;
	}

	exit(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
		this.emitter.emit("exit", code, signal);
	}
}

describe("WorkspaceEmbeddingRuntimeManager", () => {
	const originalEnv = { ...process.env };
	const tempDirs: string[] = [];

	function tempDir(): string {
		const path = mkdtempSync(join(tmpdir(), "pi-embedding-runtime-"));
		tempDirs.push(path);
		return path;
	}

	afterEach(() => {
		process.env = { ...originalEnv };
		for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
	});

	it("starts an explicit embedding command, waits for readiness, and reuses the endpoint", async () => {
		const states: WorkspaceEmbeddingRuntimeStateValue[] = [];
		const startCalls: Array<{ command: string; baseUrl: string }> = [];
		const process = new FakeEmbeddingProcess();
		const manager = new WorkspaceEmbeddingRuntimeManager({
			baseUrl: "http://127.0.0.1:8129/v1",
			startCommand: "python -m local_embeddings --port 8129",
			operations: {
				executableExists: async () => true,
				start: (command, options) => {
					startCalls.push({ command, baseUrl: options.baseUrl });
					return process;
				},
				waitUntilReady: async () => {},
			},
		});
		manager.subscribe((state) => states.push(state.value));

		const first = await manager.ensureReady();
		const second = await manager.ensureReady();

		expect(first).toEqual({ baseUrl: "http://127.0.0.1:8129/v1" });
		expect(second).toBe(first);
		expect(startCalls).toEqual([
			{
				command: "python -m local_embeddings --port 8129",
				baseUrl: "http://127.0.0.1:8129/v1",
			},
		]);
		expect(states).toEqual(["starting_server", "ready"]);
	});

	it("reports runtime_unavailable when the configured command is missing", async () => {
		const manager = new WorkspaceEmbeddingRuntimeManager({
			baseUrl: "http://127.0.0.1:8129/v1",
			startCommand: "missing-embedding-server",
			operations: {
				executableExists: async () => false,
				start: () => new FakeEmbeddingProcess(),
				waitUntilReady: async () => {},
			},
		});

		await expect(manager.ensureReady()).rejects.toMatchObject({ code: "runtime_unavailable" });
		expect(manager.getState()).toMatchObject({
			value: "runtime_unavailable",
			message: "Embedding start command is not available: missing-embedding-server",
		});
	});

	it("kills the managed embedding process on shutdown", async () => {
		const embeddingProcess = new FakeEmbeddingProcess();
		const manager = new WorkspaceEmbeddingRuntimeManager({
			baseUrl: "http://127.0.0.1:8129/v1",
			startCommand: "python -m local_embeddings --port 8129",
			operations: {
				executableExists: async () => true,
				start: () => embeddingProcess,
				waitUntilReady: async () => {},
			},
		});

		await manager.ensureReady();
		await manager.shutdown();

		expect(embeddingProcess.killCalls).toBe(1);
		expect(manager.getState().value).toBe("unloaded");
	});

	it("creates a managed embedding provider from native Pi environment settings", () => {
		const options = createSemanticIndexOptionsFromEnv({
			PI_SEMANTIC_EMBEDDING_BASE_URL: "http://127.0.0.1:8129/v1",
			PI_SEMANTIC_EMBEDDING_MODEL: "nomic-ai/CodeRankEmbed",
			PI_SEMANTIC_EMBEDDING_START_COMMAND: "python -m local_embeddings --port 8129",
		});

		expect(options.embedding?.id).toBe("nomic-ai/CodeRankEmbed");
		expect(options.embeddingRuntime?.getState().value).toBe("unloaded");
	});

	it("disposes a service-owned embedding runtime with session services", async () => {
		const embeddingProcess = new FakeEmbeddingProcess();
		const root = tempDir();
		const services = await createAgentSessionServices({
			cwd: root,
			agentDir: root,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
			semanticIndexOptions: {
				embeddingRuntime: new WorkspaceEmbeddingRuntimeManager({
					baseUrl: "http://127.0.0.1:8129/v1",
					startCommand: "python -m local_embeddings --port 8129",
					operations: {
						executableExists: async () => true,
						start: () => embeddingProcess,
						waitUntilReady: async () => {},
					},
				}),
			},
		});

		await services.embeddingRuntime?.ensureReady();
		await services.dispose?.();

		expect(embeddingProcess.killCalls).toBe(1);
	});

	it("ships a package-owned CodeRankEmbed server entry point", () => {
		const result = spawnSync("python3", ["scripts/coderank-embed-server.py", "--help"], {
			cwd: join(import.meta.dirname, ".."),
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Serve CodeRankEmbed");
		expect(result.stdout).toContain("--model");
		expect(result.stdout).toContain("--max-seq-length");
	});
});
