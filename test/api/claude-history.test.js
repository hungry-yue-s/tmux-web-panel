import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeConversation } from '../../server/api/claude-usage.js';

it('counts native Claude API history by model without duplicating streaming blocks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-history-'));
  const path = join(root, 'session-one.jsonl');
  const assistant = (usage, content = []) => ({
    type: 'assistant', sessionId: 'session-one', cwd: '/tmp/project', timestamp: '2026-10-14T10:01:00Z',
    message: { id: 'message-one', model: 'glm-5.3', usage, content },
  });
  const tool = { type: 'tool_use', id: 'tool-one', name: 'Read' };
  try {
    await writeFile(path, [
      JSON.stringify({ type: 'user', uuid: 'user-one', timestamp: '2026-10-14T10:00:00Z' }),
      JSON.stringify(assistant({ input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 20 }, [tool])),
      'malformed line', 'null',
      JSON.stringify(assistant({ input_tokens: 100, output_tokens: 15, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 }, [tool])),
      JSON.stringify({ type: 'assistant', timestamp: '2026-10-14T10:02:00Z', message: {
        id: 'message-two', model: 'other-model', usage: { input_tokens: 40, output_tokens: 10 },
      } }),
    ].join('\n'));
    const session = await readClaudeConversation(path);
    expect(session).toMatchObject({
      session_id: 'session-one', project_path: '/tmp/project', user_message_count: 1, assistant_message_count: 2,
      input_tokens: 170, output_tokens: 25, tool_counts: { Read: 1 },
      start_time: '2026-10-14T10:00:00.000Z', updated_at: '2026-10-14T10:02:00.000Z',
      modelUsage: {
        'glm-5.3': { inputTokens: 100, outputTokens: 15, cacheReadInputTokens: 20, cacheCreationInputTokens: 10 },
        'other-model': { inputTokens: 40, outputTokens: 10 },
      },
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
