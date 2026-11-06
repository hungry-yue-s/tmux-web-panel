// Adapted from CC Switch v3.20.3, commit 2181dda6b4703a7870ffe8c52671947375dec6d0:
// src-tauri/src/proxy/providers/{transform_responses,streaming_responses,reasoning_bridge}.rs
// https://github.com/farion1231/cc-switch/tree/v3.20.3/src-tauri/src/proxy/providers
// Copyright (c) 2025 Jason Young. MIT license: see cc-switch-LICENSE.txt.
import { randomUUID } from 'node:crypto';

const REASONING_PREFIX = 'ccswitch-openai-reasoning-v1:';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

function media(block) {
  const source = block.source;
  if (!object(source)) throw new Error('Image source is required');
  if (source.type === 'url' && typeof source.url === 'string' && /^https?:\/\//i.test(source.url)) {
    return { type: 'input_image', image_url: source.url };
  }
  if (source.type === 'base64' && /^image\/[a-zA-Z0-9.+-]+$/.test(source.media_type || '')
    && typeof source.data === 'string' && source.data.length > 0) {
    return { type: 'input_image', image_url: `data:${source.media_type};base64,${source.data}` };
  }
  throw new Error('Unsupported image source');
}

function toolOutput(block) {
  if (typeof block.content === 'string' && !block.is_error) return block.content;
  const parts = block.is_error ? [{ type: 'input_text', text: '[cc-switch:tool-result-error]' }] : [];
  for (const part of Array.isArray(block.content) ? block.content : [block.content ?? '']) {
    if (typeof part === 'string') parts.push({ type: 'input_text', text: part });
    else if (part?.type === 'image') parts.push(media(part));
    else parts.push({ type: 'input_text', text: part?.type === 'text' ? String(part.text || '') : JSON.stringify(part) });
  }
  return parts;
}

function reasoningFromBlock(block) {
  const encoded = block.type === 'thinking' ? block.signature : block.data;
  if (typeof encoded !== 'string' || !encoded.startsWith(REASONING_PREFIX)) return null;
  try {
    const item = JSON.parse(Buffer.from(encoded.slice(REASONING_PREFIX.length), 'base64url').toString());
    return item?.type === 'reasoning' ? item : null;
  } catch { return null; }
}

function reasoningBlock(item) {
  const text = (item.summary || []).filter((part) => ['summary_text', 'reasoning_text'].includes(part.type))
    .map((part) => part.text || '').join('');
  const signature = item.encrypted_content ? REASONING_PREFIX + Buffer.from(JSON.stringify(item)).toString('base64url') : null;
  if (text) return { type: 'thinking', thinking: text, ...(signature ? { signature } : {}) };
  return signature ? { type: 'redacted_thinking', data: signature } : null;
}

function cleanSchema(schema, root = true) {
  if (!object(schema)) return root ? { type: 'object', properties: {} } : schema;
  const result = { ...schema };
  if (root && !result.type) { result.type = 'object'; result.properties ||= {}; }
  if (result.format === 'uri') delete result.format;
  if (object(result.properties)) result.properties = Object.fromEntries(Object.entries(result.properties)
    .map(([key, value]) => [key, cleanSchema(value, false)]));
  if (result.items) result.items = cleanSchema(result.items, false);
  return result;
}

