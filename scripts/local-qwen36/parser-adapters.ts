import { createHash } from "node:crypto";
import { extname } from "node:path";
import ts from "typescript";
import type { SemanticSearchChunk, SemanticSearchImportEdge, SemanticSearchLanguageTier } from "./semantic-search.ts";

export interface ParserAdapter {
	language: string;
	tier: SemanticSearchLanguageTier;
	extract(input: { path: string; text: string }): {
		chunks: SemanticSearchChunk[];
		imports: SemanticSearchImportEdge[];
		warnings: string[];
	};
}

function chunkId(path: string, startLine: number, endLine: number, text: string): string {
	return createHash("sha256").update(`${path}\n${startLine}\n${endLine}\n${text}`).digest("hex");
}

function buildChunk(input: {
	path: string;
	language: string;
	languageTier: SemanticSearchLanguageTier;
	startLine: number;
	endLine: number;
	text: string;
	symbolName?: string;
	symbolKind?: string;
}): SemanticSearchChunk {
	const symbolHeader =
		input.symbolName && input.symbolKind ? [`# Symbol: ${input.symbolKind} ${input.symbolName}`] : [];
	return {
		id: chunkId(input.path, input.startLine, input.endLine, input.text),
		path: input.path,
		language: input.language,
		languageTier: input.languageTier,
		symbolName: input.symbolName,
		symbolKind: input.symbolKind,
		startLine: input.startLine,
		endLine: input.endLine,
		text: input.text,
		textWithHeader: [
			`# File: ${input.path}`,
			`# Lines: ${input.startLine}-${input.endLine}`,
			`# Language: ${input.language}`,
			`# Language tier: ${input.languageTier}`,
			...symbolHeader,
			input.text,
		].join("\n"),
	};
}

function lineWindowFallback(path: string, text: string): SemanticSearchChunk[] {
	const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
	if (lines.length === 1 && lines[0] === "") return [];
	return [
		buildChunk({
			path,
			language: "typescript",
			languageTier: "line-window",
			startLine: 1,
			endLine: lines.length,
			text: lines.join("\n"),
		}),
	];
}

function lineRange(sourceFile: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } {
	const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
	return { startLine: start.line + 1, endLine: end.line + 1 };
}

function textForRange(lines: string[], range: { startLine: number; endLine: number }): string {
	return lines.slice(range.startLine - 1, range.endLine).join("\n");
}

function nodeNameText(node: ts.Node): string | undefined {
	if (
		ts.isIdentifier(node) ||
		ts.isStringLiteral(node) ||
		ts.isNumericLiteral(node) ||
		ts.isPrivateIdentifier(node)
	) {
		return node.text;
	}
	return undefined;
}

function classMemberName(className: string, member: ts.ClassElement): string | undefined {
	if (!ts.isMethodDeclaration(member) || !member.name) return undefined;
	const name = nodeNameText(member.name);
	return name ? `${className}.${name}` : undefined;
}

function collectImportEdges(sourceFile: ts.SourceFile, path: string): SemanticSearchImportEdge[] {
	const imports: SemanticSearchImportEdge[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			imports.push({ fromPath: path, specifier: node.moduleSpecifier.text, kind: "static", confidence: "high" });
		}
		if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			imports.push({ fromPath: path, specifier: node.moduleSpecifier.text, kind: "reexport", confidence: "high" });
		}
		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length === 1 &&
			ts.isStringLiteral(node.arguments[0])
		) {
			imports.push({ fromPath: path, specifier: node.arguments[0].text, kind: "dynamic", confidence: "medium" });
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return imports;
}

function scriptKindForPath(path: string): ts.ScriptKind {
	switch (extname(path).toLowerCase()) {
		case ".tsx":
		case ".jsx":
			return ts.ScriptKind.TSX;
		case ".js":
			return ts.ScriptKind.JS;
		default:
			return ts.ScriptKind.TS;
	}
}

export function createTypeScriptParserAdapter(): ParserAdapter {
	return {
		language: "typescript",
		tier: "structured",
		extract: (input) => {
			const sourceFile = ts.createSourceFile(
				input.path,
				input.text,
				ts.ScriptTarget.Latest,
				true,
				scriptKindForPath(input.path),
			);
			if (sourceFile.parseDiagnostics.length > 0) {
				return {
					chunks: lineWindowFallback(input.path, input.text),
					imports: [],
					warnings: [`parser failed for ${input.path}: ${sourceFile.parseDiagnostics[0]?.messageText}`],
				};
			}

			const lines = input.text.replace(/\r?\n$/, "").split(/\r?\n/);
			const chunks: SemanticSearchChunk[] = [];
			for (const statement of sourceFile.statements) {
				if (ts.isInterfaceDeclaration(statement)) {
					const range = lineRange(sourceFile, statement);
					chunks.push(
						buildChunk({
							path: input.path,
							language: "typescript",
							languageTier: "structured",
							startLine: range.startLine,
							endLine: range.endLine,
							text: textForRange(lines, range),
							symbolName: statement.name.text,
							symbolKind: "interface",
						}),
					);
				}
				if (ts.isClassDeclaration(statement) && statement.name) {
					const classRange = lineRange(sourceFile, statement);
					const className = statement.name.text;
					chunks.push(
						buildChunk({
							path: input.path,
							language: "typescript",
							languageTier: "structured",
							startLine: classRange.startLine,
							endLine: classRange.endLine,
							text: textForRange(lines, classRange),
							symbolName: className,
							symbolKind: "class",
						}),
					);
					for (const member of statement.members) {
						const methodName = classMemberName(className, member);
						if (!methodName) continue;
						const methodRange = lineRange(sourceFile, member);
						chunks.push(
							buildChunk({
								path: input.path,
								language: "typescript",
								languageTier: "structured",
								startLine: methodRange.startLine,
								endLine: methodRange.endLine,
								text: textForRange(lines, methodRange),
								symbolName: methodName,
								symbolKind: "method",
							}),
						);
					}
				}
				if (ts.isFunctionDeclaration(statement) && statement.name) {
					const range = lineRange(sourceFile, statement);
					chunks.push(
						buildChunk({
							path: input.path,
							language: "typescript",
							languageTier: "structured",
							startLine: range.startLine,
							endLine: range.endLine,
							text: textForRange(lines, range),
							symbolName: statement.name.text,
							symbolKind: "function",
						}),
					);
				}
			}

			return { chunks, imports: collectImportEdges(sourceFile, input.path), warnings: [] };
		},
	};
}

export function createParserAdapterForLanguage(language: string): ParserAdapter | undefined {
	return language === "typescript" ? createTypeScriptParserAdapter() : undefined;
}
