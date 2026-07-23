import type { AgentTool } from "../../packages/agent/src/index.ts";
import { Type, type Static } from "../../packages/ai/src/index.ts";
import { applyPatch, createTwoFilesPatch, parsePatch, type ParsedDiff } from "diff";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const applyDiffSchema = Type.Object({
	patch: Type.String({ description: "Unified diff to apply to local workspace files." }),
});

type ApplyDiffParams = Static<typeof applyDiffSchema>;

export interface AppliedDiffFile {
	path: string;
	absolutePath: string;
	changed: boolean;
	diff: string;
}

export interface ApplyUnifiedDiffResult {
	appliedFiles: AppliedDiffFile[];
}

interface PlannedPatch {
	patch: ParsedDiff;
	relativePath: string;
	absolutePath: string;
	deletesFile: boolean;
}

interface DryRunFile {
	relativePath: string;
	absolutePath: string;
	originalContent: string;
	patchedContent: string;
	deletesFile: boolean;
}

function stripDiffPrefix(fileName: string): string {
	if (fileName.startsWith("a/") || fileName.startsWith("b/")) return fileName.slice(2);
	return fileName;
}

function selectPatchPath(patch: ParsedDiff): { path: string; deletesFile: boolean } {
	const oldFileName = patch.oldFileName ?? "";
	const newFileName = patch.newFileName ?? "";
	if (newFileName && newFileName !== "/dev/null") {
		return { path: stripDiffPrefix(newFileName), deletesFile: false };
	}
	if (oldFileName && oldFileName !== "/dev/null") {
		return { path: stripDiffPrefix(oldFileName), deletesFile: newFileName === "/dev/null" };
	}
	throw new Error("patch target is missing a file name");
}

function isWithinWorkspace(candidate: string, workspaceRoot: string): boolean {
	return candidate === workspaceRoot || candidate.startsWith(`${workspaceRoot}${sep}`);
}

async function resolveExistingAncestor(path: string): Promise<string> {
	let current = path;
	while (true) {
		try {
			return await realpath(current);
		} catch (error) {
			if (
				typeof error !== "object" ||
				error === null ||
				!("code" in error) ||
				(error.code !== "ENOENT" && error.code !== "ENOTDIR")
			) {
				throw error;
			}
		}
		const parent = dirname(current);
		if (parent === current) return current;
		current = parent;
	}
}

async function resolvePatchPath(cwd: string, path: string): Promise<{ relativePath: string; absolutePath: string }> {
	if (!path || path === "/dev/null") throw new Error("patch target is missing a file name");
	if (isAbsolute(path)) throw new Error(`absolute patch paths are not allowed: ${path}`);

	const workspaceRoot = await realpath(cwd);
	const absolutePath = resolve(workspaceRoot, path);
	if (!isWithinWorkspace(absolutePath, workspaceRoot)) {
		throw new Error(`patch target ${path} escapes workspace ${workspaceRoot}`);
	}

	const existingTarget = await resolveExistingAncestor(absolutePath);
	if (!isWithinWorkspace(existingTarget, workspaceRoot)) {
		throw new Error(`patch target ${path} escapes workspace ${workspaceRoot}`);
	}

	return { relativePath: relative(workspaceRoot, absolutePath), absolutePath };
}

async function planPatches(cwd: string, patchText: string): Promise<PlannedPatch[]> {
	const parsed = parsePatch(patchText);
	if (parsed.length === 0) throw new Error("patch did not contain any file hunks");

	const planned: PlannedPatch[] = [];
	for (const patch of parsed) {
		if (!Array.isArray(patch.hunks) || patch.hunks.length === 0) {
			throw new Error("patch file entry did not contain any hunks");
		}
		const target = selectPatchPath(patch);
		const resolvedPath = await resolvePatchPath(cwd, target.path);
		planned.push({
			patch,
			relativePath: resolvedPath.relativePath,
			absolutePath: resolvedPath.absolutePath,
			deletesFile: target.deletesFile,
		});
	}
	return planned;
}

async function readTextFileForPatch(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ENOTDIR")
		) {
			return "";
		}
		throw error;
	}
}

export async function applyUnifiedDiff(input: { cwd: string; patch: string }): Promise<ApplyUnifiedDiffResult> {
	if (input.patch.trim().length === 0) throw new Error("patch must not be empty");

	const planned = await planPatches(input.cwd, input.patch);
	const byPath = new Map<string, PlannedPatch[]>();
	for (const patch of planned) {
		const entries = byPath.get(patch.absolutePath) ?? [];
		entries.push(patch);
		byPath.set(patch.absolutePath, entries);
	}

	const dryRuns: DryRunFile[] = [];
	for (const patches of byPath.values()) {
		const first = patches[0];
		const originalContent = await readTextFileForPatch(first.absolutePath);
		let patchedContent = originalContent;
		let deletesFile = false;

		for (const plannedPatch of patches) {
			const nextContent = applyPatch(patchedContent, plannedPatch.patch, {
				autoConvertLineEndings: false,
				fuzzFactor: 0,
			});
			if (nextContent === false) {
				throw new Error(`patch dry-run failed for ${plannedPatch.relativePath}`);
			}
			patchedContent = nextContent;
			deletesFile = plannedPatch.deletesFile;
		}

		dryRuns.push({
			relativePath: first.relativePath,
			absolutePath: first.absolutePath,
			originalContent,
			patchedContent,
			deletesFile,
		});
	}

	const appliedFiles: AppliedDiffFile[] = [];
	for (const dryRun of dryRuns) {
		if (dryRun.deletesFile) {
			await rm(dryRun.absolutePath, { force: true });
		} else {
			await mkdir(dirname(dryRun.absolutePath), { recursive: true });
			await writeFile(dryRun.absolutePath, dryRun.patchedContent, "utf8");
		}

		appliedFiles.push({
			path: dryRun.relativePath,
			absolutePath: dryRun.absolutePath,
			changed: dryRun.originalContent !== dryRun.patchedContent || dryRun.deletesFile,
			diff: createTwoFilesPatch(
				dryRun.relativePath,
				dryRun.relativePath,
				dryRun.originalContent,
				dryRun.deletesFile ? "" : dryRun.patchedContent,
			),
		});
	}

	return { appliedFiles };
}

export function createApplyDiffTool(cwd: string): AgentTool<typeof applyDiffSchema, ApplyUnifiedDiffResult> {
	return {
		label: "Apply diff",
		name: "apply_diff",
		description: "Apply a unified diff to local workspace files after deterministic dry-run validation.",
		parameters: applyDiffSchema,
		executionMode: "sequential",
		execute: async (_toolCallId: string, params: ApplyDiffParams) => {
			const result = await applyUnifiedDiff({ cwd, patch: params.patch });
			const files = result.appliedFiles.map((file) => file.path).join(", ");
			return {
				content: [{ type: "text", text: `Applied diff to ${result.appliedFiles.length} file(s): ${files}` }],
				details: result,
			};
		},
	};
}
