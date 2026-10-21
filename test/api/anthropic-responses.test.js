import { describe, expect, it } from 'vitest';
import { requestToResponses, responseToAnthropic, responsesToAnthropicStream } from '../../server/agent-providers/anthropic-responses.js';

const message = (content) => ({ role: 'user', content });
const request = (extra = {}) => ({ model: 'gpt-5', max_tokens: 100, messages: [message('Hello')], ...extra });
const response = (extra = {}) => ({ id: 'resp_test', model: 'gpt-5', status: 'completed',
  output: [{ type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Hello' }] }],
  usage: { input_tokens: 100, output_tokens: 12 }, ...extra });
const event = (type, data = {}, newline = '\n') => `event: ${type}${newline}data: ${JSON.stringify({ type, ...data })}${newline}${newline}`;

async function collect(input, width = 37) {
  const buffer = Buffer.from(input);
  async function* source() { for (let i = 0; i < buffer.length; i += width) yield buffer.subarray(i, i + width); }
  let output = '';
  for await (const chunk of responsesToAnthropicStream(source(), 'claude-model')) output += chunk;
  return output.trim().split('\n\n').filter(Boolean).map((block) => JSON.parse(block.split('\ndata: ')[1]));
}

describe('Anthropic to Responses requests', () => {
  it('converts system/text, removes transient billing headers and leaves the original untouched', () => {
    const body = request({ max_tokens: 1, system: [
      { type: 'text', text: 'x-anthropic-billing-header: transient\r\n\r\nStable prompt', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Second part' },
    ], stop_sequences: ['stop'], metadata: { user_id: 'private-id' } });
    const original = structuredClone(body);
    expect(requestToResponses(body)).toEqual({ model: 'gpt-5', max_output_tokens: 16, instructions: 'Stable prompt\n\nSecond part',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
      store: false, include: ['reasoning.encrypted_content'] });
    expect(body).toEqual(original);
    expect(requestToResponses(request({ system: 'Keep\nx-anthropic-billing-header: literal' })).instructions)
      .toBe('Keep\nx-anthropic-billing-header: literal');
  });

  it('lifts tool calls/results while preserving message and parallel-call order', () => {
    const converted = requestToResponses(request({ messages: [
      message('Find files'),
      { role: 'assistant', content: [{ type: 'text', text: 'Checking' },
        { type: 'tool_use', id: 'call_a', name: 'Read', input: { file_path: '/a' } },
        { type: 'tool_use', id: 'call_b', name: 'Read', input: { file_path: '/b' } }] },
      message([{ type: 'tool_result', tool_use_id: 'call_b', content: 'B' },
        { type: 'tool_result', tool_use_id: 'call_a', content: 'A', is_error: true }, { type: 'text', text: 'Continue' }]),
    ] }));
    expect(converted.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Find files' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Checking' }] },
      { type: 'function_call', call_id: 'call_a', name: 'Read', arguments: '{"file_path":"/a"}' },
      { type: 'function_call', call_id: 'call_b', name: 'Read', arguments: '{"file_path":"/b"}' },
      { type: 'function_call_output', call_id: 'call_b', output: 'B' },
      { type: 'function_call_output', call_id: 'call_a', output: [
        { type: 'input_text', text: '[cc-switch:tool-result-error]' }, { type: 'input_text', text: 'A' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Continue' }] },
    ]);
  });

  it.each([['any', 'required'], ['none', 'none'], ['auto', 'auto']])('maps tool_choice %s', (type, expected) => {
    expect(requestToResponses(request({ tool_choice: { type } })).tool_choice).toBe(expected);
  });

  it('maps forced functions, parallel policy and schemas without injecting nested object types', () => {
    const converted = requestToResponses(request({ tools: [{ name: 'Read', input_schema: {
      properties: { file_path: { type: 'string', format: 'uri' }, choice: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
    } }], tool_choice: { type: 'tool', name: 'Read', disable_parallel_tool_use: true } }));
    expect(converted.tool_choice).toEqual({ type: 'function', name: 'Read' });
    expect(converted.parallel_tool_calls).toBe(false);
    expect(converted.tools[0].parameters).toEqual({ type: 'object', properties: {
      file_path: { type: 'string' }, choice: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    } });
  });

  it('converts base64 and URL images, including images returned by tools', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } };
    const converted = requestToResponses(request({ messages: [message([image,
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      { type: 'tool_result', tool_use_id: 'call', content: [{ type: 'text', text: 'Screenshot' }, image] }])] }));
    expect(converted.input[0].content).toEqual([{ type: 'input_image', image_url: 'data:image/png;base64,YWJj' },
      { type: 'input_image', image_url: 'https://example.com/a.png' }]);
    expect(converted.input[1].output).toEqual([{ type: 'input_text', text: 'Screenshot' },
      { type: 'input_image', image_url: 'data:image/png;base64,YWJj' }]);
    expect(() => requestToResponses(request({ messages: [message([{ type: 'image', source: { type: 'url', url: 'file:///secret' } }])] }))).toThrow('Unsupported image');
  });

  it('preserves bridge-owned opaque reasoning for a tool loop and discards orphan/native signatures', () => {
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Check files' }], encrypted_content: 'opaque' };
    const answer = responseToAnthropic(response({ output: [reasoning,
      { type: 'function_call', call_id: 'call', name: 'Read', arguments: '{"file_path":"/a"}' }] }));
    const converted = requestToResponses(request({ messages: [{ role: 'assistant', content: answer.content }] }));
    expect(converted.input[0]).toEqual(reasoning);
    expect(requestToResponses(request({ messages: [{ role: 'assistant', content: [answer.content[0]] }] })).input).toEqual([]);
    expect(requestToResponses(request({ messages: [{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'native', signature: 'native-provider-signature' }, { type: 'text', text: 'Answer' }],
    }] })).input[0].content).toEqual([{ type: 'output_text', text: 'Answer' }]);
  });

  it('fails closed for unsupported hosted tools and malformed tool history', () => {
    expect(() => requestToResponses(request({ tools: [{ type: 'web_search_20250305', name: 'web_search' }] }))).toThrow('Only function');
    expect(() => requestToResponses(request({ messages: [message([{ type: 'tool_result', content: 'missing ID' }])] }))).toThrow('Invalid tool_result');
    expect(() => requestToResponses(request({ max_tokens: 0 }))).toThrow('Invalid max_tokens');
  });
});