export function requestToResponses(body) {
  if (!object(body) || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
    throw new Error('Anthropic request requires model and messages');
  }
  const result = { model: body.model, input: [], store: false, include: ['reasoning.encrypted_content'] };
  const system = typeof body.system === 'string' ? [body.system] : (body.system || []).map((part) => part.text || '');
  const instructions = system.map((text) => text.replace(/^x-anthropic-billing-header:[^\r\n]*(?:\r?\n){0,2}/, ''))
    .filter(Boolean).join('\n\n');
  if (instructions) result.instructions = instructions;
  for (const message of body.messages) {
    if (!object(message) || !['user', 'assistant'].includes(message.role)) throw new Error('Unsupported message role');
    const role = message.role;
    const start = result.input.length;
    let parts = [];
    const flush = () => { if (parts.length) { result.input.push({ role, content: parts }); parts = []; } };
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    if (!Array.isArray(blocks)) throw new Error('Message content must be text or content blocks');
    for (const block of blocks) {
      if (block?.type === 'text') parts.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: String(block.text || '') });
      else if (block?.type === 'image') parts.push(media(block));
      else if (block?.type === 'tool_use') {
        if (role !== 'assistant' || !block.id || !block.name || !object(block.input)) throw new Error('Invalid tool_use block');
        flush();
        result.input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
      } else if (block?.type === 'tool_result') {
        if (role !== 'user' || !block.tool_use_id) throw new Error('Invalid tool_result block');
        flush();
        result.input.push({ type: 'function_call_output', call_id: block.tool_use_id, output: toolOutput(block) });
      } else if (['thinking', 'redacted_thinking'].includes(block?.type)) {
        const item = reasoningFromBlock(block);
        if (item) { flush(); result.input.push(item); }
      } else throw new Error(`Unsupported Anthropic content block: ${block?.type || 'unknown'}`);
    }
    flush();
    // Responses rejects orphan reasoning at the end of an incomplete assistant turn.
    if (role === 'assistant') {
      while (result.input.length > start && result.input.at(-1).type === 'reasoning') result.input.pop();
    }
  }
  if (body.max_tokens != null) {
    if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens <= 0) throw new Error('Invalid max_tokens');
    result.max_output_tokens = Math.max(16, body.max_tokens);
  }
  for (const key of ['temperature', 'top_p', 'stream']) if (body[key] != null) result[key] = body[key];
  if (body.tools != null) {
    if (!Array.isArray(body.tools)) throw new Error('tools must be an array');
    result.tools = body.tools.map((tool) => {
      if (!tool.name || (tool.type && tool.type !== 'custom')) throw new Error('Only function tools are supported by this bridge');
      return { type: 'function', name: tool.name, ...(tool.description ? { description: tool.description } : {}),
        parameters: cleanSchema(tool.input_schema) };
    });
  }
  if (body.tool_choice) {
    const choice = body.tool_choice;
    if (choice.type === 'tool' && choice.name) result.tool_choice = { type: 'function', name: choice.name };
    else if (['auto', 'none', 'any'].includes(choice.type)) result.tool_choice = choice.type === 'any' ? 'required' : choice.type;
    else throw new Error('Unsupported tool_choice');
    if (typeof choice.disable_parallel_tool_use === 'boolean') result.parallel_tool_calls = !choice.disable_parallel_tool_use;
  }
  if (/^(?:o\d|gpt-[5-9]|grok-(?:4\.5|build))/i.test(body.model)) {
    const effort = ({ low: 'low', medium: 'medium', high: 'high', max: 'xhigh' })[body.output_config?.effort]
      || (body.thinking?.type === 'adaptive' ? 'xhigh' : body.thinking?.type === 'enabled'
        ? body.thinking.budget_tokens < 4000 ? 'low' : body.thinking.budget_tokens < 16000 ? 'medium' : 'high' : null);
    if (effort) result.reasoning = { effort };
  }
  return result;
}

function usageFromResponses(usage = {}) {
  const cached = count(usage.cache_read_input_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens);
  const created = count(usage.cache_creation_input_tokens ?? usage.input_tokens_details?.cache_write_tokens ?? usage.prompt_tokens_details?.cache_write_tokens);
  return { input_tokens: Math.max(0, count(usage.input_tokens ?? usage.prompt_tokens) - cached - created),
    output_tokens: count(usage.output_tokens ?? usage.completion_tokens),
    ...(cached ? { cache_read_input_tokens: cached } : {}), ...(created ? { cache_creation_input_tokens: created } : {}) };
}

function stopReason(response, hasTools) {
  if (response.status === 'incomplete') return !response.incomplete_details?.reason
    || ['max_output_tokens', 'max_tokens'].includes(response.incomplete_details.reason) ? 'max_tokens' : 'end_turn';
  return hasTools ? 'tool_use' : 'end_turn';
}

function validateResponse(response) {
  if (!object(response)) throw new Error('Invalid Responses payload');
  if (['failed', 'cancelled'].includes(response.status) || response.error) {
    throw new Error('Responses upstream failed');
  }
}

function toolInput(name, raw, incomplete = false) {
  let input;
  try { input = JSON.parse(raw || '{}'); }
  catch { if (incomplete) return {}; throw new Error('Invalid function_call arguments'); }
  if (!object(input)) { if (incomplete) return {}; throw new Error('Function call arguments must be an object'); }
  if (name === 'Read' && input.pages === '') delete input.pages;
  return input;
}

