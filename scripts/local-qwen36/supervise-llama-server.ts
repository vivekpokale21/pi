#!/usr/bin/env -S node --import tsx
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	createProcessHealthStore,
	runWithCrashBackoff,
	type CrashBackoffPolicy,
	type ProcessRunResult,
} from "./process-backoff.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(SCRIPT_DIR, "..", "..");
const LAUNCHER = join(SCRIPT_DIR, "start-llama-server.sh");

interface CliOptions {
	dryRun: boolean;
	maxAttempts: number;
	stableAfterMs: number;
	policy: CrashBackoffPolicy;
}

function parseNumberFlag(value: string | undefined, flag: string): number {
	if (value === undefined) throw new Error(`${flag} requires a value`);
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive number`);
	return parsed;
}

function parseArgs(args: string[]): CliOptions {
	const options: CliOptions = {
		dryRun: false,
		maxAttempts: Number(process.env.QWEN36_SUPERVISOR_MAX_ATTEMPTS ?? "3"),
		stableAfterMs: Number(process.env.QWEN36_SUPERVISOR_STABLE_AFTER_MS ?? "30000"),
		policy: {
			initialDelayMs: Number(process.env.QWEN36_SUPERVISOR_INITIAL_DELAY_MS ?? "1000"),
			maxDelayMs: Number(process.env.QWEN36_SUPERVISOR_MAX_DELAY_MS ?? "30000"),
			maxConsecutiveFailures: Number(process.env.QWEN36_SUPERVISOR_MAX_CONSECUTIVE_FAILURES ?? "3"),
			cooldownMs: Number(process.env.QWEN36_SUPERVISOR_COOLDOWN_MS ?? "300000"),
		},
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--max-attempts":
				options.maxAttempts = parseNumberFlag(args[++i], arg);
				break;
			case "--stable-after-ms":
				options.stableAfterMs = parseNumberFlag(args[++i], arg);
				break;
			case "--initial-delay-ms":
				options.policy.initialDelayMs = parseNumberFlag(args[++i], arg);
				break;
			case "--max-delay-ms":
				options.policy.maxDelayMs = parseNumberFlag(args[++i], arg);
				break;
			case "--max-consecutive-failures":
				options.policy.maxConsecutiveFailures = parseNumberFlag(args[++i], arg);
				break;
			case "--cooldown-ms":
				options.policy.cooldownMs = parseNumberFlag(args[++i], arg);
				break;
			case "-h":
			case "--help":
				printUsage();
				process.exit(0);
				break;
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}

	return options;
}

function printUsage(): void {
	console.log(`Usage: npx tsx scripts/local-qwen36/supervise-llama-server.ts [--dry-run]

Runs the fixed local Qwen3.6 llama.cpp launcher with bounded crash-loop backoff.

Options:
  --dry-run
  --max-attempts N
  --stable-after-ms MS
  --initial-delay-ms MS
  --max-delay-ms MS
  --max-consecutive-failures N
  --cooldown-ms MS`);
}

function spawnLauncher(args: string[], stdio: "pipe" | "inherit"): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(LAUNCHER, args, { cwd: ROOT_DIR, stdio: ["inherit", stdio, stdio] });
		let stdout = "";
		if (stdio === "pipe") {
			child.stdout?.on("data", (chunk) => {
				stdout += String(chunk);
			});
		}
		child.on("error", reject);
		child.on("close", (code, signal) => resolvePromise({ code, signal, stdout }));
	});
}

async function runLauncherOnce(): Promise<ProcessRunResult> {
	const started = Date.now();
	const result = await spawnLauncher([], "inherit");
	return {
		code: result.code,
		signal: result.signal,
		runtimeMs: Date.now() - started,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const store = createProcessHealthStore();

	if (options.dryRun) {
		const launcherDryRun = await spawnLauncher(["--dry-run"], "pipe");
		if (launcherDryRun.code !== 0) {
			throw new Error(`launcher dry-run failed with exit ${launcherDryRun.code}`);
		}
		console.log(
			JSON.stringify(
				{
					processKey: "qwen36-llama-server",
					maxAttempts: options.maxAttempts,
					stableAfterMs: options.stableAfterMs,
					policy: options.policy,
					healthStateFile:
						process.env.QWEN36_PROCESS_HEALTH_STATE_FILE ?? ".port_sessions/process_health_state.json",
					launcherCommand: launcherDryRun.stdout.trim(),
				},
				null,
				2,
			),
		);
		return;
	}

	const summary = await runWithCrashBackoff({
		processKey: "qwen36-llama-server",
		maxAttempts: options.maxAttempts,
		stableAfterMs: options.stableAfterMs,
		policy: options.policy,
		store,
		sleep,
		runOnce: runLauncherOnce,
	});

	if (summary.status === "success") return;
	throw new Error(summary.reason);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
