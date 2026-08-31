import type { LlmCall, PipelineFunnel, StatsTotals } from '../../types';

/** Latest cheap aggregate pushed by `stats.tick` - lets Overview update every couple of seconds. */
class LiveTick {
  funnel = $state<PipelineFunnel | null>(null);
  totals = $state<StatsTotals | null>(null);
}
export const liveTick = new LiveTick();

const MAX_LIVE_CALLS = 100;

/** Rolling window of the most recent LLM calls, newest first - the AI view's live stream. */
class LiveLlmCalls {
  items = $state<LlmCall[]>([]);

  push(call: LlmCall): void {
    this.items = [call, ...this.items].slice(0, MAX_LIVE_CALLS);
  }
}
export const liveLlmCalls = new LiveLlmCalls();
