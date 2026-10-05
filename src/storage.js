import fs from 'node:fs';
import path from 'node:path';

/** Persist private agent metadata atomically; credentials remain in Pi's own auth store. */
export class Storage {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  directory(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid agent ID');
    return path.join(this.root, id);
  }
  save(record) {
    const dir = this.directory(record.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, 'agent.json');
    const temporary = target + `.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, target);
  }
  load(id) { return JSON.parse(fs.readFileSync(path.join(this.directory(id), 'agent.json'), 'utf8')); }
  all() {
    return fs.readdirSync(this.root).filter(id => /^[0-9a-f-]{36}$/.test(id)).map(id => this.load(id));
  }
  append(id, event) {
    fs.appendFileSync(path.join(this.directory(id), 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
  }
  events(id) {
    const file = path.join(this.directory(id), 'events.jsonl');
    if (!fs.existsSync(file)) return [];
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - 2 * 1024 * 1024);
      const bytes = Buffer.alloc(size - start);
      fs.readSync(fd, bytes, 0, bytes.length, start);
      const lines = bytes.toString('utf8').split('\n');
      if (start) lines.shift();
      return lines.filter(Boolean).slice(-500).map(line => JSON.parse(line));
    } finally { fs.closeSync(fd); }
  }
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}
