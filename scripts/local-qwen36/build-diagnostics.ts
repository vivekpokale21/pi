export type BuildDiagnosticSource = "typescript" | "biome" | "vitest" | "node-test" | "shell" | "unknown";
export type BuildDiagnosticSeverity = "error" | "warning" | "info";

export interface BuildDiagnostic {
	source: BuildDiagnosticSource;
	severity: BuildDiagnosticSeverity;
	path?: string;
	line?: number;
	column?: number;
	code?: string;
	message: string;
	raw: string;
}

const SEVERITY_RANK: Record<BuildDiagnosticSeverity, number> = {
	error: 0,
	warning: 1,
	info: 2,
};

function trimAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function normalizeMessage(message: string): string {
	return message.replace(/\s+/g, " ").trim();
}

function parseInteger(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function severityFromText(value: string): BuildDiagnosticSeverity {
	const lower = value.toLowerCase();
	if (lower.includes("warn")) return "warning";
	if (lower.includes("info") || lower === "i") return "info";
	return "error";
}

function parseTypeScriptLine(line: string): BuildDiagnostic | undefined {
	const match = /^(?<path>.+?)\((?<line>\d+),(?<column>\d+)\):\s+(?<severity>error|warning|info)\s+(?<code>TS\d+):\s+(?<message>.+)$/.exec(line);
	if (!match?.groups) return undefined;
	return {
		source: "typescript",
		severity: severityFromText(match.groups.severity),
		path: match.groups.path,
		line: parseInteger(match.groups.line),
		column: parseInteger(match.groups.column),
		code: match.groups.code,
		message: normalizeMessage(match.groups.message),
		raw: line,
	};
}

function parseBiomeLines(lines: string[], index: number): BuildDiagnostic | undefined {
	const line = lines[index];
	const match = /^(?<path>.+?):(?<line>\d+):(?<column>\d+)\s+(?<code>[^\s]+)\s+━+/.exec(line);
	if (!match?.groups) return undefined;
	let markerLine = "";
	for (let nextIndex = index + 1; nextIndex < Math.min(lines.length, index + 6); nextIndex += 1) {
		const candidate = lines[nextIndex].trim();
		if (/^[×!i]\s+/.test(candidate)) {
			markerLine = candidate;
			break;
		}
	}
	const marker = markerLine.slice(0, 1);
	const message = markerLine ? markerLine.slice(1).trim() : match.groups.code;
	return {
		source: "biome",
		severity: severityFromText(marker || match.groups.code),
		path: match.groups.path,
		line: parseInteger(match.groups.line),
		column: parseInteger(match.groups.column),
		code: match.groups.code,
		message: normalizeMessage(message),
		raw: line,
	};
}

function parseVitestLines(lines: string[], index: number): BuildDiagnostic | undefined {
	const line = lines[index];
	const failMatch = /^\s*FAIL\s+(?<path>\S+)\s*>\s*(?<name>.+)$/.exec(line);
	if (!failMatch?.groups) return undefined;
	let assertion = "";
	let locationPath = failMatch.groups.path;
	let lineNumber: number | undefined;
	let columnNumber: number | undefined;
	for (let nextIndex = index + 1; nextIndex < Math.min(lines.length, index + 12); nextIndex += 1) {
		const candidate = lines[nextIndex].trim();
		if (!assertion && /(?:AssertionError|Error):\s+/.test(candidate)) {
			assertion = candidate.replace(/^(?:AssertionError|Error):\s+/, "");
		}
		const locationMatch = /^[❯>]?\s*(?<path>[^:\s]+(?:\.test|\.spec)\.[tj]sx?):(?<line>\d+):(?<column>\d+)/.exec(candidate);
		if (locationMatch?.groups) {
			locationPath = locationMatch.groups.path;
			lineNumber = parseInteger(locationMatch.groups.line);
			columnNumber = parseInteger(locationMatch.groups.column);
			break;
		}
	}
	const messageParts = [failMatch.groups.name, assertion].filter((part) => part.length > 0);
	return {
		source: "vitest",
		severity: "error",
		path: locationPath,
		line: lineNumber,
		column: columnNumber,
		message: normalizeMessage(messageParts.join(": ")),
		raw: line,
	};
}

function sortDiagnostics(diagnostics: BuildDiagnostic[]): BuildDiagnostic[] {
	return [...diagnostics].sort(
		(left, right) =>
			SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
			(left.path ?? "").localeCompare(right.path ?? "") ||
			(left.line ?? 0) - (right.line ?? 0) ||
			(left.column ?? 0) - (right.column ?? 0) ||
			left.source.localeCompare(right.source) ||
			left.message.localeCompare(right.message),
	);
}

function firstNonEmptyLine(output: string): string {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0) ?? "command failed without output";
}

export function parseBuildDiagnostics(output: string): BuildDiagnostic[] {
	const cleaned = trimAnsi(output);
	const lines = cleaned.split(/\r?\n/);
	const diagnostics: BuildDiagnostic[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trimEnd();
		if (!line.trim()) continue;
		const parsed =
			parseTypeScriptLine(line) ?? parseBiomeLines(lines, index) ?? parseVitestLines(lines, index);
		if (parsed) diagnostics.push(parsed);
	}
	if (diagnostics.length === 0) {
		const line = firstNonEmptyLine(cleaned);
		return [{ source: "shell", severity: "error", message: normalizeMessage(line), raw: line }];
	}
	return sortDiagnostics(diagnostics);
}

function diagnosticLocation(diagnostic: BuildDiagnostic): string {
	if (!diagnostic.path) return "";
	const line = diagnostic.line === undefined ? "" : `:${diagnostic.line}`;
	const column = diagnostic.column === undefined ? "" : `:${diagnostic.column}`;
	return `${diagnostic.path}${line}${column}`;
}

function formatDiagnosticLine(diagnostic: BuildDiagnostic): string {
	const location = diagnosticLocation(diagnostic);
	const code = diagnostic.code ? ` ${diagnostic.code}` : "";
	const target = location ? ` ${location}` : "";
	return `- ${diagnostic.severity} ${diagnostic.source}${target}${code} ${diagnostic.message}`;
}

export function formatBuildDiagnosticsForPrompt(input: {
	diagnostics: BuildDiagnostic[];
	attempt: number;
	remaining: number;
	maxPromptChars: number;
}): string {
	const opening = `<build_diagnostics attempt="${input.attempt}" remaining="${input.remaining}">`;
	const closing = "</build_diagnostics>";
	const maxPromptChars = Math.max(opening.length + closing.length + 2, Math.floor(input.maxPromptChars));
	const lines = [opening];
	for (const diagnostic of sortDiagnostics(input.diagnostics)) {
		const nextLine = formatDiagnosticLine(diagnostic);
		const candidate = [...lines, nextLine, closing].join("\n");
		if (candidate.length > maxPromptChars) break;
		lines.push(nextLine);
	}
	lines.push(closing);
	return lines.join("\n");
}
