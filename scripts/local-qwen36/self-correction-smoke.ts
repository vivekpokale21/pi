#!/usr/bin/env -S node --import tsx
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runBuildSelfCorrection } from "./self-correction.ts";

const execFileAsync = promisify(execFile);
const baseUrl = process.env.QWEN36_BASE_URL ?? "http://127.0.0.1:8080/v1";

async function runCommand(command: string, args: string[], cwd: string): Promise<{ exitCode: number; output: string }> {
	try {
		const result = await execFileAsync(command, args, { cwd, timeout: 30_000 });
		return { exitCode: 0, output: `${result.stdout}${result.stderr}` };
	} catch (error) {
		if (typeof error === "object" && error !== null) {
			const record = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
			const code = typeof record.code === "number" ? record.code : 1;
			return {
				exitCode: code,
				output: `${typeof record.stdout === "string" ? record.stdout : ""}${typeof record.stderr === "string" ? record.stderr : ""}`,
			};
		}
		return { exitCode: 1, output: String(error) };
	}
}

async function liveModelReachable(): Promise<boolean> {
	try {
		const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(2000) });
		return response.ok;
	} catch {
		return false;
	}
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-self-correction-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

await withTempDir(async (dir) => {
	const target = join(dir, "broken.ts");
	await writeFile(target, "const answer: number = 'wrong';\nconsole.log(answer);\n", "utf8");
	let repairs = 0;
	const result = await runBuildSelfCorrection({
		commandLabel: "tsgo --noEmit --strict broken.ts",
		maxAttempts: 2,
		runCommand: async () => runCommand(join(process.cwd(), "node_modules", ".bin", "tsgo"), ["--noEmit", "--strict", "broken.ts"], dir),
		runExecutorRepair: async (input) => {
			repairs += 1;
			assert.match(input.prompt, /typescript/);
			await writeFile(target, "const answer: number = 42;\nconsole.log(answer);\n", "utf8");
		},
	});

	assert.equal(result.stopReason, "passed");
	assert.equal(result.attempts.length, 2);
	assert.equal(repairs, 1);
	assert.match(await readFile(target, "utf8"), /42/);
});

if (await liveModelReachable()) {
	console.log(`self-correction-smoke: live Qwen reachable at ${baseUrl}; deterministic fake-executor smoke passed`);
} else {
	console.log(`self-correction-smoke: live Qwen skipped because ${baseUrl}/models is not reachable; deterministic fake-executor smoke passed`);
}