describe('Responses to Anthropic JSON', () => {
  it('uses mutually exclusive fresh/cache token buckets and keeps tool IDs for the next turn', () => {
    const answer = responseToAnthropic(response({ output: [
      { type: 'message', content: [{ type: 'output_text', text: 'Checking' }, { type: 'refusal', refusal: 'Cannot do that' }] },
      { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"/a","pages":""}' }],
    usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 20 } } }), 'claude-model');
    expect(answer).toMatchObject({ model: 'claude-model', stop_reason: 'tool_use', content: [
      { type: 'text', text: 'Checking' }, { type: 'text', text: 'Cannot do that' },
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/a' } }],
    usage: { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 40, cache_creation_input_tokens: 20 } });
  });

  it('handles incomplete output and saturates inconsistent cache counts', () => {
    const answer = responseToAnthropic(response({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'function_call', call_id: 'c', name: 'Read', arguments: '{"incomplete":' }],
      usage: { prompt_tokens: 10, completion_tokens: 3, cache_read_input_tokens: 20 } }));
    expect(answer).toMatchObject({ stop_reason: 'max_tokens', content: [{ type: 'tool_use', input: {} }],
      usage: { input_tokens: 0, output_tokens: 3, cache_read_input_tokens: 20 } });
  });

  it.each(['failed', 'cancelled'])('rejects an upstream %s response', (status) => {
    expect(() => responseToAnthropic(response({ status, error: { message: 'upstream-only Bearer secret' } })))
      .toThrow('Responses upstream failed');
    try { responseToAnthropic(response({ status, error: { message: 'upstream-only Bearer secret' } })); }
    catch (error) {
      expect(error.message).not.toContain('upstream-only');
      expect(error.message).not.toContain('Bearer secret');
    }
  });

  it('rejects malformed successful tool arguments instead of creating an empty tool invocation', () => {
    expect(() => responseToAnthropic(response({ output: [
      { type: 'function_call', call_id: 'c', name: 'Bash', arguments: '[]' }],
    }))).toThrow('must be an object');
  });
});

