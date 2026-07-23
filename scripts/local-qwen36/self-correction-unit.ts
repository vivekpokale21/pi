#!/usr/bin/env -S node --import tsx
import assert from "node:assert/strict";
import { runBuildSelfCorrection } from "./self-correction.ts";

async function successReturnsWithoutExecutor(): Promise<void> {
	let executorCalls = 0;
	const result = await runBuildSelfCorrection({
		commandLabel: "npm run check",
		runCommand: async () => ({ exitCode: 0, output: "ok\n" }),
		runExecutorRepair: async () => {
			executorCalls += 1;
		},
	});

	assert.equal(result.stopReason, "passed");
	assert.equal(result.attempts.length, 1);
	assert.equal(result.attempts[0]?.exitCode, 0);
	assert.equal(executorCalls, 0);
}

async function failureSendsBoundedDiagnosticsAndRetries(): Promise<void> {
	const prompts: string[] = [];
	let commandCalls = 0;
	const result = await runBuildSelfCorrection({
		commandLabel: "tsgo --noEmit",
		maxAttempts: 2,
		maxPromptChars: 220,
		runCommand: async () => {
			commandCalls += 1;
			return commandCalls === 1
				? { exitCode: 1, output: "packages/foo/src/bar.ts(12,7): error TS2345: Argument of type 'string' is not assignable.\n" }
				: { exitCode: 0, output: "ok\n" };
		},
		runExecutorRepair: async (input) => {
			prompts.push(input.prompt);
		},
	});

	assert.equal(result.stopReason, "passed");
	assert.equal(commandCalls, 2);
	assert.equal(prompts.length, 1);
	assert.match(prompts[0] ?? "", /<build_diagnostics attempt="1" remaining="1">/);
	assert.match(prompts[0] ?? "", /TS2345/);
	assert.equal(result.attempts[0]?.diagnostics[0]?.source, "typescript");
}

async function repeatedFailuresStopAtMaxAttempts(): Promise<void> {
	let repairs = 0;
	const result = await runBuildSelfCorrection({
		commandLabel: "npm run check",
		maxAttempts: 2,
		stopOnRepeatedDiagnostics: false,
		runCommand: async () => ({ exitCode: 1, output: "a.ts(1,1): error TS1000: same failure\n" }),
		runExecutorRepair: async () => {
			repairs += 1;
		},
	});

	assert.equal(result.stopReason, "max_attempts");
	assert.equal(result.attempts.length, 2);
	assert.equal(repairs, 1);
	assert.equal(result.health.consecutiveFailures, 2);
	assert.equal(result.health.lastErrorSignature.length, 12);
}

async function identicalDiagnosticsStopWithoutSecondRepair(): Promise<void> {
	let repairs = 0;
	const result = await runBuildSelfCorrection({
		commandLabel: "npm run check",
		maxAttempts: 3,
		runCommand: async () => ({ exitCode: 1, output: "a.ts(1,1): error TS1000: same failure\n" }),
		runExecutorRepair: async () => {
			repairs += 1;
		},
	});

	assert.equal(result.stopReason, "repeated_diagnostics");
	assert.equal(result.attempts.length, 2);
	assert.equal(repairs, 1);
	assert.equal(result.health.consecutiveFailures, 2);
	assert.equal(result.health.blockedUntilUnix > 0, true);
	assert.equal(result.health.lastErrorSignature, result.attempts[0]?.diagnosticSignature);
}

async function executorFailureStopsLoop(): Promise<void> {
	const result = await runBuildSelfCorrection({
		commandLabel: "npm run check",
		maxAttempts: 3,
		runCommand: async () => ({ exitCode: 1, output: "a.ts(1,1): error TS1000: same failure\n" }),
		runExecutorRepair: async () => {
			throw new Error("executor crashed");
		},
	});

	assert.equal(result.stopReason, "executor_failed");
	assert.equal(result.attempts.length, 1);
	assert.match(result.executorError ?? "", /executor crashed/);
}

await successReturnsWithoutExecutor();
await failureSendsBoundedDiagnosticsAndRetries();
await repeatedFailuresStopAtMaxAttempts();
await identicalDiagnosticsStopWithoutSecondRepair();
await executorFailureStopsLoop();

console.log("self-correction-unit: ok");
