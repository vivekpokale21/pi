export const PLANNER_TOOL_NAMES = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"read_marker",
	"lsp_symbols",
	"semantic_search",
] as const;
export const EXECUTOR_TOOL_NAMES = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"edit",
	"write",
	"apply_diff",
	"read_marker",
	"write_marker",
	"lsp_symbols",
	"semantic_search",
] as const;

const MUTATING_TOOL_NAMES = new Set(["edit", "write", "write_marker", "apply_diff", "bash_write"]);

const DESTRUCTIVE_BASH_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\btee\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
];

const SAFE_BASH_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*grep\b/,
	/^\s*rg\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*which\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-)/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
];

export function isPlannerToolAllowed(toolName: string): boolean {
	return !MUTATING_TOOL_NAMES.has(toolName);
}

export function isReadOnlyBash(command: string): boolean {
	const destructive = DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(command));
	const safe = SAFE_BASH_PATTERNS.some((pattern) => pattern.test(command));
	return safe && !destructive;
}
