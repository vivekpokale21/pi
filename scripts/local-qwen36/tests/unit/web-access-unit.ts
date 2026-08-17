#!/usr/bin/env -S node --import tsx
import assert from "node:assert/strict";
import { createWebFetchTool, createWebSearchTool, fetchWebPage, searchWeb } from "../../web-access.ts";
import { EXECUTOR_TOOL_NAMES, PLANNER_TOOL_NAMES, isPlannerToolAllowed } from "../../read-only.ts";

const html = `
<!doctype html>
<html>
	<head><title>Example docs</title><script>ignore()</script><style>body{}</style></head>
	<body>
		<h1>Example API</h1>
		<p>Use the current endpoint for web lookup.</p>
	</body>
</html>
`;

const fetchImpl: typeof fetch = async (input) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
	if (url === "https://example.test/docs") {
		return new Response(html, {
			status: 200,
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	}
	if (url.startsWith("https://html.duckduckgo.com/html/")) {
		return new Response(
			`
			<html><body>
				<a class="result__a" href="https://example.test/docs">Example docs</a>
				<a class="result__snippet">Current API docs snippet</a>
			</body></html>
			`,
			{ status: 200, headers: { "content-type": "text/html" } },
		);
	}
	return new Response("not found", { status: 404 });
};

const page = await fetchWebPage({ url: "https://example.test/docs", fetchImpl });
assert.equal(page.url, "https://example.test/docs");
assert.equal(page.status, 200);
assert.equal(page.title, "Example docs");
assert.match(page.text, /Example API/);
assert.match(page.text, /current endpoint/);
assert.doesNotMatch(page.text, /ignore/);

const fetchTool = createWebFetchTool({ fetchImpl });
const fetchResult = await fetchTool.execute("tool-call-id", { url: "https://example.test/docs" });
assert.match(fetchResult.content[0]?.type === "text" ? fetchResult.content[0].text : "", /web_fetch status=200/);
assert.match(fetchResult.content[0]?.type === "text" ? fetchResult.content[0].text : "", /Example API/);

const search = await searchWeb({ query: "example api docs", fetchImpl });
assert.equal(search.results.length, 1);
assert.equal(search.results[0]?.title, "Example docs");
assert.equal(search.results[0]?.url, "https://example.test/docs");

const searchTool = createWebSearchTool({ fetchImpl });
const searchResult = await searchTool.execute("tool-call-id", { query: "example api docs" });
assert.match(searchResult.content[0]?.type === "text" ? searchResult.content[0].text : "", /web_search query="example api docs"/);
assert.match(searchResult.content[0]?.type === "text" ? searchResult.content[0].text : "", /Example docs/);

assert.equal(PLANNER_TOOL_NAMES.includes("web_fetch"), true);
assert.equal(PLANNER_TOOL_NAMES.includes("web_search"), true);
assert.equal(EXECUTOR_TOOL_NAMES.includes("web_fetch"), true);
assert.equal(EXECUTOR_TOOL_NAMES.includes("web_search"), true);
assert.equal(isPlannerToolAllowed("web_fetch"), true);
assert.equal(isPlannerToolAllowed("web_search"), true);

console.log("web-access-unit: ok");
