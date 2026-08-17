import { extname } from "node:path";
import ts from "typescript";

export interface WorkspaceSemanticChunk {
	text: string;
	startLine: number;
	endLine: number;
	languageTier: "structured" | "line-window";
	symbolName?: string;
	symbolKind?: string;
}

function range(sourceFile: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } {
	const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
	const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
	return { startLine: start, endLine: end };
}

function nodeName(node: ts.Statement): string | undefined {
	if (
		(ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
		node.name
	) {
		return node.name.text;
	}
	if (ts.isVariableStatement(node)) {
		const declaration = node.declarationList.declarations[0];
		return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
	}
	return undefined;
}

export function parseWorkspaceChunks(path: string, text: string): WorkspaceSemanticChunk[] {
	const extension = extname(path).toLowerCase();
	if (![".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"].includes(extension)) {
		return [{ text, startLine: 1, endLine: text.split(/\r?\n/).length, languageTier: "line-window" }];
	}
	const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
	const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
	const chunks = sourceFile.statements.flatMap((statement): WorkspaceSemanticChunk[] => {
		const name = nodeName(statement);
		if (!name) return [];
		const statementRange = range(sourceFile, statement);
		const kind = ts.isFunctionDeclaration(statement)
			? "function"
			: ts.isClassDeclaration(statement)
				? "class"
				: ts.isInterfaceDeclaration(statement)
					? "interface"
					: ts.isVariableStatement(statement)
						? "variable"
						: undefined;
		if (!kind) return [];
		return [
			{
				text: lines.slice(statementRange.startLine - 1, statementRange.endLine).join("\n"),
				...statementRange,
				languageTier: "structured",
				symbolName: name,
				symbolKind: kind,
			},
		];
	});
	return chunks.length > 0 ? chunks : [{ text, startLine: 1, endLine: lines.length, languageTier: "line-window" }];
}
