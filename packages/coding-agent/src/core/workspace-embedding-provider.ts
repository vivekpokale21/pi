import type { WorkspaceSemanticEmbeddingProvider } from "./workspace-semantic-index.ts";

export interface OpenAICompatibleWorkspaceEmbeddingProviderOptions {
	baseUrl: string;
	model: string;
	apiKey?: string;
	resolveBaseUrl?: (signal?: AbortSignal) => Promise<string>;
}

interface OpenAICompatibleEmbeddingData {
	embedding: number[];
}

function isEmbeddingData(value: unknown): value is OpenAICompatibleEmbeddingData {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		Array.isArray(record.embedding) &&
		record.embedding.length > 0 &&
		record.embedding.every((entry) => typeof entry === "number" && Number.isFinite(entry))
	);
}

function parseEmbeddingResponse(value: unknown, expectedCount: number): number[][] {
	if (!value || typeof value !== "object") {
		throw new Error("embedding response was not an object");
	}
	const data = (value as Record<string, unknown>).data;
	if (!Array.isArray(data) || data.length !== expectedCount || !data.every(isEmbeddingData)) {
		throw new Error("embedding response returned an invalid embedding batch");
	}
	return data.map((entry) => entry.embedding);
}

export function createOpenAICompatibleWorkspaceEmbeddingProvider(
	options: OpenAICompatibleWorkspaceEmbeddingProviderOptions,
): WorkspaceSemanticEmbeddingProvider {
	const baseUrl = options.baseUrl.replace(/\/+$/u, "");
	return {
		id: options.model,
		embed: async (texts, signal) => {
			const resolvedBaseUrl = options.resolveBaseUrl ? await options.resolveBaseUrl(signal) : baseUrl;
			const headers = new Headers({ "content-type": "application/json" });
			if (options.apiKey) headers.set("authorization", `Bearer ${options.apiKey}`);
			const response = await fetch(`${resolvedBaseUrl.replace(/\/+$/u, "")}/embeddings`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					model: options.model,
					input: texts,
				}),
				signal,
			});
			if (!response.ok) {
				throw new Error(`embedding endpoint returned HTTP ${response.status}`);
			}
			return parseEmbeddingResponse(await response.json(), texts.length);
		},
	};
}
