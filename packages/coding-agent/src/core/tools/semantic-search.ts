import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { WorkspaceSemanticIndex, WorkspaceSemanticSearchResponse } from "../workspace-semantic-index.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const semanticSearchSchema = Type.Object({
	query: Type.String({ description: "Concept or terms to find in the workspace" }),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 8)" })),
});

type SemanticSearchInput = Static<typeof semanticSearchSchema>;

export function createSemanticSearchToolDefinition(
	_cwd: string,
	options?: { index?: WorkspaceSemanticIndex },
): ToolDefinition<typeof semanticSearchSchema, WorkspaceSemanticSearchResponse> {
	return {
		name: "semantic_search",
		label: "semantic_search",
		description:
			"Find relevant workspace code using the native lexical index. Results are navigation-only; use read before editing.",
		promptSnippet: "Find relevant workspace code using lexical semantic indexing",
		parameters: semanticSearchSchema,
		async execute(_toolCallId, input: SemanticSearchInput, signal, _onUpdate, _ctx) {
			if (!options?.index) throw new Error("Workspace semantic index is unavailable");
			const response = await options.index.search(input.query, { limit: input.limit, signal });
			return {
				content: [{ type: "text", text: JSON.stringify(response) }],
				details: response,
			};
		},
	};
}

export function createSemanticSearchTool(
	cwd: string,
	options?: { index?: WorkspaceSemanticIndex },
): AgentTool<typeof semanticSearchSchema> {
	return wrapToolDefinition(createSemanticSearchToolDefinition(cwd, options));
}
