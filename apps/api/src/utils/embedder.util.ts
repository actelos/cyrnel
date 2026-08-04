import { mkdirSync } from "node:fs";
import path from "node:path";

import { SEARCH_DIMENSIONS } from "@/db/search-schema";
import { logger } from "@/logger";

export const DEFAULT_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";

export interface Embedder {
  readonly modelId: string;
  readonly dimensions: number;
  readonly available: boolean;
  init(): Promise<void>;
  embed(text: string): Promise<Float32Array>;
}

export type FeatureExtractor = (
  text: string,
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array }>;

type TransformersModule = typeof import("@xenova/transformers");

/**
 * Local embedding model backed by @xenova/transformers. The model is loaded
 * once at startup; if loading fails (e.g. no network, cache miss) the
 * embedder stays unavailable for the remainder of the process lifetime and
 * search degrades to FTS5-only; it is never retried per search call.
 */
export class TransformersEmbedder implements Embedder {
  readonly dimensions = SEARCH_DIMENSIONS;

  private extractor: FeatureExtractor | null = null;
  private initPromise: Promise<void> | null = null;
  private initAttempted = false;
  private loaded = false;

  constructor(
    readonly modelId: string = process.env.CYRNEL_EMBEDDING_MODEL ??
      DEFAULT_EMBEDDING_MODEL,
  ) {}

  get available(): boolean {
    return this.loaded;
  }

  async init(): Promise<void> {
    if (this.loaded || this.initAttempted) return this.initPromise ?? undefined;

    this.initAttempted = true;
    this.initPromise = (async () => {
      const dataDir = process.env.CYRNEL_DATA_DIR ?? ".";
      const cacheDir = path.join(dataDir, ".cache", "transformers");

      try {
        mkdirSync(cacheDir, { recursive: true });

        const { env, pipeline } = (await import(
          "@xenova/transformers"
        )) as TransformersModule;
        env.cacheDir = cacheDir;

        const loaded = await pipeline("feature-extraction", this.modelId, {
          quantized: true,
        });
        this.extractor = loaded as unknown as FeatureExtractor;
        this.loaded = true;
        logger.info(
          { modelId: this.modelId, cacheDir },
          "Embedding model loaded",
        );
      } catch (err) {
        // Permanent fallback: FTS5-only mode for this process lifetime.
        logger.warn(
          { err, modelId: this.modelId },
          "Embedding model failed to load; running in FTS5-only search mode",
        );
        this.loaded = false;
        this.extractor = null;
      }
    })();

    await this.initPromise;
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.loaded || !this.extractor) {
      throw new Error("Embedding model is not loaded");
    }
    const output = await this.extractor(text, {
      pooling: "mean",
      normalize: true,
    });
    if (output.data.length !== SEARCH_DIMENSIONS) {
      throw new Error(
        `Embedding model output dimension ${output.data.length} does not match expected ${SEARCH_DIMENSIONS}`,
      );
    }
    return output.data;
  }
}
