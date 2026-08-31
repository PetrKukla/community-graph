import { describe, expect, test } from "bun:test";
import {
  executePipeline,
  PipelineStageError,
  type PipelineResult,
  type PipelineStageName,
  type PipelineStages,
} from "../../src/jobs/pipelineStage";

const clusterResult = {
  processedMessageCount: 5,
  newDiscussionCount: 2,
  extendedDiscussionCount: 0,
  skippedOpenBlockMessageCount: 1,
};
const enrichResult = {
  enrichedDiscussionCount: 2,
  splitDiscussionCount: 0,
  createdSegmentCount: 0,
  skippedEmptyCount: 0,
  failedCount: 0,
  errors: [],
};
const graphWriteResult = {
  writtenDiscussionCount: 2,
  skippedNoEnrichmentCount: 0,
  failedCount: 0,
  errors: [],
};

function stages(overrides: Partial<PipelineStages> = {}): PipelineStages {
  return {
    cluster: async () => clusterResult,
    enrich: async () => enrichResult,
    graphWrite: async () => graphWriteResult,
    ...overrides,
  };
}

describe("executePipeline", () => {
  test("runs all three stages and fills every result block", async () => {
    const seen: PipelineStageName[] = [];
    const result = await executePipeline("c1", stages(), {}, { ingest: undefined }, {
      onStageComplete: (stage) => seen.push(stage),
    });

    expect(seen).toEqual(["cluster", "enrich", "graph_write"]);
    expect(result).toEqual({
      ingest: undefined,
      cluster: clusterResult,
      enrich: enrichResult,
      graphWrite: graphWriteResult,
    });
  });

  test("skipGraphWrite stops after enrich", async () => {
    const seen: PipelineStageName[] = [];
    const result = await executePipeline("c1", stages(), { skipGraphWrite: true }, {}, {
      onStageComplete: (stage) => seen.push(stage),
    });
    expect(seen).toEqual(["cluster", "enrich"]);
    expect(result.graphWrite).toBeUndefined();
  });

  test("passes option caps through to the stages", async () => {
    const calls: Record<string, unknown> = {};
    await executePipeline(
      "c1",
      stages({
        cluster: async (_id, o) => {
          calls.cluster = o;
          return clusterResult;
        },
        enrich: async (_id, o) => {
          calls.enrich = o;
          return enrichResult;
        },
        graphWrite: async (_id, o) => {
          calls.graphWrite = o;
          return graphWriteResult;
        },
      }),
      { maxMessages: 100, maxDiscussions: 10 },
    );
    expect(calls.cluster).toEqual({ maxMessages: 100 });
    expect(calls.enrich).toEqual({ maxDiscussions: 10 });
    expect(calls.graphWrite).toEqual({ maxDiscussions: 10 });
  });

  test("a failing stage throws PipelineStageError, earlier stages already reported", async () => {
    const partials: PipelineResult[] = [];
    const run = executePipeline(
      "c1",
      stages({
        enrich: async () => {
          throw new Error("LLM key missing");
        },
      }),
      {},
      { ingest: undefined },
      { onStageComplete: (_s, r) => partials.push(r) },
    );

    await expect(run).rejects.toThrow(PipelineStageError);
    await run.catch((err: unknown) => {
      expect(err).toBeInstanceOf(PipelineStageError);
      expect((err as PipelineStageError).stage).toBe("enrich");
      expect((err as PipelineStageError).message).toBe("enrich: LLM key missing");
    });
    // cluster partial was persisted before enrich blew up
    expect(partials).toHaveLength(1);
    expect(partials[0]!.cluster).toEqual(clusterResult);
    expect(partials[0]!.enrich).toBeUndefined();
  });
});
