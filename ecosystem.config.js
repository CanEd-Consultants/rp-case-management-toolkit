// PM2 process manager configuration
// Install: npm install -g pm2
// Start:   pm2 start ecosystem.config.js
// Monitor: pm2 monit
// Logs:    pm2 logs rp-immigration
// Restart: pm2 restart rp-immigration
// Auto-start on boot: pm2 startup && pm2 save

module.exports = {
  apps: [{
    name: 'rp-immigration',
    script: 'server.js',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    error_file: 'logs/error.log',
    out_file: 'logs/app.log',
    time: true
  }]
};
