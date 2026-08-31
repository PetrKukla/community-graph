import type { ClusterableMessage } from './types';

export interface TimeBlock {
  messages: ClusterableMessage[];
  startAt: string;
  endAt: string;
  /** false for the trailing block when we can't yet be sure no more messages will arrive within the silence gap */
  closed: boolean;
}

/**
 * Splits a chronologically-sorted stream of messages into blocks separated by silence
 * gaps > silenceGapMinutes. The last block is marked closed only if the newest message
 * observed anywhere in this scan window is already more than the silence gap past the
 * block's last message - otherwise a later batch could still extend it.
 */
export function splitIntoTimeBlocks(
  messages: ClusterableMessage[],
  silenceGapMinutes: number,
  maxTimestampInScanWindow: string
): TimeBlock[] {
  if (messages.length === 0) return [];

  const gapMs = silenceGapMinutes * 60_000;
  const blocks: TimeBlock[] = [];
  let current: ClusterableMessage[] = [messages[0]!];

  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1]!;
    const msg = messages[i]!;
    const gap =
      new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime();
    if (gap > gapMs) {
      blocks.push(finalize(current));
      current = [msg];
    } else {
      current.push(msg);
    }
  }
  blocks.push(finalize(current));

  const maxTs = new Date(maxTimestampInScanWindow).getTime();
  const last = blocks[blocks.length - 1]!;
  const lastMsgTs = new Date(last.endAt).getTime();
  last.closed = maxTs - lastMsgTs > gapMs;

  return blocks;

  function finalize(msgs: ClusterableMessage[]): TimeBlock {
    return {
      messages: msgs,
      startAt: msgs[0]!.createdAt,
      endAt: msgs[msgs.length - 1]!.createdAt,
      closed: true // every block except the last is closed by construction (we saw the gap after it)
    };
  }
}
