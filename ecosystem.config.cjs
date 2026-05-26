module.exports = {
  apps: [
    {
      name: 'peer-review-bot',
      script: 'src/server.js',
      interpreter: 'node',
      interpreter_args: '--experimental-vm-modules',
      cwd: __dirname,
      env_file: '.env',
      watch: false,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 3000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      merge_logs: true,
    },
  ],
};
