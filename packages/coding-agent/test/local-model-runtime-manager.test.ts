import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	LocalModelRuntimeError,
	LocalModelRuntimeManager,
	type LocalModelRuntimeProcess,
	type LocalModelRuntimeStateValue,
} from "../src/core/local-model-runtime-manager.ts";

class FakeProcess implements LocalModelRuntimeProcess {
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

describe("LocalModelRuntimeManager", () => {
	const originalServerBin = process.env.LLAMA_CPP_SERVER_BIN;
	const tempDirs: string[] = [];

	function tempFile(name: string): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-local-runtime-"));
		tempDirs.push(dir);
		const path = join(dir, name);
		writeFileSync(path, "");
		return path;
	}

	afterEach(() => {
		if (originalServerBin === undefined) delete process.env.LLAMA_CPP_SERVER_BIN;
		else process.env.LLAMA_CPP_SERVER_BIN = originalServerBin;
	});

	it("reports runtime_unavailable when llama-server cannot be found", async () => {
		const modelPath = tempFile("model.gguf");
		const states: LocalModelRuntimeStateValue[] = [];
		const manager = new LocalModelRuntimeManager({
			operations: {
				executableExists: async () => false,
				modelExists: async () => true,
				allocatePort: async () => 49152,
				start: () => new FakeProcess(),
				waitUntilReady: async () => {},
			},
		});
		manager.subscribe((state) => states.push(state.value));

		await expect(manager.ensureReady({ id: "model", path: modelPath })).rejects.toMatchObject({
			code: "runtime_unavailable",
		});
		expect(manager.getState().value).toBe("runtime_unavailable");
		expect(states).toEqual(["runtime_unavailable"]);
	});

	it("reports model_missing when the selected GGUF no longer exists", async () => {
		const manager = new LocalModelRuntimeManager({
			operations: {
				executableExists: async () => true,
				modelExists: async () => false,
				allocatePort: async () => 49152,
				start: () => new FakeProcess(),
				waitUntilReady: async () => {},
			},
		});

		await expect(manager.ensureReady({ id: "missing", path: "/tmp/missing.gguf" })).rejects.toMatchObject({
			code: "model_missing",
		});
		expect(manager.getState().value).toBe("model_missing");
	});

	it("starts llama-server, emits lifecycle states, and reuses the ready process for the same model", async () => {
		const modelPath = tempFile("model.gguf");
		const processes: FakeProcess[] = [];
		const startCalls: Array<{ command: string; args: string[]; port: number }> = [];
		const states: LocalModelRuntimeStateValue[] = [];
		const manager = new LocalModelRuntimeManager({
			serverBin: "/bin/llama-server",
			operations: {
				executableExists: async () => true,
				modelExists: async () => true,
				allocatePort: async () => 49153,
				start: (command, args, options) => {
					startCalls.push({ command, args, port: options.port });
					const process = new FakeProcess();
					processes.push(process);
					return process;
				},
				waitUntilReady: async () => {},
			},
		});
		manager.subscribe((state) => states.push(state.value));

		const first = await manager.ensureReady({ id: "model", path: modelPath });
		const second = await manager.ensureReady({ id: "model", path: modelPath });

		expect(first).toEqual({ baseUrl: "http://127.0.0.1:49153", apiKey: "local" });
		expect(second).toBe(first);
		expect(startCalls).toHaveLength(1);
		expect(startCalls[0]?.command).toBe("/bin/llama-server");
		expect(startCalls[0]?.args).toEqual(
			expect.arrayContaining(["--host", "127.0.0.1", "--port", "49153", "-m", modelPath]),
		);
		expect(processes).toHaveLength(1);
		expect(states).toEqual(["starting_server", "loading_model", "ready"]);
	});

	it("stops the previous process when switching models", async () => {
		const firstModel = tempFile("first.gguf");
		const secondModel = tempFile("second.gguf");
		const processes: FakeProcess[] = [];
		const manager = new LocalModelRuntimeManager({
			operations: {
				executableExists: async () => true,
				modelExists: async () => true,
				allocatePort: async () => 49154,
				start: () => {
					const process = new FakeProcess();
					processes.push(process);
					return process;
				},
				waitUntilReady: async () => {},
			},
		});

		await manager.ensureReady({ id: "first", path: firstModel });
		await manager.ensureReady({ id: "second", path: secondModel });

		expect(processes).toHaveLength(2);
		expect(processes[0]?.killCalls).toBe(1);
		expect(manager.getState()).toMatchObject({ value: "ready", modelId: "second" });
	});

	it("reports process_exited for unexpected exits", async () => {
		const modelPath = tempFile("model.gguf");
		const process = new FakeProcess();
		const manager = new LocalModelRuntimeManager({
			operations: {
				executableExists: async () => true,
				modelExists: async () => true,
				allocatePort: async () => 49155,
				start: () => process,
				waitUntilReady: async () => {},
			},
		});

		await manager.ensureReady({ id: "model", path: modelPath });
		process.exit(9);

		expect(manager.getState()).toMatchObject({ value: "process_exited", modelId: "model" });
	});

	it("restarts after an unexpected process exit on the next request", async () => {
		const modelPath = tempFile("model.gguf");
		const processes: FakeProcess[] = [];
		const manager = new LocalModelRuntimeManager({
			operations: {
				executableExists: async () => true,
				modelExists: async () => true,
				allocatePort: async () => 49161,
				start: () => {
					const process = new FakeProcess();
					processes.push(process);
					return process;
				},
				waitUntilReady: async () => {},
			},
		});

		await manager.ensureReady({ id: "model", path: modelPath });
		processes[0]?.exit(9);
		await manager.ensureReady({ id: "model", path: modelPath });

		expect(processes).toHaveLength(2);
		expect(manager.getState()).toMatchObject({ value: "ready", modelId: "model" });
	});

	it("wraps process startup failures as load_failed", async () => {
		const modelPath = tempFile("model.gguf");
		const manager = new LocalModelRuntimeManager({
			operations: {
				executableExists: async () => true,
				modelExists: async () => true,
				allocatePort: async () => 49162,
				start: () => {
					throw new Error("spawn failed");
				},
				waitUntilReady: async () => {},
			},
		});

		await expect(manager.ensureReady({ id: "model", path: modelPath })).rejects.toMatchObject({
			code: "load_failed",
		});
		expect(manager.getState()).toMatchObject({ value: "load_failed", message: "spawn failed" });
	});

	it("kills a running process and returns to unloaded on shutdown", async () => {
		const modelPath = tempFile("model.gguf");
		const process = new FakeProcess();
		const manager = new LocalModelRuntimeManager({
			operations: {
				executableExists: async () => true,
				modelExists: async () => true,
				allocatePort: async () => 49156,
				start: () => process,
				waitUntilReady: async () => {},
			},
		});

		await manager.ensureReady({ id: "model", path: modelPath });
		await manager.shutdown();

		expect(process.killCalls).toBe(1);
		expect(manager.getState().value).toBe("unloaded");
	});

	it("wraps readiness failures as load_failed", async () => {
		const modelPath = tempFile("model.gguf");
		const manager = new LocalModelRuntimeManager({
			operations: {
				executableExists: async () => true,
				modelExists: async () => true,
				allocatePort: async () => 49157,
				start: () => new FakeProcess(),
				waitUntilReady: async () => {
					throw new Error("not ready");
				},
			},
		});

		await expect(manager.ensureReady({ id: "model", path: modelPath })).rejects.toBeInstanceOf(
			LocalModelRuntimeError,
		);
		expect(manager.getState()).toMatchObject({ value: "load_failed", message: "not ready" });
	});
});
