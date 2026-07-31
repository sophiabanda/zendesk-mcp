/**
 * Shared embedding model for the RAG store — must match whatever produced
 * the `vector` column in the coworker's LanceDB export, or query/ingest
 * vectors land in different spaces and similarity search silently breaks:
 *   model: Xenova/all-MiniLM-L6-v2 (ONNX port of sentence-transformers/all-MiniLM-L6-v2)
 *   library: @huggingface/transformers 3.8.1, FP32, mean pooling, L2-normalized, 384 dims
 */

let embedderPromise: Promise<import("@huggingface/transformers").FeatureExtractionPipeline> | undefined;

async function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    })();
  }
  return embedderPromise;
}

export async function embedText(text: string): Promise<number[]> {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}
