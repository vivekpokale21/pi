#!/usr/bin/env python3

import argparse
import os
from typing import Any


os.environ["CUDA_VISIBLE_DEVICES"] = os.environ.get("CUDA_VISIBLE_DEVICES", "")


def parse_args() -> argparse.Namespace:
	parser = argparse.ArgumentParser(
		description="Serve CodeRankEmbed through a small OpenAI-compatible CPU embeddings API.",
	)
	parser.add_argument("--host", default="127.0.0.1")
	parser.add_argument("--port", type=int, default=8129)
	parser.add_argument("--model", default="nomic-ai/CodeRankEmbed")
	parser.add_argument("--batch-size", type=int, default=1)
	parser.add_argument("--max-seq-length", type=int)
	return parser.parse_args()


def main() -> None:
	args = parse_args()
	import torch
	import uvicorn
	from fastapi import FastAPI, HTTPException
	from pydantic import BaseModel
	from sentence_transformers import SentenceTransformer

	class EmbeddingsRequest(BaseModel):
		model: str
		input: str | list[str]

	torch.set_num_threads(max(1, os.cpu_count() or 1))
	model = SentenceTransformer(args.model, trust_remote_code=True, device="cpu")
	if args.max_seq_length is not None:
		model.max_seq_length = max(1, args.max_seq_length)
	app = FastAPI()

	@app.get("/v1/models")
	def models() -> dict[str, Any]:
		return {
			"object": "list",
			"data": [
				{
					"id": args.model,
					"object": "model",
					"owned_by": "local",
				}
			],
		}

	@app.post("/v1/embeddings")
	def embeddings(request: EmbeddingsRequest) -> dict[str, Any]:
		if request.model != args.model:
			raise HTTPException(status_code=404, detail=f"model not served: {request.model}")
		texts = [request.input] if isinstance(request.input, str) else request.input
		if not texts:
			return {"object": "list", "model": args.model, "data": []}
		vectors = model.encode(
			texts,
			batch_size=max(1, args.batch_size),
			convert_to_numpy=True,
			normalize_embeddings=True,
		)
		return {
			"object": "list",
			"model": args.model,
			"data": [
				{
					"object": "embedding",
					"index": index,
					"embedding": vector.astype(float).tolist(),
				}
				for index, vector in enumerate(vectors)
			],
		}

	uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
	main()