export function responseToAnthropic(response, model) {
  validateResponse(response);
  if (!Array.isArray(response.output)) throw new Error('Responses payload has no output array');
  const content = [];
  for (const item of response.output) {
    if (item.type === 'message') {
      for (const part of item.content || []) {
        if (part.type === 'output_text') content.push({ type: 'text', text: part.text || '' });
        else if (part.type === 'refusal') content.push({ type: 'text', text: part.refusal || '' });
        else throw new Error('Unsupported Responses content');
      }
    } else if (item.type === 'function_call') {
      if (!item.call_id || !item.name) throw new Error('Function call is missing identity');
      content.push({ type: 'tool_use', id: item.call_id, name: item.name,
        input: toolInput(item.name, item.arguments, response.status === 'incomplete') });
    } else if (item.type === 'reasoning') {
      const block = reasoningBlock(item);
      if (block) content.push(block);
    } else throw new Error('Unsupported Responses output');
  }
  return { id: response.id || `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: model || response.model || '',
    content, stop_reason: stopReason(response, content.some((block) => block.type === 'tool_use')),
    stop_sequence: null, usage: usageFromResponses(response.usage || {}) };
}

async function* events(source) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  function parse(block) {
    let event;
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '');
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length || data.join('\n') === '[DONE]') return null;
    let value;
    try { value = JSON.parse(data.join('\n')); }
    catch { throw new Error('Malformed Responses SSE event'); }
    if (!object(value)) throw new Error('Invalid Responses SSE event');
    return { ...value, type: value.type || event };
  }
  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let delimiter;
    while ((delimiter = /\r?\n\r?\n/.exec(buffer))) {
      if (delimiter.index > 1024 * 1024) throw new Error('Responses SSE frame exceeds size limit');
      const event = parse(buffer.slice(0, delimiter.index));
      buffer = buffer.slice(delimiter.index + delimiter[0].length);
      if (event) yield event;
    }
    if (buffer.length > 1024 * 1024) throw new Error('Responses SSE frame exceeds size limit');
  }
  buffer += decoder.decode();
  if (buffer.trim()) { const event = parse(buffer); if (event) yield event; }
}

function sse(type, payload = {}) {
  return Buffer.from(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
}

export async function* responsesToAnthropicStream(source, model) {
  let started = false;
  let nextIndex = 0;
  let hasTools = false;
  const aliases = new Map();
  const blocks = new Map();
  const items = new Map();
  const start = (response = {}) => {
    if (started) return [];
    started = true;
    return [sse('message_start', { message: { id: response.id || `msg_${randomUUID()}`, type: 'message', role: 'assistant',
      model: model || response.model || '', content: [], stop_reason: null, stop_sequence: null,
      usage: usageFromResponses(response.usage || {}) } })];
  };
  const itemKey = (data, item = {}) => {
    const keys = [item.id || data.item_id, data.output_index != null ? `out:${data.output_index}` : null].filter(Boolean);
    if (!keys.length) keys.push('out:0');
    const key = keys.map((value) => aliases.get(value)).find(Boolean) || keys[0] || 'out:0';
    for (const value of keys) aliases.set(value, key);
    return key;
  };
  const open = (key, content) => {
    let block = blocks.get(key);
    if (block) return [block, []];
    block = { index: nextIndex++, value: '', closed: false, type: content.type };
    blocks.set(key, block);
    return [block, [...start(), sse('content_block_start', { index: block.index, content_block: content })]];
  };
  const close = (block) => {
    if (block.closed) return [];
    block.closed = true;
    return [sse('content_block_stop', { index: block.index })];
  };
  const text = (data, value, snapshot = false, done = false) => {
    const key = `${itemKey(data)}:text:${data.content_index || 0}`;
    const [block, output] = open(key, { type: 'text', text: '' });
    let delta = value;
    if (snapshot) {
      if (!value.startsWith(block.value)) throw new Error('Responses text snapshot conflicts with streamed content');
      delta = value.slice(block.value.length);
    }
    if (delta) {
      if (block.closed) throw new Error('Responses text changed after content completion');
      block.value += delta;
      output.push(sse('content_block_delta', { index: block.index, delta: { type: 'text_delta', text: delta } }));
    }
    if (done) output.push(...close(block));
    return output;
  };
  const completeItem = (data, item, incomplete = false) => {
    const key = itemKey(data, item);
    if (item.type === 'message') {
      return (item.content || []).flatMap((part, index) => {
        if (!['output_text', 'refusal'].includes(part.type)) throw new Error('Unsupported Responses content');
        return text({ ...data, item_id: item.id, content_index: index }, part.text ?? part.refusal ?? '', true, true);
      });
    }
    if (item.type === 'function_call') {
      const existing = items.get(key) || {};
      const tool = { ...existing, ...item };
      if (!tool.call_id || !tool.name) throw new Error('Function call is missing identity');
      const [block, output] = open(`${key}:tool`, { type: 'tool_use', id: tool.call_id, name: tool.name, input: {} });
      if (!block.closed) {
        output.push(sse('content_block_delta', { index: block.index, delta: { type: 'input_json_delta',
          partial_json: JSON.stringify(toolInput(tool.name, item.arguments || existing.arguments, incomplete)) } }));
        output.push(...close(block));
      }
      hasTools = true;
      items.set(key, tool);
      return output;
    }
    if (item.type === 'reasoning') {
      const content = reasoningBlock(item);
      if (!content || blocks.has(`${key}:reasoning`)) return [];
      const [block, output] = open(`${key}:reasoning`, content.type === 'thinking'
        ? { type: 'thinking', thinking: '' } : content);
      if (content.type === 'thinking') {
        output.push(sse('content_block_delta', { index: block.index, delta: { type: 'thinking_delta', thinking: content.thinking } }));
        if (content.signature) output.push(sse('content_block_delta', { index: block.index,
          delta: { type: 'signature_delta', signature: content.signature } }));
      }
      return [...output, ...close(block)];
    }
    throw new Error('Unsupported Responses output');
  };
  try {
    for await (const event of events(source)) {
      if (['response.failed', 'response.cancelled', 'error'].includes(event.type)) {
        throw new Error('Responses upstream failed');
      }
      if (event.type === 'response.created' || event.type === 'response.in_progress') yield* start(event.response);
      else if (event.type === 'response.output_item.added') {
        const key = itemKey(event, event.item);
        items.set(key, { ...event.item });
        if (event.item?.type === 'function_call') {
          if (!event.item.call_id || !event.item.name) throw new Error('Function call is missing identity');
          const [, output] = open(`${key}:tool`, { type: 'tool_use', id: event.item.call_id, name: event.item.name, input: {} });
          yield* output;
        }
      } else if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
        if (typeof event.delta !== 'string') throw new Error('Invalid Responses text delta');
        yield* text(event, event.delta);
      } else if (event.type === 'response.output_text.done' || event.type === 'response.refusal.done') {
        yield* text(event, event.text ?? event.refusal ?? '', true, true);
      } else if (event.type === 'response.content_part.done') {
        if (event.part?.type === 'output_text' || event.part?.type === 'refusal') {
          yield* text(event, event.part.text ?? event.part.refusal ?? '', true, true);
        }
      } else if (event.type === 'response.function_call_arguments.delta') {
        if (typeof event.delta !== 'string') throw new Error('Invalid function arguments delta');
        const key = itemKey(event);
        const item = items.get(key) || { type: 'function_call', call_id: event.call_id, name: event.name };
        item.arguments = (item.arguments || '') + event.delta;
        items.set(key, item);
      } else if (event.type === 'response.function_call_arguments.done') {
        const key = itemKey(event);
        const item = items.get(key) || { type: 'function_call', call_id: event.call_id, name: event.name };
        yield* completeItem(event, { ...item, ...(event.arguments != null ? { arguments: event.arguments } : {}) });
      } else if (event.type === 'response.output_item.done') yield* completeItem(event, event.item);
      else if (['response.completed', 'response.incomplete'].includes(event.type)) {
        const response = { ...event.response, status: event.response?.status || event.type.slice(9) };
        validateResponse(response);
        yield* start(response);
        for (const [index, item] of (response.output || []).entries()) {
          yield* completeItem({ output_index: index }, item, response.status === 'incomplete');
        }
        for (const [key, item] of items) {
          if (item.type === 'function_call' && !blocks.get(`${key}:tool`)?.closed) {
            yield* completeItem({ item_id: key }, item, response.status === 'incomplete');
          }
        }
        for (const block of blocks.values()) yield* close(block);
        yield sse('message_delta', { delta: { stop_reason: stopReason(response, hasTools), stop_sequence: null },
          usage: usageFromResponses(response.usage || {}) });
        yield sse('message_stop');
        return;
      }
    }
    throw new Error('Responses stream ended before a terminal response');
  } catch {
    yield sse('error', { error: { type: 'api_error', message: '上游模型响应异常，请重试或检查模型服务状态' } });
  }
}
