import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureExtractor } from "@/infra/embedding/embedder";
import { SEARCH_DIMENSIONS } from "@/infra/embedding/embedder";

const mocks = vi.hoisted(() => ({
  env: { cacheDir: "" },
  pipeline: vi.fn(),
}));

vi.mock("@xenova/transformers", () => ({
  env: mocks.env,
  pipeline: mocks.pipeline,
}));

import {
  DEFAULT_EMBEDDING_MODEL,
  TransformersEmbedder,
} from "@/infra/embedding/embedder";

const EXTRACTOR: FeatureExtractor = vi.fn(async (text) => {
  const data = new Float32Array(SEARCH_DIMENSIONS).fill(text.length);
  return { data };
});

describe("embedder.util", () => {
  const originalModel = process.env.CYRNEL_EMBEDDING_MODEL;
  const originalDataDir = process.env.CYRNEL_DATA_DIR;
  let tempDataDir = "";

  beforeEach(() => {
    delete process.env.CYRNEL_EMBEDDING_MODEL;
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrnel-data-"));
    process.env.CYRNEL_DATA_DIR = tempDataDir;
    mocks.pipeline.mockReset();
    mocks.pipeline.mockResolvedValue(EXTRACTOR);
    mocks.env.cacheDir = "";
  });

  afterEach(() => {
    if (tempDataDir) {
      fs.rmSync(tempDataDir, { recursive: true, force: true });
      tempDataDir = "";
    }
    if (originalModel === undefined) {
      delete process.env.CYRNEL_EMBEDDING_MODEL;
    } else {
      process.env.CYRNEL_EMBEDDING_MODEL = originalModel;
    }
    if (originalDataDir === undefined) {
      delete process.env.CYRNEL_DATA_DIR;
    } else {
      process.env.CYRNEL_DATA_DIR = originalDataDir;
    }
  });

  describe("constructor", () => {
    it("defaults to DEFAULT_EMBEDDING_MODEL when the env var is unset", () => {
      const embedder = new TransformersEmbedder();
      expect(embedder.modelId).toBe(DEFAULT_EMBEDDING_MODEL);
    });

    it("uses CYRNEL_EMBEDDING_MODEL when set", () => {
      process.env.CYRNEL_EMBEDDING_MODEL = "custom/model";
      const embedder = new TransformersEmbedder();
      expect(embedder.modelId).toBe("custom/model");
    });

    it("exposes the expected embedding dimensions", () => {
      expect(new TransformersEmbedder().dimensions).toBe(384);
    });

    it("is unavailable until init resolves", () => {
      expect(new TransformersEmbedder().available).toBe(false);
    });
  });

  describe("init", () => {
    it("loads the pipeline with the configured model and quantized flag", async () => {
      const embedder = new TransformersEmbedder();
      await embedder.init();

      expect(mocks.pipeline).toHaveBeenCalledWith(
        "feature-extraction",
        DEFAULT_EMBEDDING_MODEL,
        {
          quantized: true,
        },
      );
      expect(embedder.available).toBe(true);
    });

    it("points the transformers cache at CYRNEL_DATA_DIR/.cache/transformers", async () => {
      const embedder = new TransformersEmbedder();
      await embedder.init();

      expect(mocks.env.cacheDir).toBe(
        path.join(tempDataDir, ".cache", "transformers"),
      );
    });

    it("does not retry init after a failed pipeline load", async () => {
      mocks.pipeline.mockRejectedValueOnce(new Error("no network"));
      const embedder = new TransformersEmbedder();

      await embedder.init();
      await embedder.init();

      expect(mocks.pipeline).toHaveBeenCalledTimes(1);
      expect(embedder.available).toBe(false);
    });

    it("stays unavailable when cache directory creation fails", async () => {
      const badDir = path.join(tempDataDir, "file.txt");
      fs.writeFileSync(badDir, "im a file");
      process.env.CYRNEL_DATA_DIR = badDir;

      const embedder = new TransformersEmbedder();
      await expect(embedder.init()).resolves.toBeUndefined();
      expect(embedder.available).toBe(false);
      expect(mocks.pipeline).not.toHaveBeenCalled();
    });

    it("stays permanently unavailable when the model fails to load", async () => {
      mocks.pipeline.mockRejectedValue(new Error("no network"));
      const embedder = new TransformersEmbedder();
      await embedder.init();

      expect(embedder.available).toBe(false);
      await expect(embedder.embed("hello")).rejects.toThrow(
        "Embedding model is not loaded",
      );
    });

    it("does not reload when init is called while already loaded", async () => {
      const embedder = new TransformersEmbedder();
      await embedder.init();
      await embedder.init();

      expect(mocks.pipeline).toHaveBeenCalledTimes(1);
      expect(embedder.available).toBe(true);
    });
  });

  describe("embed", () => {
    it("returns the extractor output for the given text", async () => {
      const embedder = new TransformersEmbedder();
      await embedder.init();

      const vector = await embedder.embed("send email");

      expect(EXTRACTOR).toHaveBeenCalledWith("send email", {
        pooling: "mean",
        normalize: true,
      });
      expect(vector).toEqual(new Float32Array(SEARCH_DIMENSIONS).fill(10));
    });

    it("rejects vectors with the wrong output dimension", async () => {
      const wrongShapeExtractor: FeatureExtractor = vi.fn(async () => ({
        data: new Float32Array(SEARCH_DIMENSIONS - 1),
      }));
      mocks.pipeline.mockResolvedValueOnce(wrongShapeExtractor);

      const embedder = new TransformersEmbedder();
      await embedder.init();

      await expect(embedder.embed("hello")).rejects.toThrow(
        /does not match expected 384/,
      );
    });

    it("throws when called before init", async () => {
      const embedder = new TransformersEmbedder();
      await expect(embedder.embed("hello")).rejects.toThrow(
        "Embedding model is not loaded",
      );
    });
  });
});
