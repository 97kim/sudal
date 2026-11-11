import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChatEvent } from '@shared/chat-events';
import type { SessionAgent } from '@shared/session-agents';
import type { SubagentHistoryCursor, SubagentHistoryPage } from '@shared/subagent-history';
import { mapClaudeTranscriptLine, mapCodexRolloutLine, newMirrorState, shownCommand } from './transcript-mirror';

const PAGE_BYTES = 1024 * 1024;
const HEADER_BYTES = 4 * PAGE_BYTES;
const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
interface TranscriptInfo { file: string; identity: string; childStart: number; prompt: string }
const transcripts = new Map<string, TranscriptInfo>();
function remember(key: string, info: TranscriptInfo) {
  transcripts.delete(key); transcripts.set(key, info);
  if (transcripts.size > 32) transcripts.delete(transcripts.keys().next().value!);
}
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const str = (v: unknown) => typeof v === 'string' ? v : '';
function parse(line: string): Obj { try { return obj(JSON.parse(line)); } catch { return {}; } }

async function within(root: string, file: string): Promise<string | null> {
  try {
    const [base, resolved] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
    const relative = path.relative(base, resolved);
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? resolved : null;
  } catch { return null; }
}

async function head(file: string, max = HEADER_BYTES): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(max, (await handle.stat()).size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

async function parentRecords(file: string): Promise<Buffer[]> {
  const first = await head(file);
  if (first.length < HEADER_BYTES) return [first];
  const handle = await fs.open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(HEADER_BYTES, size - HEADER_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const last = buffer.subarray(0, bytesRead);
    const preceding = Buffer.alloc(1);
    await handle.read(preceding, 0, 1, start - 1);
    return [first, preceding[0] === 10 ? last : last.subarray(last.indexOf(10) + 1)];
  } finally { await handle.close(); }
}

function* lines(buffer: Buffer, base = 0): Generator<{ line: string; start: number; end: number }> {
  let start = 0;
  for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10, start)) {
    yield { line: buffer.subarray(start, end).toString('utf8'), start: base + start, end: base + end + 1 };
    start = end + 1;
  }
}

async function codexFile(root: string, id: string): Promise<string | null> {
  // Exact IDs only; never choose a recent conversation by cwd or timestamp.
  const dirs = [root];
  for (let depth = 0; depth < 3; depth++) {
    const next: string[] = [];
    for (const dir of dirs.splice(0)) {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) if (entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) next.push(path.join(dir, entry.name));
    }
    dirs.push(...next);
  }
  for (const dir of dirs) {
    let names: string[];
    try { names = await fs.readdir(dir); } catch { continue; }
    const name = names.find(name => name.startsWith('rollout-') && name.endsWith(`-${id}.jsonl`));
    if (name) return within(root, path.join(dir, name));
  }
  return null;
}

async function claudeFile(root: string, sessionId: string, row: SessionAgent): Promise<string | null> {
  let projects: string[];
  try { projects = await fs.readdir(root); } catch { return null; }
  for (const project of projects) {
    const parent = await within(root, path.join(root, project, `${sessionId}.jsonl`));
    const dir = path.join(root, project, sessionId, 'subagents');
    let agentId = row.backgroundId;
    if (agentId && SAFE_ID.test(agentId)) {
      const found = await within(root, path.join(dir, `agent-${agentId}.jsonl`));
      if (found) return found;
    }
    if (parent) {
      // Claude's persisted tool result supplies the exact agent ID for foreground calls.
      for (const buffer of await parentRecords(parent)) for (const { line } of lines(buffer)) {
        const data = parse(line), message = obj(data.message);
        const content = Array.isArray(message.content) ? message.content : [];
        if (!content.some(raw => obj(raw).type === 'tool_result' && obj(raw).tool_use_id === row.blockId)) continue;
        agentId = str(obj(data.toolUseResult).agentId) || undefined;
        if (!agentId) for (const raw of content) {
          const result = obj(raw);
          if (result.type !== 'tool_result' || result.tool_use_id !== row.blockId) continue;
          const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
          agentId = /\bagentId:\s*([a-zA-Z0-9_-]+)/.exec(text ?? '')?.[1];
        }
      }
    }
    if (agentId && SAFE_ID.test(agentId)) {
      const found = await within(root, path.join(dir, `agent-${agentId}.jsonl`));
      if (found) return found;
    }
  }
  return null;
}

