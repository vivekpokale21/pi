#!/usr/bin/env -S node --import tsx
import assert from "node:assert/strict";
import { createLocalQwen36HarnessTools, parseAgentCliArgs } from "../../agent-cli.ts";

const tools = createLocalQwen36HarnessTools(process.cwd());
const toolNames = tools.map((tool) => tool.name);

assert.equal(toolNames.includes("semantic_search"), true);
assert.equal(toolNames.includes("lsp_symbols"), true);
assert.equal(toolNames.includes("read_file"), true);
assert.equal(toolNames.includes("apply_diff"), true);
assert.equal(toolNames.includes("web_search"), true);
assert.equal(toolNames.includes("web_fetch"), true);

const parsed = parseAgentCliArgs(["--cwd", "/tmp/work", "--prompt", "hello"]);
assert.equal(parsed.cwd, "/tmp/work");
assert.equal(parsed.prompt, "hello");
assert.equal(parsed.help, false);

assert.equal(parseAgentCliArgs(["--help"]).help, true);

console.log("agent-cli-unit: ok");
