# RP Immigration Consulting - Client Document Checklist System

A case management system for tracking immigration document collection between staff and clients.

## Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start

# 3. Open in browser
# Staff login:    http://localhost:3000/staff
# Default creds:  admin / admin123
```

The database is auto-created on first run with 11 immigration case type templates.

## Production Deployment

### Option A: Office Server (LAN access)

```bash
# 1. Install Node.js 18+ on the server machine
# https://nodejs.org/

# 2. Copy project folder to server

# 3. Install dependencies
npm install --production

# 4. Create .env file
cp .env.example .env
# Edit .env: set SESSION_SECRET and change ADMIN_PASSWORD

# 5. Generate a session secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Paste the output into .env as SESSION_SECRET=<value>

# 6. Start with PM2 (recommended)
npm install -g pm2
pm2 start ecosystem.config.js
pm2 startup   # auto-start on boot
pm2 save

# 7. Access from other machines on the network:
# http://<server-ip>:3000/staff
```

### Option B: VPS / Cloud (for client portal access)

```bash
# 1. Provision a VPS (Ubuntu 22.04 recommended)
#    DigitalOcean, Linode, or AWS Lightsail ($5-10/month)

# 2. Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# 3. Clone/copy project and install
npm install --production

# 4. Configure .env (same as Option A steps 4-5)

# 5. Install and configure nginx as reverse proxy
sudo apt install -y nginx
```

Create `/etc/nginx/sites-available/rp-immigration`:
```nginx
server {
    listen 80;
    server_name portal.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
# 6. Enable site and SSL
sudo ln -s /etc/nginx/sites-available/rp-immigration /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 7. SSL with Let's Encrypt
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d portal.yourdomain.com

# 8. Start with PM2
pm2 start ecosystem.config.js
pm2 startup && pm2 save
```

## Post-Deployment Checklist

- [ ] Change default admin password (login > Settings or via API)
- [ ] Create staff accounts for sales and filing team members
- [ ] Test: create a case, generate client link, verify client portal
- [ ] Set up daily database backup (see below)
- [ ] If using VPS: verify SSL is working (https://)

## Database Backups

```bash
# Manual backup
./scripts/backup.sh

# Automated daily backup (add to crontab)
crontab -e
# Add this line (runs at 2 AM daily):
0 2 * * * /path/to/Client\ Checklist\ App/scripts/backup.sh
```

Backups are stored in `backups/` and auto-cleaned after 30 days.

## Monitoring (PM2)

```bash
pm2 status          # Process status
pm2 logs            # View logs
pm2 monit           # Real-time monitoring
pm2 restart all     # Restart after updates
```

## How It Works

**Staff workflow:**
1. Sales creates a case via KT form (client info + case type)
2. System auto-generates a document checklist from templates
3. Staff shares the client portal link (unique URL per case)
4. Filing team reviews documents as client marks them sent
5. Staff accepts or rejects each document with notes
6. Case auto-completes when all required documents are accepted

**Client experience:**
1. Client receives a unique portal URL (no login needed)
2. Portal shows their document checklist with real-time status
3. Client marks documents as "Sent" and adds notes
4. Rejection reasons are visible so client knows what to fix

## Project Structure

```
server.js              # Express server + all API routes
database.js            # Database init, schema, seed data
ecosystem.config.js    # PM2 process manager config
scripts/backup.sh      # Database backup script
public/staff/          # Staff login + dashboard
public/client/         # Client portal
data/                  # SQLite database (auto-created)
docs/                  # PRD, implementation plan, execution roadmap
```
