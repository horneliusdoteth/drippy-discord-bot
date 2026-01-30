# Drippy Discord Bot

This bot handles automatic member verification when users join the Discord server using their unique invite link.

## What It Does

1. Detects when a new member joins the server
2. Identifies which invite code was used
3. Looks up the user in Supabase by invite code
4. Verifies their subscription is active
5. Links their Discord ID to their user record
6. Assigns the "Member" role
7. Sends a welcome DM

## Setup

### 1. Create Discord Application

1. Go to https://discord.com/developers/applications
2. Click "New Application" → Name: "Drippy Bot"
3. Go to "Bot" tab → Click "Add Bot"
4. Enable these Privileged Gateway Intents:
   - SERVER MEMBERS INTENT
   - MESSAGE CONTENT INTENT (optional, for future commands)
5. Copy the bot token

### 2. Invite Bot to Server

Generate an invite URL with these permissions:
- Manage Roles
- Create Instant Invite
- Send Messages
- View Channels

Permission integer: `268437504`

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=268437504&scope=bot
```

### 3. Get Server IDs

1. Enable Developer Mode: User Settings → Advanced → Developer Mode
2. Right-click your server → Copy ID (this is DISCORD_GUILD_ID)
3. Right-click the "Member" role → Copy ID (this is DISCORD_MEMBER_ROLE_ID)

### 4. Configure Environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

### 5. Install Dependencies

```bash
npm install
```

### 6. Run Locally

```bash
npm start
```

Or with auto-reload for development:

```bash
npm run dev
```

## Deployment

This bot needs to run 24/7 to detect member joins. Recommended platforms:

### Railway (Recommended - ~$5/mo)

1. Create a new project at railway.app
2. Connect your GitHub repo
3. Set the root directory to `discord-bot`
4. Add environment variables in Railway dashboard
5. Deploy!

### Fly.io (~$5/mo)

1. Install flyctl: `curl -L https://fly.io/install.sh | sh`
2. Login: `flyctl auth login`
3. Create app: `flyctl launch`
4. Set secrets: `flyctl secrets set DISCORD_BOT_TOKEN=xxx ...`
5. Deploy: `flyctl deploy`

### AWS EC2 (t3.nano ~$3.50/mo)

1. Launch a t3.nano instance
2. Install Node.js
3. Clone the repo
4. Use PM2 to keep it running: `pm2 start index.js --name drippy-bot`

## Troubleshooting

### Bot not detecting joins

- Make sure SERVER MEMBERS INTENT is enabled in Discord Developer Portal
- Verify the bot has "View Channels" permission
- Check that DISCORD_GUILD_ID is correct

### Can't assign roles

- The bot's role must be HIGHER than the "Member" role in the server settings
- Verify the bot has "Manage Roles" permission

### Invite tracking not working

- The bot must be online BEFORE invites are created to track them properly
- Restart the bot to refresh the invite cache

## Logs

The bot logs all activity to stdout. On Railway/Fly.io, you can view logs in the dashboard.

Key log messages:
- `Discord bot ready as ...` - Bot started successfully
- `Cached X invites` - Invite cache initialized
- `New member joined: ...` - Member join detected
- `Invite used: ...` - Identified which invite was used
- `Successfully onboarded ...` - Full flow completed
