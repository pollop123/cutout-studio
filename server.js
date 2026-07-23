// Compatibility launcher. The Python server is now the single backend for
// theme generation, AI background removal, mask cleanup, and both web UIs.
const { existsSync } = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const candidates = [
  process.env.PYTHON,
  path.join(__dirname, '.venv', 'bin', 'python'),
  path.join(__dirname, 'venv', 'bin', 'python'),
  path.join(__dirname, 'creator_tool', 'venv', 'bin', 'python'),
  'python3',
  'python'
].filter(Boolean);
const python = candidates.find(candidate => !candidate.includes(path.sep) || existsSync(candidate));
if (!python) throw new Error('Python 3 not found');

const child = spawn(python, [path.join(__dirname, 'server.py'), '--port', process.env.PORT || '3000'], {
  stdio: 'inherit'
});
child.on('exit', code => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