describe('Responses to Anthropic SSE', () => {
  it('handles byte-split Unicode, CRLF, done snapshots and final usage without duplicate text', async () => {
    const input = event('response.created', { response: { id: 'r', model: 'gpt-5' } }, '\r\n')
      + event('response.output_text.delta', { item_id: 'm', output_index: 0, content_index: 0, delta: '你好' }, '\r\n')
      + event('response.output_text.done', { item_id: 'm', output_index: 0, content_index: 0, text: '你好，世界' }, '\r\n')
      + event('response.completed', { response: response({ output: [{ id: 'm', type: 'message', content: [{ type: 'output_text', text: '你好，世界' }] }] }) }, '\r\n');
    const output = await collect(input, 1);
    expect(output.map((frame) => frame.type)).toEqual(['message_start', 'content_block_start', 'content_block_delta',
      'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(output.filter((frame) => frame.delta?.type === 'text_delta').map((frame) => frame.delta.text).join('')).toBe('你好，世界');
    expect(output.at(-2)).toMatchObject({ delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 100, output_tokens: 12 } });
  });

  it('handles interleaved tools and validates/sanitizes complete JSON before emitting arguments', async () => {
    const toolA = { id: 'fc_a', type: 'function_call', call_id: 'call_a', name: 'Read', arguments: '' };
    const toolB = { id: 'fc_b', type: 'function_call', call_id: 'call_b', name: 'Bash', arguments: '' };
    const input = event('response.output_item.added', { output_index: 0, item: toolA })
      + event('response.output_item.added', { output_index: 1, item: toolB })
      + event('response.function_call_arguments.delta', { item_id: 'fc_b', delta: '{"command":' })
      + event('response.function_call_arguments.delta', { item_id: 'fc_a', delta: '{"file_path":"/a","pages":""}' })
      + event('response.function_call_arguments.delta', { item_id: 'fc_b', delta: '"pwd"}' })
      + event('response.function_call_arguments.done', { item_id: 'fc_a' })
      + event('response.function_call_arguments.done', { item_id: 'fc_b' })
      + event('response.completed', { response: response({ output: [
        { ...toolA, arguments: '{"file_path":"/a","pages":""}' }, { ...toolB, arguments: '{"command":"pwd"}' }] }) });
    const output = await collect(input);
    expect(output.filter((frame) => frame.type === 'content_block_start').map((frame) => frame.content_block.id)).toEqual(['call_a', 'call_b']);
    expect(output.filter((frame) => frame.delta?.type === 'input_json_delta').map((frame) => [frame.index, JSON.parse(frame.delta.partial_json)]))
      .toEqual([[0, { file_path: '/a' }], [1, { command: 'pwd' }]]);
    expect(output.at(-2).delta.stop_reason).toBe('tool_use');
    expect(output.filter((frame) => frame.type === 'content_block_stop')).toHaveLength(2);
  });

  it('accepts a terminal-only snapshot without a trailing blank line', async () => {
    const output = await collect(event('response.completed', { response: response() }).trimEnd());
    expect(output.filter((frame) => frame.delta?.type === 'text_delta').map((frame) => frame.delta.text)).toEqual(['Hello']);
    expect(output.at(-1).type).toBe('message_stop');
  });

  it('binds unkeyed text deltas to the final output index without replaying the text', async () => {
    const output = await collect(event('response.output_text.delta', { delta: 'Hello' })
      + event('response.completed', { response: response() }));
    expect(output.filter((frame) => frame.delta?.type === 'text_delta').map((frame) => frame.delta.text)).toEqual(['Hello']);
    expect(output.at(-1).type).toBe('message_stop');
  });

  it('emits thinking and opaque signatures in proper SSE deltas for replay', async () => {
    const item = { id: 'rs', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Thinking' }], encrypted_content: 'opaque' };
    const output = await collect(event('response.output_item.done', { output_index: 0, item })
      + event('response.completed', { response: response({ output: [item] }) }));
    expect(output.find((frame) => frame.type === 'content_block_start').content_block).toEqual({ type: 'thinking', thinking: '' });
    expect(output.filter((frame) => frame.type === 'content_block_delta').map((frame) => frame.delta.type))
      .toEqual(['thinking_delta', 'signature_delta']);
    const signature = output.find((frame) => frame.delta?.type === 'signature_delta').delta.signature;
    const next = requestToResponses(request({ messages: [{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'Thinking', signature }, { type: 'text', text: 'Answer' }],
    }] }));
    expect(next.input[0]).toEqual(item);
  });

  it('ends incomplete streams with max_tokens and does not execute partial JSON', async () => {
    const output = await collect(event('response.output_item.added', { output_index: 0,
      item: { id: 'fc', type: 'function_call', call_id: 'call', name: 'Bash', arguments: '' } })
      + event('response.function_call_arguments.delta', { item_id: 'fc', delta: '{"command":' })
      + event('response.incomplete', { response: { usage: { output_tokens: 5 } } }));
    expect(output.find((frame) => frame.delta?.type === 'input_json_delta').delta.partial_json).toBe('{}');
    expect(output.at(-2)).toMatchObject({ delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 5 } });
  });

  it.each([
    event('response.failed', { response: { error: { message: 'service failed' } } }),
    event('response.cancelled'),
    event('response.completed', { response: response({ status: 'failed', error: { message: 'wrapper failed' } }) }),
    'event: response.output_text.delta\ndata: {invalid}\n\n',
    event('response.output_text.delta', { delta: 'truncated' }),
    'data: [DONE]\n\n',
  ])('reports failure without synthesizing message_stop: %s', async (input) => {
    const output = await collect(input);
    expect(output.at(-1).type).toBe('error');
    expect(output.some((frame) => frame.type === 'message_stop')).toBe(false);
  });

  it('propagates upstream transport failures as an Anthropic error event', async () => {
    async function* source() { yield event('response.created', { response: { id: 'r' } }); throw new Error('upstream-only Bearer secret'); }
    const output = [];
    for await (const chunk of responsesToAnthropicStream(source())) output.push(String(chunk));
    expect(output.at(-1)).toContain('event: error');
    expect(output.at(-1)).toContain('上游模型响应异常');
    expect(output.join('')).not.toContain('upstream-only');
    expect(output.join('')).not.toContain('Bearer secret');
  });

  it.each([
    event('response.failed', { response: { error: { type: 'upstream-only', message: 'Bearer secret' } } }),
    event('error', { error: { type: 'upstream-only', message: 'Bearer secret' } }),
    event('error', { message: 'upstream-only Bearer secret' }),
    event('response.completed', { response: response({ status: 'failed', error: { message: 'upstream-only Bearer secret' } }) }),
  ])('never returns upstream diagnostic strings in error SSE', async (input) => {
    const output = await collect(input);
    expect(output.at(-1)).toEqual({ type: 'error', error: { type: 'api_error', message: '上游模型响应异常，请重试或检查模型服务状态' } });
    expect(JSON.stringify(output)).not.toContain('upstream-only');
    expect(JSON.stringify(output)).not.toContain('Bearer secret');
  });

  it('ignores late failures after an accepted completed response', async () => {
    const output = await collect(event('response.completed', { response: response() }) + event('response.failed'));
    expect(output.at(-1).type).toBe('message_stop');
    expect(output.some((frame) => frame.type === 'error')).toBe(false);
  });
});
