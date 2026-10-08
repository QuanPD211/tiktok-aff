// PM2 config. Environment variables are read from .env (created by deploy.sh).
const fs = require('fs');
const path = require('path');

const env = { NODE_ENV: 'production' };
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
}

module.exports = {
  apps: [
    {
      name: 'news',
      script: 'server.js',
      cwd: __dirname,
      env,
      max_memory_restart: '300M',
    },
  ],
};
