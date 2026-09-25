// claude -p 呼叫器（Claude Code 那一邊）：cmd /c claude、stdin 餵 prompt、解析 JSON、--model 可指定
// 旗標照 CONTRACT：--output-format json --model <m> --allowedTools Read Write Edit Bash Glob Grep
import { spawn } from 'node:child_process';
import { killTree } from './server.mjs';

const DEFAULT_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'];

export function runClaude({ cwd, prompt, model = 'sonnet', env = {}, allowedTools = DEFAULT_TOOLS, timeoutMs = 45 * 60e3, extraArgs = [] }) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', ...(model ? ['--model', model] : []), ...extraArgs, '--allowedTools', ...allowedTools];
    const opts = { cwd, windowsHide: true, env: { ...process.env, ...env } };
    // Windows 下 claude 是 .cmd，直接 spawn 會 EINVAL——走 cmd /c
    const child = process.platform === 'win32'
      ? spawn('cmd', ['/c', 'claude', ...args], opts)
      : spawn('claude', args, opts);
    let out = ''; let err = ''; let timedOut = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    child.on('error', (e) => { err += `\n${e.message}`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(out); } catch { /* 非 JSON：原文留在 out */ }
      resolve({ code, out, err, json, timedOut, args });
    });
    child.stdin.end(prompt, 'utf8');
  });
}
