import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export type GoalStatus = "active" | "complete" | "stopped";

export interface GoalState {
	id: string;
	status: GoalStatus;
	objective: string;
	nonGoals: string[];
	stopConditions: string[];
	verification: string[];
	autoContinue: boolean;
	createdAt: string;
	updatedAt: string;
	stopReason?: string;
}

export interface GoalStartInput {
	objective: string;
	nonGoals?: string[];
	stopConditions?: string[];
	verification?: string[];
	autoContinue?: boolean;
}

export interface GoalStoreOptions {
	now?: () => Date;
}

export interface GoalStore {
	readonly activePath: string;
	start(input: GoalStartInput): Promise<GoalState>;
	getActive(): Promise<GoalState | undefined>;
	canAutoContinue(): Promise<boolean>;
	stop(reason?: string): Promise<GoalState | undefined>;
}

const GOAL_DIR = ".pi/goals";
const ACTIVE_GOAL_FILE = "active.json";

function cleanList(values: string[] | undefined): string[] {
	return values?.map((value) => value.trim()).filter((value) => value.length > 0) ?? [];
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseGoalState(value: unknown): GoalState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.id !== "string" ||
		(record.status !== "active" && record.status !== "complete" && record.status !== "stopped") ||
		typeof record.objective !== "string" ||
		!isStringArray(record.nonGoals) ||
		!isStringArray(record.stopConditions) ||
		!isStringArray(record.verification) ||
		typeof record.autoContinue !== "boolean" ||
		typeof record.createdAt !== "string" ||
		typeof record.updatedAt !== "string" ||
		(record.stopReason !== undefined && typeof record.stopReason !== "string")
	) {
		return undefined;
	}
	return {
		id: record.id,
		status: record.status,
		objective: record.objective,
		nonGoals: record.nonGoals,
		stopConditions: record.stopConditions,
		verification: record.verification,
		autoContinue: record.autoContinue,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }),
	};
}

async function readGoal(path: string): Promise<GoalState | undefined> {
	try {
		return parseGoalState(JSON.parse(await readFile(path, "utf8")) as unknown);
	} catch {
		return undefined;
	}
}

export function createGoalStore(cwd: string, options: GoalStoreOptions = {}): GoalStore {
	const goalDir = resolve(cwd, GOAL_DIR);
	const activePath = resolve(goalDir, ACTIVE_GOAL_FILE);
	const now = options.now ?? (() => new Date());

	return {
		activePath,
		async start(input) {
			const objective = input.objective.trim();
			if (objective.length === 0) {
				throw new Error("Goal objective must be recorded");
			}
			const timestamp = now().toISOString();
			const goal: GoalState = {
				id: randomUUID(),
				status: "active",
				objective,
				nonGoals: cleanList(input.nonGoals),
				stopConditions: cleanList(input.stopConditions),
				verification: cleanList(input.verification),
				autoContinue: input.autoContinue ?? true,
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			await mkdir(goalDir, { recursive: true });
			await writeFile(activePath, `${JSON.stringify(goal, null, "\t")}\n`, "utf8");
			return goal;
		},
		async getActive() {
			const goal = await readGoal(activePath);
			return goal?.status === "active" ? goal : undefined;
		},
		async canAutoContinue() {
			const goal = await this.getActive();
			return goal?.autoContinue === true;
		},
		async stop(reason) {
			const goal = await this.getActive();
			if (!goal) return undefined;
			const stopped: GoalState = {
				...goal,
				status: "stopped",
				autoContinue: false,
				updatedAt: now().toISOString(),
				...(reason && reason.trim().length > 0 ? { stopReason: reason.trim() } : {}),
			};
			await writeFile(activePath, `${JSON.stringify(stopped, null, "\t")}\n`, "utf8");
			return stopped;
		},
	};
}
