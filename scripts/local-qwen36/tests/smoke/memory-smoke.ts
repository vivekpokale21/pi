#!/usr/bin/env -S node --import tsx
import assert from "node:assert/strict";
import { getQwen36Profile } from "../../profiles.ts";
import { buildQwen36ProfileMemoryBlock, buildQwen36SystemPromptWithMemory } from "../../profile-memory.ts";

const memoryBlock = buildQwen36ProfileMemoryBlock("continue qwen memory compaction");
assert.match(memoryBlock, /<qwen36_memory>/);
assert.match(memoryBlock, /<working>/);
assert.match(memoryBlock, /<persistent>/);
assert.match(memoryBlock, /previous verifier failure: preserve apply_diff gating/);

const plannerPrompt = buildQwen36SystemPromptWithMemory(getQwen36Profile("planner").systemPrompt);
const executorPrompt = buildQwen36SystemPromptWithMemory(getQwen36Profile("executor").systemPrompt);
assert.match(plannerPrompt, /<qwen36_memory>/);
assert.match(executorPrompt, /<qwen36_memory>/);

console.log("memory-smoke: ok");
