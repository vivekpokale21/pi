import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("pi-web-access package integration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-web-access-package-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads a pi-web-access shaped package through the native package extension path", async () => {
		const packageDir = join(tempDir, "pi-web-access-fixture");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "pi-web-access",
				type: "module",
				pi: {
					extensions: ["./index.ts"],
				},
			}),
		);
		writeFileSync(
			join(packageDir, "index.ts"),
			[
				"import { Type } from 'typebox';",
				"import { StringEnum } from '@earendil-works/pi-ai/compat';",
				"import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';",
				"import { Text } from '@earendil-works/pi-tui';",
				"export default function webAccess(pi: ExtensionAPI) {",
				"  pi.registerTool({",
				"    name: 'web_search',",
				"    label: 'Web search',",
				"    description: 'Search the web through the package extension.',",
				"    promptSnippet: 'Search the web through the package extension.',",
				"    parameters: Type.Object({ query: Type.String(), provider: Type.Optional(StringEnum(['duckduckgo'])) }),",
				"    execute: async (_toolCallId, params) => ({",
				"      content: [{ type: 'text', text: 'web:' + params.query }],",
				"      details: { query: params.query },",
				"    }),",
				"    renderCall: () => new Text('web_search', 0, 0),",
				"  });",
				"}",
			].join("\n"),
		);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.setProjectPackages([packageDir]);
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(tempDir),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});
		await session.bindExtensions({});

		expect(services.diagnostics).toEqual([]);
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		expect(session.getActiveToolNames()).toContain("web_search");
		expect(session.systemPrompt).toContain("- web_search: Search the web through the package extension.");
		expect(session.getAllTools().find((tool) => tool.name === "web_search")?.sourceInfo).toMatchObject({
			source: packageDir,
			scope: "project",
			origin: "package",
			baseDir: packageDir,
		});
		const webSearch = session.agent.state.tools.find((tool) => tool.name === "web_search");
		const result = await webSearch?.execute("web", { query: "native package loading" });
		expect(result?.details).toEqual({ query: "native package loading" });

		session.dispose();
		await services.dispose?.();
	});

	it("loads a pi-web-access shaped npm package from the managed project install path", async () => {
		const packageDir = join(tempDir, ".pi", "npm", "node_modules", "pi-web-access");
		const dependencyDir = join(packageDir, "node_modules", "web-runtime-fixture");
		mkdirSync(dependencyDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "pi-web-access",
				version: "0.21.0",
				type: "module",
				pi: {
					extensions: ["./index.ts"],
				},
			}),
		);
		writeFileSync(
			join(dependencyDir, "package.json"),
			JSON.stringify({
				name: "web-runtime-fixture",
				version: "1.0.0",
				type: "module",
				main: "./index.js",
			}),
		);
		writeFileSync(
			join(dependencyDir, "index.js"),
			"export function makeWebResult(query) { return 'managed-web:' + query; }\n",
		);
		writeFileSync(
			join(packageDir, "index.ts"),
			[
				"import { Type } from 'typebox';",
				"import { StringEnum } from '@earendil-works/pi-ai/compat';",
				"import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';",
				"import { Text } from '@earendil-works/pi-tui';",
				"import { makeWebResult } from 'web-runtime-fixture';",
				"export default function webAccess(pi: ExtensionAPI) {",
				"  pi.registerTool({",
				"    name: 'web_search',",
				"    label: 'Web search',",
				"    description: 'Search the web through a managed package extension.',",
				"    promptSnippet: 'Search the web through a managed package extension.',",
				"    parameters: Type.Object({ query: Type.String(), provider: Type.Optional(StringEnum(['duckduckgo'])) }),",
				"    execute: async (_toolCallId, params) => ({",
				"      content: [{ type: 'text', text: makeWebResult(params.query) }],",
				"      details: { query: params.query },",
				"    }),",
				"    renderCall: () => new Text('web_search', 0, 0),",
				"  });",
				"}",
			].join("\n"),
		);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.setProjectPackages(["npm:pi-web-access@0.21.0"]);
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(tempDir),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});
		await session.bindExtensions({});

		expect(services.diagnostics).toEqual([]);
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		expect(session.getActiveToolNames()).toContain("web_search");
		expect(session.systemPrompt).toContain("- web_search: Search the web through a managed package extension.");
		expect(session.getAllTools().find((tool) => tool.name === "web_search")?.sourceInfo).toMatchObject({
			source: "npm:pi-web-access@0.21.0",
			scope: "project",
			origin: "package",
			baseDir: packageDir,
		});
		const webSearch = session.agent.state.tools.find((tool) => tool.name === "web_search");
		const result = await webSearch?.execute("web", { query: "normal package path" });
		expect(result?.content).toEqual([{ type: "text", text: "managed-web:normal package path" }]);

		session.dispose();
		await services.dispose?.();
	});

	it("reports configured pi-web-access as unavailable when package extension resources are disabled", async () => {
		const packageDir = join(tempDir, ".pi", "npm", "node_modules", "pi-web-access");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "pi-web-access",
				version: "0.21.0",
				type: "module",
				pi: {
					extensions: ["./index.ts"],
				},
			}),
		);
		writeFileSync(
			join(packageDir, "index.ts"),
			[
				"import { Type } from 'typebox';",
				"import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';",
				"export default function webAccess(pi: ExtensionAPI) {",
				"  pi.registerTool({",
				"    name: 'web_search',",
				"    label: 'Web search',",
				"    description: 'Search the web through a managed package extension.',",
				"    promptSnippet: 'Search the web through a managed package extension.',",
				"    parameters: Type.Object({ query: Type.String() }),",
				"    execute: async () => ({ content: [{ type: 'text', text: 'disabled' }] }),",
				"  });",
				"}",
			].join("\n"),
		);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.setProjectPackages([{ source: "npm:pi-web-access@0.21.0", extensions: [] }]);
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(tempDir),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});
		await session.bindExtensions({});

		expect(session.getActiveToolNames()).not.toContain("web_search");
		expect(session.systemPrompt).not.toContain("web_search");
		expect(services.diagnostics).toContainEqual({
			type: "info",
			message: "Web access is configured through pi-web-access, but web tools are unavailable or disabled.",
		});

		session.dispose();
		await services.dispose?.();
	});

	it("exposes the effective agent dir to package modules during extension initialization", async () => {
		const packageDir = join(tempDir, ".pi", "npm", "node_modules", "pi-web-access");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "pi-web-access",
				version: "0.21.0",
				type: "module",
				pi: {
					extensions: ["./index.ts"],
				},
			}),
		);
		writeFileSync(
			join(packageDir, "index.ts"),
			[
				"import { Type } from 'typebox';",
				"import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';",
				"const capturedAgentDir = process.env.PI_CODING_AGENT_DIR;",
				"export default function webAccess(pi: ExtensionAPI) {",
				"  pi.registerTool({",
				"    name: 'web_search',",
				"    label: 'Web search',",
				"    description: 'Search the web through the configured agent dir.',",
				"    promptSnippet: 'Search the web through the configured agent dir.',",
				"    parameters: Type.Object({ query: Type.String() }),",
				"    execute: async () => ({",
				"      content: [{ type: 'text', text: capturedAgentDir ?? '<missing>' }],",
				"      details: { capturedAgentDir },",
				"    }),",
				"  });",
				"}",
			].join("\n"),
		);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.setProjectPackages(["npm:pi-web-access@0.21.0"]);
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(tempDir),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});
		await session.bindExtensions({});

		const webSearch = session.agent.state.tools.find((tool) => tool.name === "web_search");
		const result = await webSearch?.execute("web", { query: "agent dir" });
		expect(result?.details).toEqual({ capturedAgentDir: agentDir });

		session.dispose();
		await services.dispose?.();
	});
});
