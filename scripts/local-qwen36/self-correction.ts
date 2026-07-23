import { createHash } from "node:crypto";
import {
	formatBuildDiagnosticsForPrompt,
	parseBuildDiagnostics,
	type BuildDiagnostic,
} from "./build-diagnostics.ts";

export type BuildSelfCorrectionStopReason =
	| "passed"
	| "max_attempts"
	| "repeated_diagnostics"
	| "executor_failed";

export interface BuildCommandResult {
	exitCode: number;
	output: string;
}

export interface BuildSelfCorrectionAttempt {
	attempt: number;
	exitCode: number;
	outputSummary: string;
	diagnostics: BuildDiagnostic[];
	diagnosticSignature: string;
	prompt?: string;
}

export interface BuildSelfCorrectionHealth {
	consecutiveFailures: number;
	blockedUntilUnix: number;
	lastErrorSignature: string;
	lastAttemptUnix: number;
	lastSuccessUnix: number;
	totalAttempts: number;
	totalFailures: number;
}

export interface BuildSelfCorrectionResult {
	commandLabel: string;
	stopReason: BuildSelfCorrectionStopReason;
	attempts: BuildSelfCorrectionAttempt[];
	health: BuildSelfCorrectionHealth;
	executorError?: string;
}

export interface BuildSelfCorrectionInput {
	commandLabel: string;
	maxAttempts?: number;
	maxPromptChars?: number;
	cooldownMs?: number;
	stopOnRepeatedDiagnostics?: boolean;
	now?: () => number;
	runCommand: () => Promise<BuildCommandResult>;
	runExecutorRepair: (input: {
		commandLabel: string;
		attempt: number;
		remaining: number;
		diagnostics: BuildDiagnostic[];
		prompt: string;
		rawOutput: string;
	}) => Promise<void>;
}

function nowUnixSeconds(now: () => number): number {
	return now();
}

function outputSummary(output: string): string {
	const line = output
		.split(/\r?\n/)
		.map((entry) => entry.trim())
		.find((entry) => entry.length > 0);
	return line ? (line.length <= 500 ? line : `${line.slice(0, 497)}...`) : "";
}

function diagnosticSignature(diagnostics: BuildDiagnostic[], output: string): string {
	const hash = createHash("sha256");
	if (diagnostics.length === 0) {
		hash.update(output);
	} else {
		for (const diagnostic of diagnostics) {
			hash.update(diagnostic.source);
			hash.update("\0");
			hash.update(diagnostic.severity);
			hash.update("\0");
			hash.update(diagnostic.path ?? "");
			hash.update("\0");
			hash.update(String(diagnostic.line ?? ""));
			hash.update("\0");
			hash.update(String(diagnostic.column ?? ""));
			hash.update("\0");
			hash.update(diagnostic.code ?? "");
			hash.update("\0");
			hash.update(diagnostic.message);
			hash.update("\0");
		}
	}
	return hash.digest("hex").slice(0, 12);
}

function defaultHealth(): BuildSelfCorrectionHealth {
	return {
		consecutiveFailures: 0,
		blockedUntilUnix: 0,
		lastErrorSignature: "",
		lastAttemptUnix: 0,
		lastSuccessUnix: 0,
		totalAttempts: 0,
		totalFailures: 0,
	};
}

function recordFailure(
	health: BuildSelfCorrectionHealth,
	signature: string,
	now: () => number,
	cooldownMs: number,
	blocked: boolean,
): void {
	health.consecutiveFailures += 1;
	health.totalFailures += 1;
	health.lastErrorSignature = signature;
	health.blockedUntilUnix = blocked ? nowUnixSeconds(now) + cooldownMs / 1000 : 0;
}

export async function runBuildSelfCorrection(input: BuildSelfCorrectionInput): Promise<BuildSelfCorrectionResult> {
	const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? 2));
	const maxPromptChars = Math.max(80, Math.floor(input.maxPromptChars ?? 1600));
	const cooldownMs = Math.max(1, input.cooldownMs ?? 300_000);
	const stopOnRepeatedDiagnostics = input.stopOnRepeatedDiagnostics ?? true;
	const now = input.now ?? (() => Date.now() / 1000);
	const health = defaultHealth();
	const attempts: BuildSelfCorrectionAttempt[] = [];

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		health.totalAttempts += 1;
		health.lastAttemptUnix = nowUnixSeconds(now);
		const commandResult = await input.runCommand();
		const diagnostics = commandResult.exitCode === 0 ? [] : parseBuildDiagnostics(commandResult.output);
		const signature = commandResult.exitCode === 0 ? "" : diagnosticSignature(diagnostics, commandResult.output);
		const currentAttempt: BuildSelfCorrectionAttempt = {
			attempt,
			exitCode: commandResult.exitCode,
			outputSummary: outputSummary(commandResult.output),
			diagnostics,
			diagnosticSignature: signature,
		};
		attempts.push(currentAttempt);

		if (commandResult.exitCode === 0) {
			health.consecutiveFailures = 0;
			health.blockedUntilUnix = 0;
			health.lastErrorSignature = "";
			health.lastSuccessUnix = nowUnixSeconds(now);
			return { commandLabel: input.commandLabel, stopReason: "passed", attempts, health };
		}

		const previousAttempt = attempts.at(-2);
		const repeated = previousAttempt?.diagnosticSignature === signature;
		recordFailure(health, signature, now, cooldownMs, repeated && stopOnRepeatedDiagnostics);
		if (repeated && stopOnRepeatedDiagnostics) {
			return { commandLabel: input.commandLabel, stopReason: "repeated_diagnostics", attempts, health };
		}

		if (attempt >= maxAttempts) {
			return { commandLabel: input.commandLabel, stopReason: "max_attempts", attempts, health };
		}

		const remaining = maxAttempts - attempt;
		const prompt = formatBuildDiagnosticsForPrompt({ diagnostics, attempt, remaining, maxPromptChars });
		currentAttempt.prompt = prompt;
		try {
			await input.runExecutorRepair({
				commandLabel: input.commandLabel,
				attempt,
				remaining,
				diagnostics,
				prompt,
				rawOutput: commandResult.output,
			});
		} catch (error) {
			return {
				commandLabel: input.commandLabel,
				stopReason: "executor_failed",
				attempts,
				health,
				executorError: error instanceof Error ? error.message : String(error),
			};
		}
	}

	return { commandLabel: input.commandLabel, stopReason: "max_attempts", attempts, health };
}
