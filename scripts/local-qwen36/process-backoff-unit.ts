#!/usr/bin/env -S node --import tsx
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	calculateBackoffDelayMs,
	createProcessHealthStore,
	runWithCrashBackoff,
	type ProcessRunResult,
} from "./process-backoff.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-process-backoff-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function delayScheduleDoublesAndClamps(): void {
	assert.equal(calculateBackoffDelayMs(1, { initialDelayMs: 100, maxDelayMs: 1000 }), 100);
	assert.equal(calculateBackoffDelayMs(2, { initialDelayMs: 100, maxDelayMs: 1000 }), 200);
	assert.equal(calculateBackoffDelayMs(4, { initialDelayMs: 100, maxDelayMs: 1000 }), 800);
	assert.equal(calculateBackoffDelayMs(8, { initialDelayMs: 100, maxDelayMs: 1000 }), 1000);
}

async function storePersistsCooldownAndReset(): Promise<void> {
	await withTempDir(async (dir) => {
		const path = join(dir, "process_health_state.json");
		const now = 1000;
		const store = createProcessHealthStore({ path, now: () => now });

		await store.recordFailure("llama", "startup", "exit 1", { maxConsecutiveFailures: 2, cooldownMs: 5000 });
		const blocked = await store.recordFailure("llama", "startup", "exit 1", {
			maxConsecutiveFailures: 2,
			cooldownMs: 5000,
		});

		assert.equal(blocked.consecutiveFailures, 2);
		assert.equal(blocked.blockedUntilUnix, 1005);
		assert.equal(blocked.recentCrashLoops, 1);

		const raw = JSON.parse(await readFile(path, "utf8"));
		assert.equal(raw.health.llama.consecutive_failures, 2);
		assert.equal(raw.health.llama.blocked_until_unix, 1005);

		const reloaded = createProcessHealthStore({ path, now: () => now + 1 });
		const remaining = await reloaded.cooldownRemainingSeconds("llama");
		assert.equal(remaining, 4);

		await reloaded.recordSuccess("llama");
		assert.equal(await reloaded.cooldownRemainingSeconds("llama"), null);
		const reset = await reloaded.getState("llama");
		assert.equal(reset?.consecutiveFailures, 0);
		assert.equal(reset?.recentCrashLoops, 0);
	});
}

async function supervisorRetriesThenStopsOnSuccess(): Promise<void> {
	const attempts: number[] = [];
	const slept: number[] = [];
	const result = await runWithCrashBackoff({
		processKey: "fake",
		maxAttempts: 4,
		stableAfterMs: 1000,
		policy: { initialDelayMs: 10, maxDelayMs: 80, maxConsecutiveFailures: 5, cooldownMs: 60_000 },
		store: createProcessHealthStore({ inMemory: true, now: () => 1000 }),
		sleep: async (ms) => {
			slept.push(ms);
		},
		runOnce: async () => {
			attempts.push(attempts.length + 1);
			const code = attempts.length < 3 ? 1 : 0;
			return { code, signal: null, runtimeMs: attempts.length < 3 ? 50 : 1200 };
		},
	});

	assert.equal(result.status, "success");
	assert.deepEqual(attempts, [1, 2, 3]);
	assert.deepEqual(slept, [10, 20]);
}

async function supervisorStopsWhenCooldownBlocks(): Promise<void> {
	const store = createProcessHealthStore({ inMemory: true, now: () => 1000 });
	const attempts: ProcessRunResult[] = [];
	const result = await runWithCrashBackoff({
		processKey: "fake",
		maxAttempts: 5,
		stableAfterMs: 1000,
		policy: { initialDelayMs: 10, maxDelayMs: 80, maxConsecutiveFailures: 2, cooldownMs: 60_000 },
		store,
		sleep: async () => {},
		runOnce: async () => {
			const attempt = { code: 1, signal: null, runtimeMs: 25 };
			attempts.push(attempt);
			return attempt;
		},
	});

	assert.equal(result.status, "blocked");
	assert.equal(attempts.length, 2);
	assert.match(result.reason, /cooldown active/);
}

delayScheduleDoublesAndClamps();
await storePersistsCooldownAndReset();
await supervisorRetriesThenStopsOnSuccess();
await supervisorStopsWhenCooldownBlocks();
console.log("process-backoff-unit: ok");
