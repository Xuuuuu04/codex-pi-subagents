const $ = selector => document.querySelector(selector);
const labels = { starting: '正在启动', running: '运行中', waiting: '等待答复', finishing: '正在结束', idle: '空闲', completed: '已完成', failed: '失败', interrupted: '已中断', closed: '已关闭', disconnected: '控制进程已离线' };
const working = new Set(['starting', 'running', 'waiting', 'finishing']);
let token = location.hash.slice(1) || sessionStorage.getItem('pi-dashboard-token') || '';
function captureToken() {
  if (!location.hash) return;
  token = location.hash.slice(1); sessionStorage.setItem('pi-dashboard-token', token); history.replaceState(null, '', location.pathname);
}
captureToken();
let agents = []; let selected = ''; let tab = 'messages'; let paused = false; let fetching = false; let lastDetail = '';
const time = value => value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const model = agent => `${agent.model?.provider || '未知服务'} / ${agent.model?.model || '未知模型'}`;
function element(tag, text, className) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (className) e.className = className; return e; }
function badge(agent) { return element('span', labels[agent.status] || agent.status, `badge ${agent.status}`); }
async function api(path) {
  const response = await fetch(path, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || `读取失败：${response.status}`); return result;
}
function showError(message) { $('#error').textContent = message; $('#error').hidden = !message; }
function renderList() {
  const focused = document.activeElement?.dataset.agent;
  const query = $('#search').value.toLowerCase(); const filter = $('#status').value;
  const visible = agents.filter(a => ($('#history').checked || a.status !== 'closed' || filter === 'closed') &&
    (filter === 'all' || filter === 'active' && working.has(a.status) || a.status === filter) &&
    `${a.name} ${model(a)} ${a.cwd} ${a.id}`.toLowerCase().includes(query));
  const tbody = $('#agents'); tbody.replaceChildren();
  for (const a of visible) {
    const row = element('tr'); row.className = a.id === selected ? 'selected' : '';
    const name = element('td'); const button = element('button', a.name || a.id.slice(0, 8), 'agent-select'); button.type = 'button'; button.setAttribute('aria-pressed', a.id === selected ? 'true' : 'false');
    button.dataset.agent = a.id;
    button.addEventListener('click', () => { selected = a.id; lastDetail = ''; renderList(); refreshDetail().catch(error => showError(error.message)); });
    name.append(button, element('div', model(a), 'model'));
    const status = element('td'); status.append(badge(a), element('div', a.questions.length ? `${a.questions.length} 个问题待答复` : a.currentTools.length ? a.currentTools.join('、') : a.controllerAlive ? '控制进程在线' : '控制进程不在线', 'action'));
    const updated = element('td', time(a.updatedAt), 'time'); updated.title = date(a.updatedAt);
    row.append(name, status, updated); tbody.append(row);
    if (focused === a.id) button.focus({ preventScroll: true });
  }
  $('#empty').hidden = visible.length > 0;
  $('#empty').textContent = agents.length ? '没有符合条件的会话。可以清除搜索或调整状态。' : '还没有会话。通过 Codex 的 pi-subagents 创建代理后会自动显示。';
  const count = state => agents.filter(a => a.status === state).length;
  $('#summary').textContent = `${agents.length} 个会话 · ${agents.filter(a => working.has(a.status)).length} 正在工作 · ${count('waiting')} 等待答复 · ${count('completed')} 已完成 · ${count('failed') + count('disconnected')} 需要查看`;
}
function metadata(agent) {
  const rows = [['身份', agent.id], ['工作目录', agent.cwd || '—'], ['文件范围', (agent.ownedPaths || []).join('、')], ['开始时间', date(agent.createdAt)], ['更新时间', date(agent.updatedAt)], ['用量', `输入 ${agent.usage?.input || 0} · 输出 ${agent.usage?.output || 0} token`]];
  if (agent.temporaryModel) rows.push(['临时模型', `本次结束后恢复 ${model({ model: agent.temporaryModel.model })}`]);
  const dl = $('#metadata'); dl.replaceChildren(); for (const [name, value] of rows) dl.append(element('dt', name), element('dd', value));
}
function renderRecords(data) {
  const records = $('#records');
  const expanded = new Map([...records.querySelectorAll('details')].map(node => [node.dataset.key, node.open]));
  const scroll = $('.detail').scrollTop;
  records.replaceChildren();
  const roles = { user: '任务 / 指导', assistant: '模型回复', toolResult: '工具结果' };
  if (tab === 'messages') {
    for (const message of [...data.messages].reverse()) {
      const article = element('article', null, 'record'); const header = element('header'); header.append(element('strong', roles[message.role] || message.role), element('span', time(message.time)));
      article.append(header); if (message.toolName) article.append(element('div', message.toolName, 'model'));
      if (message.text) { const block = element('details'); block.dataset.key = `${data.agent.id}:${message.id}:text`; block.open = expanded.get(block.dataset.key) ?? message.role !== 'toolResult'; block.append(element('summary', message.role === 'toolResult' ? '查看工具输出' : '查看内容'), element('pre', message.text)); article.append(block); }
      for (const [index, call] of message.calls.entries()) { const block = element('details'); block.dataset.key = `${data.agent.id}:${message.id}:call:${index}`; block.open = expanded.get(block.dataset.key) ?? false; block.append(element('summary', `执行 ${call.name}`), element('pre', call.arguments)); article.append(block); }
      records.append(article);
    }
    $('#record-note').textContent = data.transcriptError ? `会话内容暂时无法读取：${data.transcriptError}` : '显示最近 50 条已保存内容。工具和状态会持续更新；模型尚未保存的逐字输出不在这里显示。';
  } else if (tab === 'events') {
    const types = { ready: '准备就绪', started: '开始执行', instruction: '收到任务 / 指导', question: '向父代理提问', answer: '父代理答复', message: '向父代理报告', tool_execution_start: '开始使用工具', tool_execution_end: '工具执行结束', settled: '本次执行结束', model_changed: '模型已更换', model_restored: '原模型已恢复', resumed: '会话已恢复', interrupted: '执行已中断', closed: '会话已关闭', process_failed: '进程失败', control_failed: '控制命令失败', extension_error: '扩展失败', question_cancelled: '问题等待已取消', instruction_failed: '任务发送失败' };
    for (const event of data.agent.events.slice(-100).reverse()) {
      const article = element('article', null, 'record'); const header = element('header'); header.append(element('strong', types[event.type] || event.type), element('span', `${time(event.time)} · #${event.sequence}`)); article.append(header);
      if (event.toolName) article.append(element('div', event.toolName, 'model'));
      const text = event.question || event.message || event.error || event.text; if (text) article.append(element('pre', text)); records.append(article);
    }
    $('#record-note').textContent = '最近 100 条状态与通信记录，最新记录在前。';
  } else { records.append(element('pre', data.agent.lastText || '暂时没有模型结果。')); $('#record-note').textContent = '这是模型最近保存的结果，是否完成要求仍需检查。'; }
  if (!records.childNodes.length) records.append(element('p', '暂时没有记录。', 'empty'));
  $('.detail').scrollTop = scroll;
}
async function refreshDetail() {
  if (!selected) return;
  const requested = selected; const data = await api(`/api/agents/${requested}`); if (selected !== requested) return;
  const key = JSON.stringify([tab, data.agent.sequence, data.agent.status, data.messages, data.transcriptError]); if (lastDetail === key) return; lastDetail = key;
  const a = data.agent; $('#detail-empty').hidden = true; $('#detail').hidden = false;
  $('#agent-name').textContent = a.name; $('#agent-model').textContent = `${model(a)} · 思考 ${a.thinking || '默认'}`;
  const status = $('#agent-status'); status.textContent = labels[a.status] || a.status; status.className = `badge ${a.status}`; metadata(a);
  const questions = $('#questions'); questions.replaceChildren();
  for (const q of a.questions) { const box = element('div', null, 'notice'); box.append(element('strong', '正在等待父代理答复'), element('p', q.question, 'question-text'), element('p', `问题身份：${q.questionId}`, 'hint')); questions.append(box); }
  $('#agent-error').hidden = !a.error; $('#agent-error').textContent = a.error || ''; renderRecords(data);
}
async function refresh() {
  if (fetching || paused) return; fetching = true;
  try {
    const result = await api('/api/agents'); agents = result.agents; renderList();
    if (!selected && agents.length) selected = (agents.find(a => a.status === 'waiting') || agents.find(a => working.has(a.status)) || agents[0]).id;
    renderList(); await refreshDetail();
    $('#connection').textContent = `已更新 ${time(result.refreshedAt)}`; showError(result.errors.length ? `${result.errors.length} 个会话读取失败：${result.errors.map(e => `${e.id}: ${e.error}`).join('；')}` : '');
  } catch (error) { $('#connection').textContent = '更新失败 · 保留上次数据'; showError(error.message); }
  finally { fetching = false; }
}
$('#search').addEventListener('input', renderList); $('#status').addEventListener('change', renderList); $('#history').addEventListener('change', renderList);
$('#pause').addEventListener('click', () => { paused = !paused; $('#pause').textContent = paused ? '继续更新' : '暂停更新'; if (paused) $('#connection').textContent = '已暂停 · 页面数据不再更新'; else refresh(); });
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => { tab = button.dataset.tab; lastDetail = ''; for (const other of document.querySelectorAll('[data-tab]')) other.setAttribute('aria-pressed', String(other === button)); refreshDetail().catch(error => showError(error.message)); });
refresh(); setInterval(refresh, 2000);
window.addEventListener('hashchange', () => { captureToken(); paused = false; $('#pause').textContent = '暂停更新'; refresh(); });
