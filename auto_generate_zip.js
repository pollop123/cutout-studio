const { existsSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

const bundledPython = '/Users/wu/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
const candidates = [process.env.PYTHON, bundledPython, 'python3'].filter(Boolean);
const script = join(__dirname, 'generate_theme.py');

for (const python of candidates) {
  if (python.includes('/') && !existsSync(python)) continue;
  const result = spawnSync(python, [script], { stdio: 'inherit' });
  if (!result.error && result.status === 0) process.exit(0);
}

console.error('Unable to generate the theme. Run generate_theme.py with Python 3 and Pillow installed.');
process.exit(1);
