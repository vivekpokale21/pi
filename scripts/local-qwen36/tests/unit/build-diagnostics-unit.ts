#!/usr/bin/env -S node --import tsx
import assert from "node:assert/strict";
import { formatBuildDiagnosticsForPrompt, parseBuildDiagnostics } from "../../build-diagnostics.ts";

function parsesTypeScriptDiagnostics(): void {
	const diagnostics = parseBuildDiagnostics(
		[
			"packages/foo/src/bar.ts(12,7): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
			"scripts/demo.ts(4,1): warning TS6133: 'unused' is declared but its value is never read.",
		].join("\n"),
	);

	assert.deepEqual(
		diagnostics.map((diagnostic) => ({
			source: diagnostic.source,
			severity: diagnostic.severity,
			path: diagnostic.path,
			line: diagnostic.line,
			column: diagnostic.column,
			code: diagnostic.code,
			message: diagnostic.message,
		})),
		[
			{
				source: "typescript",
				severity: "error",
				path: "packages/foo/src/bar.ts",
				line: 12,
				column: 7,
				code: "TS2345",
				message: "Argument of type 'string' is not assignable to parameter of type 'number'.",
			},
			{
				source: "typescript",
				severity: "warning",
				path: "scripts/demo.ts",
				line: 4,
				column: 1,
				code: "TS6133",
				message: "'unused' is declared but its value is never read.",
			},
		],
	);
}

function parsesBiomeDiagnostics(): void {
	const diagnostics = parseBuildDiagnostics(
		[
			"scripts/local-qwen36/example.ts:17:5 lint/style/useConst ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
			"  × This let declares a variable that is only assigned once.",
			"",
			"packages/foo/src/index.ts:9:1 parse ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
			"  i Formatter would have printed the following content:",
		].join("\n"),
	);

	assert.deepEqual(
		diagnostics.map((diagnostic) => [diagnostic.source, diagnostic.severity, diagnostic.path, diagnostic.line, diagnostic.column, diagnostic.code, diagnostic.message]),
		[
			[
				"biome",
				"error",
				"scripts/local-qwen36/example.ts",
				17,
				5,
				"lint/style/useConst",
				"This let declares a variable that is only assigned once.",
			],
			["biome", "info", "packages/foo/src/index.ts", 9, 1, "parse", "Formatter would have printed the following content:"],
		],
	);
}

function parsesVitestFailures(): void {
	const diagnostics = parseBuildDiagnostics(
		[
			" FAIL  packages/foo/test/bar.test.ts > auth service > rejects expired token",
			"AssertionError: expected true to equal false",
			" ❯ packages/foo/test/bar.test.ts:44:12",
		].join("\n"),
	);

	assert.deepEqual(
		diagnostics.map((diagnostic) => [diagnostic.source, diagnostic.severity, diagnostic.path, diagnostic.line, diagnostic.column, diagnostic.message]),
		[["vitest", "error", "packages/foo/test/bar.test.ts", 44, 12, "auth service > rejects expired token: expected true to equal false"]],
	);
}

function fallsBackToShellDiagnostics(): void {
	const diagnostics = parseBuildDiagnostics("command failed with exit code 127\nmissing-tool: not found\n");

	assert.deepEqual(
		diagnostics.map((diagnostic) => [diagnostic.source, diagnostic.severity, diagnostic.message, diagnostic.raw]),
		[["shell", "error", "command failed with exit code 127", "command failed with exit code 127"]],
	);
}

function formatsPromptWithStableTruncation(): void {
	const diagnostics = parseBuildDiagnostics(
		[
			"z.ts(5,1): warning TS1000: z warning",
			"a.ts(2,3): error TS2000: a error",
			"a.ts(1,1): error TS1000: first error",
		].join("\n"),
	);
	const prompt = formatBuildDiagnosticsForPrompt({
		diagnostics,
		attempt: 1,
		remaining: 1,
		maxPromptChars: 150,
	});

	assert.match(prompt, /^<build_diagnostics attempt="1" remaining="1">\n/);
	assert.match(prompt, /- error typescript a\.ts:1:1 TS1000 first error/);
	assert.match(prompt, /<\/build_diagnostics>$/);
	assert.doesNotMatch(prompt, /z warning/);
}

parsesTypeScriptDiagnostics();
parsesBiomeDiagnostics();
parsesVitestFailures();
fallsBackToShellDiagnostics();
formatsPromptWithStableTruncation();

console.log("build-diagnostics-unit: ok");
