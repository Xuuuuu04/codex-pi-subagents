#!/usr/bin/env node
// Read-only parent wake-up helper: blocks until selected agents emit callback events, prints them and exits.
// Claude Code runs it as a background command (exit wakes the session) or under Monitor with --follow.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Storage } from '../src/storage.js';
import { callbackEvents, callbackText } from '../src/callbacks.js';

const { values } = parseArgs({ options: {
  agent: { type: 'string', multiple: true }, after: { type: 'string', multiple: true }, events: { type: 'string', default: 'settled,question,process_failed,budget_limit,control_failed' },
  timeout: { type: 'string', default: '3600' }, follow: { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
} });
if (!values.agent?.length) { console.error('Usage: wait-events.js --agent <id> [--agent <id>] [--after <id>=<sequence>] [--events settled,question] [--timeout seconds] [--follow] [--json]'); process.exit(64); }
const events = values.events.split(',');
if (events.some(type => !callbackEvents.includes(type))) { console.error(`Events must be from: ${callbackEvents.join(', ')}`); process.exit(64); }
const storage = new Storage(process.env.PI_SUBAGENTS_STATE_DIR || fileURLToPath(new URL('../.agents/runtime', import.meta.url)));
const after = {};
for (const id of values.agent) after[id] = storage.load(id).sequence; // Default: only events after now.
for (const item of values.after || []) { const [id, sequence] = item.split('='); after[id] = Number(sequence); }
const deadline = Date.now() + Number(values.timeout) * 1000;
for (;;) {
  let matched = 0;
  for (const id of values.agent) {
    for (const event of storage.events(id, after[id], 100)) {
      after[id] = event.sequence;
      if (!events.includes(event.type) || (event.type === 'message' && event.recipient !== 'parent')) continue;
      console.log(values.json ? JSON.stringify(event) : callbackText(event) + '\n'); matched++;
    }
  }
  if (matched && !values.follow) process.exit(0);
  if (Date.now() > deadline) { console.log(`No callback event within ${values.timeout}s for ${values.agent.join(', ')}. Cursor: ${JSON.stringify(after)} (state ${path.basename(storage.root)})`); process.exit(values.follow ? 0 : 2); }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
