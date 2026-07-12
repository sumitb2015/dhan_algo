const path = require('path');
const fs = require('fs');

const PROJECT_ROOT  = path.resolve(process.cwd(), 'rs_dashboard', '..');
const PYTHON_EXE    = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const STORE_SCRIPT  = path.join(PROJECT_ROOT, 'scripts', 'tools', 'strategy_store.py');

console.log('PROJECT_ROOT:', PROJECT_ROOT);
console.log('PYTHON_EXE exists:', fs.existsSync(PYTHON_EXE), PYTHON_EXE);
console.log('STORE_SCRIPT exists:', fs.existsSync(STORE_SCRIPT), STORE_SCRIPT);

const { spawnSync } = require('child_process');
const res = spawnSync(PYTHON_EXE, [STORE_SCRIPT, 'list'], { encoding: 'utf8' });
console.log('status:', res.status);
console.log('error:', res.error);
console.log('stdout:', JSON.stringify(res.stdout));
console.log('stderr:', JSON.stringify(res.stderr));