/** Load only the selected child's local transcript; never start or resume a provider session. */
export async function readSubagentHistory(options: {
  roots: { codex: string; claude: string }; parentSessionId: string | null;
  row: SessionAgent; before?: number; after?: SubagentHistoryCursor;
}): Promise<SubagentHistoryPage> {
  const { roots, row, parentSessionId, before, after } = options;
  const unavailable = (): SubagentHistoryPage => ({ events: [], before: null, limited: false, unavailable: true });
  if (row.kind !== 'internal' || !parentSessionId || !SAFE_ID.test(parentSessionId)) return unavailable();
  const codexId = row.provider === 'codex' && row.id.startsWith('codex:') ? row.id.slice(6) : '';
  if (row.provider !== 'claude' && !SAFE_ID.test(codexId)) return unavailable();
  const key = JSON.stringify([roots,row.provider,parentSessionId,row.id,row.blockId,row.backgroundId]);
  let info = transcripts.get(key);
  const root = row.provider === 'codex' ? roots.codex : roots.claude;
  const cached = info && await within(root, info.file);
  const file = cached || (row.provider === 'codex' ? await codexFile(roots.codex, codexId) : await claudeFile(roots.claude, parentSessionId, row));
  if (!file) return unavailable();
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat(), size = stat.size;
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    const append = !!after && after.identity === identity && after.offset <= size && !(after.size === size && after.mtimeMs !== stat.mtimeMs);
    if (!info || info.identity !== identity || after && !append || !after && before === undefined) {
      info = {file,identity,childStart:row.provider === 'codex' ? Infinity : 0,prompt:''};
      if (row.provider === 'codex') {
        const header = await head(file);
        const firstLineEnd = header.indexOf(10);
        const first = parse(header.subarray(0, firstLineEnd < 0 ? header.length : firstLineEnd).toString('utf8'));
        const meta = obj(first.payload), spawn = obj(obj(obj(meta.source).subagent).thread_spawn);
        if (first.type !== 'session_meta' || meta.id !== codexId || spawn.parent_thread_id !== parentSessionId) return unavailable();
        for (const record of lines(header)) {
          const data = parse(record.line), payload = obj(data.payload);
          if (data.type === 'response_item' && payload.type === 'function_call' && payload.call_id === row.blockId) {
            const prompt = str(parse(str(payload.arguments)).prompt);
            if (prompt.length <= 64*1024) info.prompt = prompt;
          }
          if (data.type === 'event_msg' && (payload.type === 'thread_settings_applied' && payload.thread_id === codexId || payload.type === 'task_started' && !!obj(payload.turn_attribution).parent_turn_id)) { info.childStart = record.start; break; }
        }
      }
      remember(key, info);
    }
    const cursor = (offset: number, discardPartial = false): SubagentHistoryCursor => ({offset,identity,size,mtimeMs:stat.mtimeMs,...(discardPartial ? {discardPartial:true} : {})});
    if (append && after!.offset === size) return {events:[],before:null,limited:false,append:true,cursor:cursor(size,after!.discardPartial)};
    const { prompt } = info;
    let childStart = info.childStart;
    const end = append ? Math.min(size, after!.offset + PAGE_BYTES) : before === undefined ? size : before;
    if (!Number.isSafeInteger(end) || end < 0 || end > size) return unavailable();
    const floor = Number.isFinite(childStart) ? childStart : 0;
    const start = append ? after!.offset : Math.max(Math.min(floor, end), end - PAGE_BYTES);
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const data = buffer.subarray(0, bytesRead);
    const newline = data.indexOf(10);
    const skip = append ? after!.discardPartial ? newline < 0 ? data.length : newline + 1 : 0 : start > floor ? newline < 0 ? data.length : newline + 1 : 0;
    const next = !append && start > floor ? skip === data.length ? start : start + skip : null;
    let limited = !Number.isFinite(childStart) || skip === data.length && data.length > 0;
    const events: ChatEvent[] = [];
    const state = newMirrorState();
    const records = [...lines(data.subarray(skip), start + skip)];
    // Leave an incomplete trailing record for the next incremental read.
    const tailStart = data.lastIndexOf(10) + 1;
    let consumed = records.at(-1)?.end ?? start + skip;
    let discardPartial = skip === data.length && newline < 0 && data.length > 0;
    if (tailStart >= skip && tailStart < data.length && before === undefined && end === size && Object.keys(parse(data.subarray(tailStart).toString('utf8'))).length) {
      records.push({line:data.subarray(tailStart).toString('utf8'),start:start+tailStart,end}); consumed = end;
    } else if (consumed === start && data.length === PAGE_BYTES) { consumed = end; discardPartial = true; limited = true; }
    const canonicalIds = new Set<string>();
    for (const record of records) {
      const data = parse(record.line), payload = obj(data.payload);
      const item = obj(payload.item);
      if (data.type === 'event_msg' && payload.type === 'item_completed' && ['UserMessage','AgentMessage','CommandExecution','FileChange'].includes(str(item.type)) && (payload.thread_id === codexId || payload.thread_id === undefined && record.start >= childStart)) canonicalIds.add(str(item.id));
    }
    for (const record of records) {
      const parsed = parse(record.line);
      if (!Object.keys(parsed).length) continue;
      if (row.provider === 'claude') {
        events.push(...mapClaudeTranscriptLine(JSON.stringify({ ...parsed, isSidechain: false }), state));
        continue;
      }
      const payload = obj(parsed.payload);
      if (parsed.type === 'event_msg' && !Number.isFinite(childStart) && (payload.type === 'thread_settings_applied' && payload.thread_id === codexId || payload.type === 'task_started' && !!obj(payload.turn_attribution).parent_turn_id)) { childStart = record.start; info.childStart = childStart; }
      if (record.start < childStart && payload.thread_id !== codexId) continue;
      if (parsed.type === 'event_msg' && payload.thread_id !== undefined && payload.thread_id !== codexId) continue;
      if (parsed.type === 'event_msg' && payload.type === 'item_completed') {
        events.push(...mapCodexRolloutLine(record.line, state));
      } else if (parsed.type === 'response_item' && payload.type === 'agent_message') {
        const content = Array.isArray(payload.content) ? payload.content.map(obj) : [];
        const encrypted = content.some(item => item.type === 'encrypted_content');
        limited ||= encrypted;
        const text = content.map(item => str(item.text)).join('\n');
        if (text && (!encrypted || prompt && text.includes('Message Type: NEW_TASK'))) events.push({ type: 'user_message', ts: Date.parse(str(parsed.timestamp)) || 0, id: str(payload.id) || `agent-message:${record.start}`, text: encrypted ? prompt : text });
      } else if (parsed.type === 'response_item') {
        const ts = Date.parse(str(parsed.timestamp)) || 0;
        const id = str(payload.call_id) || str(payload.id) || `record:${record.start}`;
        if (canonicalIds.has(id)) continue;
        if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
          const content = Array.isArray(payload.content) ? payload.content.map(obj) : [];
          limited ||= content.some(item => item.type === 'encrypted_content');
          const text = content.map(item => str(item.text)).join('\n');
          if (text) events.push(payload.role === 'user' ? {type:'user_message',ts,id,text} : {type:'assistant_text',ts,blockId:id,text});
        } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
          const name = str(payload.name);
          const input = payload.type === 'function_call' ? parse(str(payload.arguments)) : {patch:str(payload.input)};
          const shell = ['exec_command','shell','shell_command'].includes(name);
          const command = Array.isArray(input.command) ? shownCommand(input.command.map(str)) : str(input.command) || str(input.cmd);
          events.push({type:'tool_use',ts,toolUseId:id,name:shell ? 'Bash' : name === 'apply_patch' ? 'ApplyPatch' : name,input:shell ? {...input,command} : input});
        } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
          const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '');
          const result = parse(output);
          const exit = result.exit_code ?? result.exitCode;
          events.push({type:'tool_result',ts,toolUseId:id,output,isError:result.is_error === true || typeof exit === 'number' && exit !== 0});
        }
      }
    }
    return { events, before: next, limited, append, cursor:cursor(consumed,discardPartial), hasNewer:append && consumed > start && consumed < size && end < size };
  } finally { await handle.close(); }
}
