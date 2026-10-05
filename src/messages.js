import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

/** Local message channel: reports are queued; blocking questions await an explicit parent reply. */
export class MessageChannel {
  constructor(manager) {
    this.manager = manager;
    this.questions = new Map();
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch(error => this.respond(response, 400, { error: error.message }));
    });
  }
  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.endpoint = `http://127.0.0.1:${this.server.address().port}/message`;
  }
  respond(response, status, data) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(data));
  }
  async handle(request, response) {
    if (request.method !== 'POST' || request.url !== '/message') { this.respond(response, 404, { error: 'Not found' }); return; }
    let bytes = 0; const chunks = [];
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 20000) { this.respond(response, 413, { error: 'Message is too large' }); return; }
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const authorization = Buffer.from(request.headers.authorization || '');
    const possible = this.manager.agents.get(value.agentId);
    const expected = Buffer.from(`Bearer ${possible?.messageToken || randomUUID()}`);
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      this.respond(response, 401, { error: 'Unauthorized' }); return;
    }
    const agent = this.manager.get(value.agentId);
    if (!agent.rpc || agent.rpc.exited) throw new Error('Agent is not active');
    if (value.action === 'message') {
      if (typeof value.message !== 'string' || !value.message.trim() || value.message.length > 12000) throw new Error('Invalid message');
      if (value.recipient === 'parent') this.manager.event(agent, 'message', { sender: agent.record.id, recipient: 'parent', message: value.message });
      else await this.manager.send(value.recipient, `[Message from sibling ${agent.record.id}]\n${value.message}`, 'steer');
      this.respond(response, 200, { accepted: true, recipient: value.recipient });
    } else if (value.action === 'question') {
      if (typeof value.question !== 'string' || !value.question.trim() || value.question.length > 12000) throw new Error('Invalid question');
      const questionId = randomUUID();
      this.questions.set(questionId, { agentId: agent.record.id, response });
      agent.record.questionIds.push(questionId);
      agent.record.status = 'waiting';
      this.manager.event(agent, 'question', { questionId, question: value.question });
      response.on('close', () => {
        if (!this.questions.delete(questionId)) return;
        agent.record.questionIds = agent.record.questionIds.filter(id => id !== questionId);
        if (!agent.record.questionIds.length && agent.record.status === 'waiting') agent.record.status = 'running';
        this.manager.event(agent, 'question_cancelled', { questionId });
      });
    } else throw new Error('Unknown message action');
  }
  reply(questionId, message) {
    const question = this.questions.get(questionId);
    if (!question) throw new Error('Question is no longer waiting; read the current agent state');
    const agent = this.manager.get(question.agentId);
    this.questions.delete(questionId);
    agent.record.questionIds = agent.record.questionIds.filter(id => id !== questionId);
    if (!agent.record.questionIds.length) agent.record.status = 'running';
    this.manager.event(agent, 'answer', { questionId, message });
    this.respond(question.response, 200, { questionId, answer: message });
    return { answered: true, agentId: agent.record.id, questionId };
  }
  cancelAgent(id) {
    for (const [questionId, question] of this.questions) {
      if (question.agentId !== id) continue;
      this.questions.delete(questionId);
      this.respond(question.response, 409, { error: 'Parent interrupted or closed this agent' });
    }
    const agent = this.manager.get(id);
    agent.record.questionIds = [];
  }
  async close() {
    for (const id of this.manager.agents.keys()) this.cancelAgent(id);
    this.server.closeAllConnections();
    await new Promise(resolve => this.server.close(resolve));
  }
}
