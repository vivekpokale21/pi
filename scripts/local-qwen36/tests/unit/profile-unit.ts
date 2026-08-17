#!/usr/bin/env -S node --import tsx
import assert from "node:assert/strict";
import { buildQwen36SystemPromptWithMemory } from "../../profile-memory.ts";
import { applyQwen36ProfileToPayload, createLocalQwen36Model, getQwen36Profile } from "../../profiles.ts";
import { EXECUTOR_TOOL_NAMES, isPlannerToolAllowed, isReadOnlyBash, PLANNER_TOOL_NAMES } from "../../read-only.ts";

const planner = getQwen36Profile("planner");
assert.equal(planner.temperature, 0.55);
assert.equal(planner.topP, 0.95);
assert.equal(planner.topK, 20);
assert.equal(planner.minP, 0.05);
assert.equal(planner.presencePenalty, 0.25);
assert.equal(planner.repeatPenalty, 1.03);
assert.equal(planner.repeatLastN, 128);
assert.equal(planner.enableThinking, true);
assert.equal(planner.preserveThinking, true);
assert.equal(planner.thinkingLevel, "low");

const executor = getQwen36Profile("executor");
assert.equal(executor.temperature, 0.2);
assert.equal(executor.topP, 0.9);
assert.equal(executor.topK, 20);
assert.equal(executor.minP, 0.02);
assert.equal(executor.presencePenalty, 0);
assert.equal(executor.repeatPenalty, 1.02);
assert.equal(executor.repeatLastN, 128);
assert.equal(executor.enableThinking, false);
assert.equal(executor.preserveThinking, true);
assert.equal(executor.thinkingLevel, "off");

const payload = applyQwen36ProfileToPayload({ model: "qwen", chat_template_kwargs: { existing: true } }, planner) as Record<
	string,
	any
>;
assert.equal(payload.temperature, 0.55);
assert.equal(payload.top_p, 0.95);
assert.equal(payload.top_k, 20);
assert.equal(payload.min_p, 0.05);
assert.equal(payload.presence_penalty, 0.25);
assert.equal(payload.repeat_penalty, 1.03);
assert.equal(payload.repeat_last_n, 128);
assert.equal(payload.chat_template_kwargs.existing, true);
assert.equal(payload.chat_template_kwargs.enable_thinking, true);
assert.equal(payload.chat_template_kwargs.preserve_thinking, true);

const executorPayload = applyQwen36ProfileToPayload({ model: "qwen" }, executor) as Record<string, any>;
assert.equal(executorPayload.temperature, 0.2);
assert.equal(executorPayload.top_p, 0.9);
assert.equal(executorPayload.chat_template_kwargs.enable_thinking, false);
assert.equal(executorPayload.chat_template_kwargs.preserve_thinking, true);

assert.equal(isPlannerToolAllowed("read"), true);
assert.equal(isPlannerToolAllowed("grep"), true);
assert.equal(isPlannerToolAllowed("read_marker"), true);
assert.equal(isPlannerToolAllowed("write_marker"), false);
assert.equal(isPlannerToolAllowed("write"), false);
assert.equal(isPlannerToolAllowed("edit"), false);
assert.equal(isPlannerToolAllowed("apply_diff"), false);
assert.equal(isPlannerToolAllowed("lsp_symbols"), true);
assert.equal(isPlannerToolAllowed("semantic_search"), true);
assert.equal(EXECUTOR_TOOL_NAMES.includes("apply_diff"), true);
assert.equal(PLANNER_TOOL_NAMES.includes("apply_diff"), false);
assert.equal(EXECUTOR_TOOL_NAMES.includes("lsp_symbols"), true);
assert.equal(PLANNER_TOOL_NAMES.includes("lsp_symbols"), true);
assert.equal(EXECUTOR_TOOL_NAMES.includes("semantic_search"), true);
assert.equal(PLANNER_TOOL_NAMES.includes("semantic_search"), true);
assert.equal(EXECUTOR_TOOL_NAMES.includes("web_fetch"), true);
assert.equal(PLANNER_TOOL_NAMES.includes("web_fetch"), true);
assert.equal(EXECUTOR_TOOL_NAMES.includes("web_search"), true);
assert.equal(PLANNER_TOOL_NAMES.includes("web_search"), true);

assert.equal(isReadOnlyBash("rg planner scripts"), true);
assert.equal(isReadOnlyBash("git status --short"), true);
assert.equal(isReadOnlyBash("sed -n '1,20p' package.json"), true);
assert.equal(isReadOnlyBash("rm package.json"), false);
assert.equal(isReadOnlyBash("git commit -m nope"), false);
assert.equal(isReadOnlyBash("echo hi > file.txt"), false);

const model = createLocalQwen36Model("Qwen3.6-35B-A3B-IQ4_XS-4.15bpw.gguf", "http://127.0.0.1:8080/v1");
assert.equal(model.provider, "local-llama-cpp");
assert.equal(model.api, "openai-completions");
assert.equal(model.reasoning, true);
assert.equal(model.maxTokens, 0);
assert.equal(model.compat?.thinkingFormat, "qwen-chat-template");
assert.equal(model.compat?.supportsDeveloperRole, false);

function assertGuidedPrompt(prompt: string, profileText: string): void {
	assert.equal(prompt.includes(profileText), true);
	assert.match(prompt, /<qwen36_agent_guidance>/);
	assert.match(prompt, /Search results and snippets are navigation evidence, not an editing substrate\./);
	assert.match(prompt, /Before editing existing code, read the defining symbol or focused region with read_file\./);
	assert.match(prompt, /Planner should gather repository\/file structure, relevant files and symbols, architectural relationships, known failures and verification state\./);
	assert.match(prompt, /Executor should gather exact implementation regions, directly related callers\/callees\/types\/tests, recent diagnostics, current file revisions before editing\./);
	assert.match(prompt, /Treat apply_diff receipts as write verification only\./);
	assert.match(prompt, /<qwen36_memory>/);
	assert.equal(prompt.indexOf(profileText) < prompt.indexOf("<qwen36_agent_guidance>"), true);
	assert.equal(prompt.indexOf("<qwen36_agent_guidance>") < prompt.indexOf("<qwen36_memory>"), true);
	assert.equal(prompt.match(/<qwen36_agent_guidance>/g)?.length, 1);
	assert.equal(prompt.match(/<qwen36_memory>/g)?.length, 1);
}

assertGuidedPrompt(
	buildQwen36SystemPromptWithMemory(planner.systemPrompt, "inspect the retry implementation"),
	planner.systemPrompt,
);
assertGuidedPrompt(
	buildQwen36SystemPromptWithMemory(executor.systemPrompt, "edit the retry implementation"),
	executor.systemPrompt,
);

console.log("profile-unit: ok");
