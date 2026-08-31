import type { EmbeddingProvider } from '../../core/ports/EmbeddingProvider';
import { LocalTransformersEmbeddingAdapter } from './LocalTransformersEmbeddingAdapter';

let cached: EmbeddingProvider | null = null;

/** The local in-process embedding provider, constructed once per process (the ONNX model is cached inside). */
export function getEmbeddingProvider(): EmbeddingProvider {
  cached ??= new LocalTransformersEmbeddingAdapter();
  return cached;
}
