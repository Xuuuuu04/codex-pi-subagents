import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
for (const directory of ['src', 'scripts', 'tests', 'dashboard']) {
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.js'))) execFileSync(process.execPath, ['--check', `${directory}/${file}`], { stdio: 'inherit' });
}
console.log('JavaScript syntax checks passed.');
