export interface EmbeddingProvider {
  embed(texts: string[]): Promise<Float32Array[]>;
}
