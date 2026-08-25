import {
	mkdir as fsMkdir,
	readFile as fsReadFile,
	realpath as fsRealpath,
	writeFile as fsWriteFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { renderToolPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const handoffSectionSchema = Type.Optional(Type.Array(Type.String()));

const handoffSchema = Type.Object({
	profile: Type.Union([
		Type.Literal("planner", { description: "Exploration and planning handoff." }),
		Type.Literal("executor", { description: "Execution checkpoint or next-slice handoff." }),
	]),
	title: Type.String({ description: "Short handoff title used in the filename and document heading." }),
	goal: Type.String({ description: "Current goal for the next pass." }),
	nonGoals: handoffSectionSchema,
	inspectedFiles: handoffSectionSchema,
	facts: handoffSectionSchema,
	decisions: handoffSectionSchema,
	plan: handoffSectionSchema,
	verification: handoffSectionSchema,
	staleStateChecks: handoffSectionSchema,
	risks: handoffSectionSchema,
	stopConditions: handoffSectionSchema,
	unexplored: handoffSectionSchema,
	completed: handoffSectionSchema,
	nextSlice: handoffSectionSchema,
});

const handoffStatusSchema = Type.Object({
	path: Type.String({ description: "Handoff Markdown path under .pi/handoffs/ to validate and read." }),
});

export type HandoffToolInput = Static<typeof handoffSchema>;
export type HandoffStatusToolInput = Static<typeof handoffStatusSchema>;

export interface HandoffToolDetails {
	path: string;
	profile: "planner" | "executor";
	title: string;
	bytes: number;
}

export interface HandoffStatusToolDetails {
	path: string;
	valid: boolean;
	missingSections: string[];
	emptySections: string[];
	duplicateSections: string[];
	missingMetadata: string[];
	duplicateMetadata: string[];
	metadataMismatches: string[];
	staleStateChecks: string[];
	bytes: number;
	profile?: "planner" | "executor";
	title?: string;
	createdAt?: string;
}

export interface HandoffOperations {
	mkdir: (dir: string) => Promise<void>;
	writeFile: (path: string, content: string) => Promise<void>;
	readFile?: (path: string) => Promise<string>;
	realpath?: (path: string) => Promise<string>;
}

export interface HandoffToolOptions {
	operations?: HandoffOperations;
	now?: () => Date;
}

const defaultOperations: HandoffOperations = {
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
	writeFile: (path, content) => fsWriteFile(path, content, "utf8"),
	readFile: (path) => fsReadFile(path, "utf8"),
	realpath: (path) => fsRealpath(path),
};

const HANDOFF_DIR = ".pi/handoffs";
const REQUIRED_HANDOFF_SECTIONS = [
	"Goal",
	"Non-Goals",
	"Files Inspected",
	"Current Facts With Provenance",
	"Decisions",
	"Plan Steps",
	"Verification Commands",
	"Stale-State Checks",
	"Risks",
	"Stop Conditions",
	"Unexplored Items",
	"Completed Work",
	"Next Slice",
];
const EXECUTOR_STALE_STATE_CHECKS = [
	"re-check git status before editing",
	"verify referenced file existence",
	"re-read relevant snippets or revisions before relying on handoff facts",
	"rerun or re-evaluate commands the plan depends on before broad execution",
];
const PLACEHOLDER_SECTION_LINES = new Set(["None recorded.", "- None recorded.", "Not recorded.", "- Not recorded."]);

function sanitizeSlug(value: string): string {
	const slug = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "handoff";
}

function timestampSlug(date: Date): string {
	return date.toISOString().replace(/[.:]/g, "-");
}

function normalizeTitle(value: string): string {
	return value.trim() || "Untitled handoff";
}

function normalizeItems(items: string[] | undefined): string[] {
	if (!items) {
		return [];
	}
	return items
		.map((item) => item.trim())
		.filter(
			(item) =>
				item.length > 0 &&
				item !== "None recorded." &&
				item !== "- None recorded." &&
				item !== "Not recorded." &&
				item !== "- Not recorded.",
		);
}

function renderList(items: string[]): string {
	if (items.length === 0) {
		return "- None recorded.";
	}
	return items.map((item) => `- ${item}`).join("\n");
}

function profileLabel(profile: HandoffToolInput["profile"]): string {
	return profile === "planner" ? "Planner" : "Executor";
}

type Section = {
	title: string;
	items: string[];
};

function buildSections(input: HandoffToolInput): Section[] {
	return [
		{ title: "Non-Goals", items: normalizeItems(input.nonGoals) },
		{ title: "Files Inspected", items: normalizeItems(input.inspectedFiles) },
		{ title: "Current Facts With Provenance", items: normalizeItems(input.facts) },
		{ title: "Decisions", items: normalizeItems(input.decisions) },
		{ title: "Plan Steps", items: normalizeItems(input.plan) },
		{ title: "Verification Commands", items: normalizeItems(input.verification) },
		{ title: "Stale-State Checks", items: normalizeItems(input.staleStateChecks) },
		{ title: "Risks", items: normalizeItems(input.risks) },
		{ title: "Stop Conditions", items: normalizeItems(input.stopConditions) },
		{ title: "Unexplored Items", items: normalizeItems(input.unexplored) },
		{ title: "Completed Work", items: normalizeItems(input.completed) },
		{ title: "Next Slice", items: normalizeItems(input.nextSlice) },
	];
}

function assertWritableHandoffSections(sections: Section[]): void {
	for (const section of sections) {
		if (section.items.length === 0) {
			throw new Error(`Handoff section ${section.title} must contain at least one item`);
		}
	}
}

function buildHandoffContent(input: HandoffToolInput, createdAt: Date): string {
	const title = normalizeTitle(input.title);
	const goal = input.goal.trim();
	if (goal.length === 0) {
		throw new Error("Handoff goal must be recorded");
	}
	const sections = buildSections(input);
	if (!sections.some((section) => section.items.length > 0)) {
		throw new Error("At least one handoff section must contain an item");
	}
	assertWritableHandoffSections(sections);

	const lines = [
		`# ${profileLabel(input.profile)} Handoff: ${title}`,
		"",
		`Created: ${createdAt.toISOString()}`,
		`Profile: ${input.profile}`,
		"",
		"## Goal",
		goal,
	];

	for (const section of sections) {
		lines.push("", `## ${section.title}`, renderList(section.items));
	}

	return `${lines.join("\n")}\n`;
}

function buildHandoffPath(input: HandoffToolInput, createdAt: Date): string {
	const fileName = `${timestampSlug(createdAt)}-${input.profile}-${sanitizeSlug(input.title)}.md`;
	return `${HANDOFF_DIR}/${fileName}`;
}

function resolveHandoffStatusPath(cwd: string, inputPath: string): { absolutePath: string; relativePath: string } {
	const handoffDir = resolve(cwd, HANDOFF_DIR);
	const absolutePath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
	const relativeToHandoffDir = relative(handoffDir, absolutePath);
	if (relativeToHandoffDir.length === 0 || relativeToHandoffDir.startsWith("..") || isAbsolute(relativeToHandoffDir)) {
		throw new Error("Handoff path must be under .pi/handoffs/");
	}
	const relativePath = `${HANDOFF_DIR}/${relativeToHandoffDir.split("\\").join("/")}`;
	if (!relativePath.endsWith(".md")) {
		throw new Error("Handoff path must be a Markdown file under .pi/handoffs/");
	}
	return {
		absolutePath,
		relativePath,
	};
}

async function assertRealHandoffPath(
	cwd: string,
	absolutePath: string,
	realpath: (path: string) => Promise<string>,
): Promise<void> {
	try {
		const handoffDir = resolve(cwd, HANDOFF_DIR);
		const targetPath = await realpath(absolutePath);
		const relativeToHandoffDir = relative(handoffDir, targetPath);
		if (
			relativeToHandoffDir.length === 0 ||
			relativeToHandoffDir.startsWith("..") ||
			isAbsolute(relativeToHandoffDir)
		) {
			throw new Error("Handoff path must be under .pi/handoffs/");
		}
	} catch (error) {
		if (isMissingPathError(error)) {
			throw new Error("Handoff file not found under .pi/handoffs/");
		}
		throw error;
	}
}

function findMissingRequiredSections(content: string): string[] {
	return REQUIRED_HANDOFF_SECTIONS.filter((section) => !new RegExp(`^## ${section}$`, "m").test(content));
}

function findDuplicateRequiredSections(content: string): string[] {
	return REQUIRED_HANDOFF_SECTIONS.filter((section) => {
		const matches = content.match(new RegExp(`^## ${section}$`, "gm"));
		return (matches?.length ?? 0) > 1;
	});
}

function isPlaceholderOnlySectionBody(sectionBody: string): boolean {
	const lines = sectionBody
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return lines.length === 0 || lines.every((line) => PLACEHOLDER_SECTION_LINES.has(line));
}

function findEmptyRequiredSections(content: string, missingSections: string[]): string[] {
	const missing = new Set(missingSections);
	return REQUIRED_HANDOFF_SECTIONS.filter((section) => {
		if (missing.has(section)) {
			return false;
		}
		const sectionMatch = new RegExp(`(?:^|\\n)## ${section}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(content);
		const sectionBody = sectionMatch?.[1]?.trim() ?? "";
		return isPlaceholderOnlySectionBody(sectionBody);
	});
}

interface HandoffMetadata {
	profile?: "planner" | "executor";
	title?: string;
	createdAt?: string;
	headingProfile?: "planner" | "executor";
}

function getPreamble(content: string): string {
	const firstSectionIndex = content.search(/^## /m);
	return firstSectionIndex === -1 ? content : content.slice(0, firstSectionIndex);
}

function parseHandoffMetadata(content: string): HandoffMetadata {
	const preamble = getPreamble(content);
	const profileMatch = /^Profile: (planner|executor)$/m.exec(preamble);
	const titleMatch = /^# (Planner|Executor) Handoff: (.+)$/m.exec(preamble);
	const createdAtMatch = /^Created: (.+)$/m.exec(preamble);
	return {
		profile: profileMatch?.[1] as "planner" | "executor" | undefined,
		title: titleMatch?.[2]?.trim(),
		createdAt: createdAtMatch?.[1]?.trim(),
		headingProfile: titleMatch?.[1]?.toLowerCase() as "planner" | "executor" | undefined,
	};
}

function findDuplicateMetadata(content: string): string[] {
	const preamble = getPreamble(content);
	const duplicates: string[] = [];
	if ((preamble.match(/^Profile: /gm)?.length ?? 0) > 1) {
		duplicates.push("profile");
	}
	if ((preamble.match(/^# (Planner|Executor) Handoff: /gm)?.length ?? 0) > 1) {
		duplicates.push("title");
	}
	if ((preamble.match(/^Created: /gm)?.length ?? 0) > 1) {
		duplicates.push("createdAt");
	}
	return duplicates;
}

function findMissingMetadata(metadata: HandoffMetadata): string[] {
	const missing: string[] = [];
	if (!metadata.profile) {
		missing.push("profile");
	}
	if (!metadata.title) {
		missing.push("title");
	}
	if (!metadata.createdAt) {
		missing.push("createdAt");
	}
	return missing;
}

function findMetadataMismatches(metadata: HandoffMetadata): string[] {
	const mismatches: string[] = [];
	if (metadata.profile && metadata.headingProfile && metadata.profile !== metadata.headingProfile) {
		mismatches.push("profile");
	}
	if (metadata.createdAt) {
		const createdAtTime = Date.parse(metadata.createdAt);
		if (Number.isNaN(createdAtTime) || new Date(createdAtTime).toISOString() !== metadata.createdAt) {
			mismatches.push("createdAt");
		}
	}
	return mismatches;
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

function buildHandoffStatusText(
	relativePath: string,
	missingSections: string[],
	emptySections: string[],
	duplicateSections: string[],
	missingMetadata: string[],
	duplicateMetadata: string[],
	metadataMismatches: string[],
	content: string,
): string {
	const issues: string[] = [];
	if (missingSections.length > 0) {
		issues.push(`Missing required sections in ${relativePath}: ${missingSections.join(", ")}`);
	}
	if (emptySections.length > 0) {
		issues.push(`Empty required sections in ${relativePath}: ${emptySections.join(", ")}`);
	}
	if (duplicateSections.length > 0) {
		issues.push(`Duplicate required sections in ${relativePath}: ${duplicateSections.join(", ")}`);
	}
	if (missingMetadata.length > 0) {
		issues.push(`Missing required metadata in ${relativePath}: ${missingMetadata.join(", ")}`);
	}
	if (duplicateMetadata.length > 0) {
		issues.push(`Duplicate metadata in ${relativePath}: ${duplicateMetadata.join(", ")}`);
	}
	if (metadataMismatches.length > 0) {
		issues.push(`Mismatched metadata in ${relativePath}: ${metadataMismatches.join(", ")}`);
	}
	const status =
		issues.length === 0
			? `Handoff is complete: ${relativePath}`
			: `Handoff is invalid: ${relativePath}\n${issues.join("\n")}`;
	return [
		status,
		"",
		"Executor stale-state checklist:",
		...EXECUTOR_STALE_STATE_CHECKS.map((check) => `- ${check}`),
		"",
		"Handoff content:",
		content.trimEnd(),
	].join("\n");
}

export function createHandoffToolDefinition(
	cwd: string,
	options?: HandoffToolOptions,
): ToolDefinition<typeof handoffSchema, HandoffToolDetails> {
	const operations = options?.operations ?? defaultOperations;
	const now = options?.now ?? (() => new Date());
	return {
		name: "handoff",
		label: "handoff",
		description: "Write a structured planner or executor handoff/checkpoint under .pi/handoffs/.",
		promptSnippet: "Create a structured planner/executor handoff under .pi/handoffs/",
		promptGuidelines: [
			"Use handoff when context is low or work must continue in a fresh planner/executor pass.",
			"Planner handoffs must include findings, plan steps, provenance, and unexplored items.",
			"Executor handoffs must include completed work, verification, stale-state checks, and the next bounded slice.",
		],
		parameters: handoffSchema,
		async execute(_toolCallId, input, signal) {
			const createdAt = now();
			const relativePath = buildHandoffPath(input, createdAt);
			const absolutePath = join(cwd, relativePath);
			const content = buildHandoffContent(input, createdAt);
			const dir = join(cwd, HANDOFF_DIR);

			return withFileMutationQueue(absolutePath, async () => {
				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}
				await operations.mkdir(dir);
				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}
				await operations.writeFile(absolutePath, content);
				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}

				return {
					content: [{ type: "text", text: `Wrote ${input.profile} handoff to ${relativePath}` }],
					details: {
						path: relativePath,
						profile: input.profile,
						title: normalizeTitle(input.title),
						bytes: content.length,
					},
				};
			});
		},
		renderCall(args, theme, context) {
			const input = args as Partial<HandoffToolInput> | undefined;
			const title = str(input?.title) ?? "handoff";
			const profile = input?.profile === "executor" ? "executor" : "planner";
			const text = new Text("", 0, 0);
			text.setText(
				`${theme.fg("toolTitle", theme.bold("handoff"))} ${profile} ${renderToolPath(`${HANDOFF_DIR}/${sanitizeSlug(title)}.md`, theme, context.cwd)}`,
			);
			return text;
		},
	};
}

export function createHandoffTool(cwd: string, options?: HandoffToolOptions): AgentTool<typeof handoffSchema> {
	return wrapToolDefinition(createHandoffToolDefinition(cwd, options));
}

export function createHandoffStatusToolDefinition(
	cwd: string,
	options?: HandoffToolOptions,
): ToolDefinition<typeof handoffStatusSchema, HandoffStatusToolDetails> {
	const operations = options?.operations ?? defaultOperations;
	const readFile = operations.readFile ?? ((path: string) => fsReadFile(path, "utf8"));
	const realpath = operations.realpath ?? ((path: string) => fsRealpath(path));
	return {
		name: "handoff_status",
		label: "handoff_status",
		description: "Validate and read a structured handoff artifact under .pi/handoffs/.",
		promptSnippet: "Validate/read a planner/executor handoff under .pi/handoffs/",
		promptGuidelines: [
			"Use handoff_status before executing from a handoff artifact.",
			"Treat handoffs as stale until git status, file existence, and relevant snippets or revisions are rechecked.",
		],
		parameters: handoffStatusSchema,
		async execute(_toolCallId, input, signal) {
			const { absolutePath, relativePath } = resolveHandoffStatusPath(cwd, input.path);
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			await assertRealHandoffPath(cwd, absolutePath, realpath);
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			let content: string;
			try {
				content = await readFile(absolutePath);
			} catch (error) {
				if (isMissingPathError(error)) {
					throw new Error("Handoff file not found under .pi/handoffs/");
				}
				throw error;
			}
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			const missingSections = findMissingRequiredSections(content);
			const duplicateSections = findDuplicateRequiredSections(content);
			const emptySections = findEmptyRequiredSections(content, missingSections);
			const metadata = parseHandoffMetadata(content);
			const missingMetadata = findMissingMetadata(metadata);
			const duplicateMetadata = findDuplicateMetadata(content);
			const metadataMismatches = findMetadataMismatches(metadata);
			return {
				content: [
					{
						type: "text",
						text: buildHandoffStatusText(
							relativePath,
							missingSections,
							emptySections,
							duplicateSections,
							missingMetadata,
							duplicateMetadata,
							metadataMismatches,
							content,
						),
					},
				],
				details: {
					path: relativePath,
					valid:
						missingSections.length === 0 &&
						emptySections.length === 0 &&
						duplicateSections.length === 0 &&
						missingMetadata.length === 0 &&
						duplicateMetadata.length === 0 &&
						metadataMismatches.length === 0,
					missingSections,
					emptySections,
					duplicateSections,
					missingMetadata,
					duplicateMetadata,
					metadataMismatches,
					staleStateChecks: EXECUTOR_STALE_STATE_CHECKS,
					bytes: content.length,
					profile: metadata.profile,
					title: metadata.title,
					createdAt: metadata.createdAt,
				},
			};
		},
		renderCall(args, theme, context) {
			const input = args as Partial<HandoffStatusToolInput> | undefined;
			const path = str(input?.path) ?? HANDOFF_DIR;
			const text = new Text("", 0, 0);
			text.setText(
				`${theme.fg("toolTitle", theme.bold("handoff_status"))} ${renderToolPath(path, theme, context.cwd)}`,
			);
			return text;
		},
	};
}

export function createHandoffStatusTool(
	cwd: string,
	options?: HandoffToolOptions,
): AgentTool<typeof handoffStatusSchema> {
	return wrapToolDefinition(createHandoffStatusToolDefinition(cwd, options));
}
