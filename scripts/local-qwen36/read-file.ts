import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentTool } from "../../packages/agent/src/index.ts";
import { Type, type Static } from "../../packages/ai/src/index.ts";

const readFileSchema = Type.Object({
	path: Type.String({ description: "Workspace-relative file path to read." }),
	startLine: Type.Optional(Type.Number({ description: "1-based first line to include." })),
	maxLines: Type.Optional(Type.Number({ description: "Maximum lines to return. Default 120, maximum 300." })),
});

type ReadFileParams = Static<typeof readFileSchema>;

function isWithinWorkspace(path: string, workspaceRoot: string): boolean {
	const rel = relative(workspaceRoot, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function resolveWorkspaceFile(cwd: string, path: string): Promise<{ absolutePath: string; relativePath: string }> {
	const workspaceRoot = await realpath(cwd);
	const rawPath = path.trim();
	const absolutePath = rawPath ? (isAbsolute(rawPath) ? rawPath : resolve(workspaceRoot, rawPath)) : workspaceRoot;
	if (!isWithinWorkspace(absolutePath, workspaceRoot)) {
		throw new Error(`path escapes workspace: ${path}`);
	}
	const resolvedPath = await realpath(absolutePath);
	if (!isWithinWorkspace(resolvedPath, workspaceRoot)) {
		throw new Error(`path escapes workspace: ${path}`);
	}
	const info = await stat(resolvedPath);
	if (!info.isFile()) throw new Error(`path is not a file: ${path}`);
	return { absolutePath: resolvedPath, relativePath: relative(workspaceRoot, resolvedPath).replaceAll("\\", "/") };
}

export function createReadFileTool(
	cwd: string,
): AgentTool<typeof readFileSchema, { path: string; startLine: number; endLine: number }> {
	return {
		label: "Read file",
		name: "read_file",
		description: "Read a bounded line range from one workspace file.",
		parameters: readFileSchema,
		executionMode: "parallel",
		execute: async (_toolCallId: string, params: ReadFileParams) => {
			const file = await resolveWorkspaceFile(cwd, params.path);
			const text = await readFile(file.absolutePath, "utf8");
			const lines = text.split(/\r?\n/);
			const startLine = Math.max(1, Math.trunc(params.startLine ?? 1));
			const maxLines = Math.min(300, Math.max(1, Math.trunc(params.maxLines ?? 120)));
			const selected = lines.slice(startLine - 1, startLine - 1 + maxLines);
			const endLine = startLine + selected.length - 1;
			const body = selected.map((line, index) => `${startLine + index}: ${line}`).join("\n");
			return {
				content: [{ type: "text", text: `${file.relativePath}:${startLine}-${endLine}\n${body}` }],
				details: { path: file.relativePath, startLine, endLine },
			};
		},
	};
}
