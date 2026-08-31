import {
  pipeline,
  type FeatureExtractionPipeline
} from '@huggingface/transformers';
import type { EmbeddingProvider } from '../../core/ports/EmbeddingProvider';
import { config } from '../../config/config';

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = pipeline(
      'feature-extraction',
      config.embedding.model
    ) as Promise<FeatureExtractionPipeline>;
  }
  return extractorPromise;
}

export class LocalTransformersEmbeddingAdapter implements EmbeddingProvider {
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await getExtractor();
    // e5 modely očekávají prefix "query: "/"passage: " - pro symetrické porovnávání zpráv mezi sebou používáme "query: " pro vše
    const prefixed = texts.map((t) => `query: ${t}`);
    const output = await extractor(prefixed, {
      pooling: 'mean',
      normalize: true
    });
    const data = output.tolist() as number[][];
    return data.map((row) => new Float32Array(row));
  }
}
