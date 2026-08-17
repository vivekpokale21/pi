const QWEN36_AGENT_GUIDANCE_LINES = [
	"<qwen36_agent_guidance>",
	"Core rule: use harness tools as a progressive context gateway.",
	"Search results and snippets are navigation evidence, not an editing substrate.",
	"Before editing existing code, read the defining symbol or focused region with read_file.",
	"Retrieval ladder:",
	"1. Use repository maps, file lists, or known paths to narrow the search area.",
	"2. Use lsp_symbols for exact structural questions inside a known file.",
	"3. Use semantic_search for conceptual discovery, similar code, tests, state storage, retry logic, token rotation, or cross-cutting concepts.",
	"4. Follow search or LSP results with read_file.",
	"5. Prefer read_file mode=map before reading unfamiliar source file bodies.",
	"6. Prefer read_file mode=symbol for named functions, classes, methods, and tests.",
	"7. Use bounded read_file ranges to follow search line ranges or expand around a symbol.",
	"8. Expand above/below when control flow crosses the current context.",
	"9. Read parent scope when local state, decorators, class fields, imports, or module-level constants matter.",
	"10. Read the full file only when changes span multiple symbols, module-level state matters, or fragmented reads are reconstructing most of the file.",
	"Prefer lsp_symbols for definitions, document symbols, references, implementations, type/hover data, and diagnostics when available.",
	"Prefer semantic_search for behavior location, similar code, tests, naming mismatches, and feature ownership.",
	"Lexical semantic_search changes candidate ranking only; it is not a reason to dump whole files with read_file.",
	"Stop retrieving once enough evidence exists to make and verify the change.",
	"Do not repeatedly read overlapping ranges unless expanding context is necessary.",
	"Use read_file receipts: fileRevision, chunkId, overlap, novel-line counts, and escalation hints.",
	"Under low context budget, use exact navigation and focused symbols.",
	"Under critical context budget, stop exploratory retrieval and finish, verify, or checkpoint.",
	"Use apply_diff for file changes.",
	"Do not use shell redirection, sed -i, cat >, tee, or heredocs as default editing primitives.",
	"Do not edit code seen only in search snippets.",
	"Include enough old-side diff context for a unique match without padding hunks with large unrelated blocks.",
	"If apply_diff fails, use the diagnostic category: no matching region, multiple candidate regions, stale file revision, or content conflict.",
	"When available, pass a file hash or revision guard from the last read for stale-file protection.",
	"Planner should gather repository/file structure, relevant files and symbols, architectural relationships, known failures and verification state.",
	"Planner should avoid full implementation files unless necessary and raw logs unless they contain the only useful diagnostic.",
	"Executor should gather exact implementation regions, directly related callers/callees/types/tests, recent diagnostics, current file revisions before editing.",
	"Executor should avoid re-reading broad historical planning context and speculative retrieval after enough evidence exists to edit.",
	"Treat apply_diff receipts as write verification only.",
	"Run formatters, diagnostics, focused tests, or broader tests as separate verification.",
	"Report measured changes only from traces or benchmark output.",
	"Do not claim semantic-search speed or quality improvements from a lexical-only benchmark.",
	"</qwen36_agent_guidance>",
];

export function buildQwen36AgentGuidanceBlock(): string {
	return QWEN36_AGENT_GUIDANCE_LINES.join("\n");
}

export function appendQwen36AgentGuidanceToSystemPrompt(systemPrompt: string): string {
	return [systemPrompt.trimEnd(), buildQwen36AgentGuidanceBlock()].filter(Boolean).join("\n\n");
}
