import { describe, expect, test } from 'bun:test';
import {
  buildDiscussionGraphPayload,
  type DiscussionWriteInput
} from '../../src/core/graphBuilder/discussionWriter';

function input(
  overrides: Partial<DiscussionWriteInput['channel']> = {}
): DiscussionWriteInput {
  return {
    discussion: {
      id: 'd1',
      channelId: 'c1',
      blockStartAt: '2026-08-01T00:00:00.000Z',
      blockEndAt: '2026-08-01T01:00:00.000Z',
      continuationOfDiscussionId: null,
      continuationReason: null
    },
    enrichment: {
      title: 't',
      summary: 's',
      topics: ['Linux'],
      entities: null,
      sentiment: 'neutral',
      sentimentScore: 0,
      language: 'cs',
      discussionType: 'discussion',
      resolved: null,
      embedding: null
    },
    channel: {
      id: 'c1',
      name: 'obecna',
      guildId: 'g1',
      guildName: 'Moje komunita',
      ...overrides
    },
    participants: []
  };
}

describe('buildDiscussionGraphPayload — Guild', () => {
  test('carries guildName through to the payload channel', () => {
    const payload = buildDiscussionGraphPayload(input(), 384);
    expect(payload.channel).toEqual({
      id: 'c1',
      name: 'obecna',
      guildId: 'g1',
      guildName: 'Moje komunita'
    });
  });

  test('keeps guildName null when the channel has no guild', () => {
    const payload = buildDiscussionGraphPayload(
      input({ guildId: null, guildName: null }),
      384
    );
    expect(payload.channel.guildId).toBeNull();
    expect(payload.channel.guildName).toBeNull();
  });
});
