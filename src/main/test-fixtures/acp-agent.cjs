// 모델·실제 CLI 없이 ACP stdio 계약과 수명주기를 검증하는 에이전트.
const { createInterface } = require('node:readline');
const { writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const update = (sessionId, update) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
const sessions = new Set();
const pending = new Map();
let sequence = 0;
const mode = process.argv[2];
const chatMode = mode === 'chat' || mode === 'chat-load' || mode === 'chat-skills';
const planning = new Map();
const permissionModes = new Map();
const configOptions = (sessionId) => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fixture-model', options: [{ value: 'fixture-model', name: 'Fixture Model' }] },
  ...(chatMode ? [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: permissionModes.get(sessionId) ?? 'default', options: [{ value: 'default', name: 'Default' }, { value: 'read-only', name: 'Read only' }] }] : []),
  ...(chatMode ? [{ id: 'collaboration_mode', name: 'Collaboration mode', category: 'collaboration_mode', type: 'select', currentValue: planning.get(sessionId) ?? 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] }] : []),
];
function requestPermission(id, sessionId) {
  const requestId = `approval-${id}`;
  pending.set(requestId, { id, sessionId });
  send({ jsonrpc: '2.0', id: requestId, method: 'session/request_permission', params: {
    sessionId, toolCall: { toolCallId: `tool-${id}`, title: 'Fixture command', kind: 'execute', rawInput: { command: 'echo fixture' } },
    options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
  } });
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (!method) {
    const prompt = pending.get(id);
    if (!prompt) return;
    pending.delete(id);
    const outcome = message.result?.outcome;
    update(prompt.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: outcome?.optionId || 'cancelled' } });
    reply(prompt.id, { stopReason: outcome?.outcome === 'selected' ? 'end_turn' : 'cancelled' });
  } else if (method === 'initialize') {
    const answer = () => reply(id, {
      protocolVersion: mode === 'bad-version' ? 99 : 1,
      agentInfo: { name: 'fixture', version: '1.0.0' },
      agentCapabilities: mode === 'minimal' ? {} : { loadSession: true, sessionCapabilities: { list: {}, ...(mode === 'chat-load' ? {} : { resume: {} }) }, promptCapabilities: { image: true } },
      authMethods: [{ id: 'fixture', name: 'Fixture sign-in' }],
    });
    if (process.env.ACP_INIT_MARKER) writeFileSync(process.env.ACP_INIT_MARKER, JSON.stringify(params));
    if (mode === 'slow-init') setTimeout(answer, 1000); else answer();
  } else if (method === 'session/new') {
    const sessionId = `fixture-${++sequence}`;
    sessions.add(sessionId);
    if (process.env.ACP_CHILD_PID_FILE) {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
      writeFileSync(process.env.ACP_CHILD_PID_FILE, String(child.pid));
    }
    update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review changes', input: { hint: 'scope' } }, ...(mode === 'chat-skills' ? [{ name: '$fixture-skill', description: 'Fixture skill' }] : [])] });
    reply(id, { sessionId, configOptions: configOptions(sessionId) });
  } else if (method === 'authenticate') reply(id, {});
  else if (method === 'session/list') reply(id, { sessions: [...sessions].map(sessionId => ({ sessionId, cwd: process.cwd(), title: 'Fixture', updatedAt: new Date().toISOString() })) });
  else if (method === 'session/load' || method === 'session/resume') {
    sessions.add(params.sessionId);
    if (method === 'session/load') update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'restored' } });
    if (chatMode) update(params.sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review changes' }] });
    reply(id, { configOptions: configOptions(params.sessionId) });
  } else if (method === 'session/set_config_option') {
    if (params.configId === 'mode') permissionModes.set(params.sessionId, params.value);
    reply(id, { configOptions: configOptions(params.sessionId).map(option => option.id === params.configId ? { ...option, currentValue: params.value } : option) });
  }
  else if (method === 'session/prompt') {
    const text = params.prompt[0]?.text;
    if (text === '/plan' || text === '/plan off') {
      planning.set(params.sessionId, text === '/plan' ? 'plan' : 'default');
      update(params.sessionId, { sessionUpdate: 'config_option_update', configOptions: configOptions(params.sessionId) });
      reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (text === '/commands') update(params.sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'logout', description: 'Logout' }, { name: 'doctor', description: 'Check adapter' }] });
    if (text === '/tool') {
      update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read', kind: 'read', status: 'in_progress', rawInput: { path: 'fixture.txt' } });
      update(params.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'fixture data' } }] });
    }
    if (text === 'exit') return process.exit(7);
    if (text === 'oversized') {
      update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x'.repeat(10000) } });
      return;
    }
    if (text === 'hang') { pending.set(`hang-${id}`, { id, sessionId: params.sessionId }); return; }
    // 취소 알림을 받은 뒤 승인 요청을 보내, 이미 전송 중이던 요청의 도착 순서 역전을 재현한다.
    if (text === 'late-permission') { pending.set(`late-${id}`, { id, sessionId: params.sessionId, late: true }); return; }
    if (text === 'permission') {
      requestPermission(id, params.sessionId);
      return;
    }
    update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text || 'image' } });
    reply(id, { stopReason: 'end_turn' });
  } else if (method === 'session/cancel') {
    if (mode === 'ignore-cancel') return;
    for (const [requestId, prompt] of [...pending]) {
      if (prompt.sessionId !== params.sessionId) continue;
      pending.delete(requestId);
      if (prompt.late) requestPermission(prompt.id, prompt.sessionId);
      else reply(prompt.id, { stopReason: 'cancelled' });
    }
  } else if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});
