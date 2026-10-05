import { ensureDashboard } from '../src/dashboard-launcher.js';
const info = await ensureDashboard(process.env.PI_SUBAGENTS_STATE_DIR);
console.log('Pi 会话面板（仅本机）：' + info.url);
console.log('只读查看现有会话，不会停止或接手正在运行的代理。');
