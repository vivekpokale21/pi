import type { AgentTool } from "../../packages/agent/src/index.ts";
import { Type, type Static } from "../../packages/ai/src/index.ts";

const webFetchSchema = Type.Object({
	url: Type.String({ description: "Absolute URL to fetch." }),
	maxChars: Type.Optional(Type.Number({ description: "Maximum extracted text characters to return." })),
});

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query." }),
	maxResults: Type.Optional(Type.Number({ description: "Maximum search results to return." })),
});

type WebFetchParams = Static<typeof webFetchSchema>;
type WebSearchParams = Static<typeof webSearchSchema>;

export interface WebPageResult {
	url: string;
	status: number;
	contentType: string;
	title: string;
	text: string;
}

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface WebSearchOutput {
	query: string;
	results: WebSearchResult[];
}

export interface WebAccessToolOptions {
	fetchImpl?: typeof fetch;
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function extractTitle(html: string): string {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	return match ? normalizeWhitespace(decodeHtmlEntities(match[1] ?? "")) : "";
}

function htmlToText(html: string): string {
	const withoutScripts = html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
	const withBreaks = withoutScripts.replace(/<\/(?:p|div|br|li|h[1-6]|tr)>/gi, "\n");
	return normalizeWhitespace(decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, " ")));
}

function coerceLimit(value: number | undefined, fallback: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.min(max, Math.floor(value)));
}

export async function fetchWebPage(input: {
	url: string;
	maxChars?: number;
	fetchImpl?: typeof fetch;
}): Promise<WebPageResult> {
	const url = new URL(input.url);
	const response = await (input.fetchImpl ?? fetch)(url);
	const raw = await response.text();
	const contentType = response.headers.get("content-type") ?? "";
	const maxChars = coerceLimit(input.maxChars, 12_000, 100_000);
	const text = contentType.toLowerCase().includes("html") ? htmlToText(raw) : normalizeWhitespace(raw);
	return {
		url: response.url || url.toString(),
		status: response.status,
		contentType,
		title: contentType.toLowerCase().includes("html") ? extractTitle(raw) : "",
		text: text.slice(0, maxChars),
	};
}

function extractDuckDuckGoResults(html: string, maxResults: number): WebSearchResult[] {
	const results: WebSearchResult[] = [];
	const linkPattern = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
	let match: RegExpExecArray | null;
	while ((match = linkPattern.exec(html)) && results.length < maxResults) {
		const url = decodeHtmlEntities(match[1] ?? "");
		const title = normalizeWhitespace(htmlToText(match[2] ?? ""));
		if (!url || !title) continue;
		const remaining = html.slice(linkPattern.lastIndex, linkPattern.lastIndex + 1200);
		const snippetMatch = /<a[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(remaining);
		const snippet = snippetMatch ? normalizeWhitespace(htmlToText(snippetMatch[1] ?? "")) : "";
		results.push({ title, url, snippet });
	}
	return results;
}

export async function searchWeb(input: {
	query: string;
	maxResults?: number;
	fetchImpl?: typeof fetch;
}): Promise<WebSearchOutput> {
	const maxResults = coerceLimit(input.maxResults, 5, 20);
	const searchUrl = new URL("https://html.duckduckgo.com/html/");
	searchUrl.searchParams.set("q", input.query);
	const response = await (input.fetchImpl ?? fetch)(searchUrl);
	if (!response.ok) {
		throw new Error(`web_search failed: HTTP ${response.status}`);
	}
	const html = await response.text();
	return { query: input.query, results: extractDuckDuckGoResults(html, maxResults) };
}

export function createWebFetchTool(options: WebAccessToolOptions = {}): AgentTool<typeof webFetchSchema, WebPageResult> {
	return {
		label: "Web fetch",
		name: "web_fetch",
		description: "Fetch a web page URL and return extracted text.",
		parameters: webFetchSchema,
		executionMode: "parallel",
		execute: async (_toolCallId: string, params: WebFetchParams) => {
			const result = await fetchWebPage({ url: params.url, maxChars: params.maxChars, fetchImpl: options.fetchImpl });
			const lines = [
				`web_fetch status=${result.status} url=${result.url}`,
				result.title ? `title: ${result.title}` : undefined,
				result.text,
			].filter((line): line is string => line !== undefined && line.length > 0);
			return { content: [{ type: "text", text: lines.join("\n") }], details: result };
		},
	};
}

export function createWebSearchTool(options: WebAccessToolOptions = {}): AgentTool<typeof webSearchSchema, WebSearchOutput> {
	return {
		label: "Web search",
		name: "web_search",
		description: "Search the web and return result titles, URLs, and snippets.",
		parameters: webSearchSchema,
		executionMode: "parallel",
		execute: async (_toolCallId: string, params: WebSearchParams) => {
			const result = await searchWeb({
				query: params.query,
				maxResults: params.maxResults,
				fetchImpl: options.fetchImpl,
			});
			const lines = [
				`web_search query="${result.query}" returned=${result.results.length}`,
				...result.results.map((entry, index) => `${index + 1}. ${entry.title}\n   ${entry.url}${entry.snippet ? `\n   ${entry.snippet}` : ""}`),
			];
			return { content: [{ type: "text", text: lines.join("\n") }], details: result };
		},
	};
}
