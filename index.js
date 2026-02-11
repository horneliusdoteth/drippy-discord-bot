/**
 * Drippy Finance Discord Bot
 *
 * This bot detects when users join the server using their unique invite code,
 * links their Discord account to their Supabase user record, and assigns the Member role.
 *
 * Deploy this as a separate always-on service (Railway, Fly.io, or EC2).
 */

require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// Validate required environment variables
const requiredEnvVars = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_GUILD_ID',
  'DISCORD_MEMBER_ROLE_ID',
  'DISCORD_VISITOR_ROLE_ID',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites
  ]
});

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const MEMBER_ROLE_ID = process.env.DISCORD_MEMBER_ROLE_ID;
const VISITOR_ROLE_ID = process.env.DISCORD_VISITOR_ROLE_ID;

// Cache invites to track which one was used when a member joins
// Map<inviteCode, useCount>
let inviteCache = new Map();

/**
 * Initialize invite cache when bot starts
 */
async function cacheInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    invites.forEach(invite => {
      inviteCache.set(invite.code, invite.uses || 0);
    });
    console.log(`Cached ${inviteCache.size} invites`);
  } catch (err) {
    console.error('Failed to cache invites:', err);
  }
}

// Bot ready event
client.once(Events.ClientReady, async (c) => {
  console.log(`Discord bot ready as ${c.user.tag}`);

  // Cache invites for our guild
  const guild = c.guilds.cache.get(GUILD_ID);
  if (guild) {
    await cacheInvites(guild);
  } else {
    console.error(`Bot is not in guild ${GUILD_ID}`);
  }
});

// Track new invites
client.on(Events.InviteCreate, (invite) => {
  console.log(`New invite created: ${invite.code}`);
  inviteCache.set(invite.code, invite.uses || 0);
});

// Track deleted invites
client.on(Events.InviteDelete, (invite) => {
  console.log(`Invite deleted: ${invite.code}`);
  inviteCache.delete(invite.code);
});

// Handle member joins
client.on(Events.GuildMemberAdd, async (member) => {
  console.log(`New member joined: ${member.user.tag} (${member.id})`);

  // Ignore bots
  if (member.user.bot) {
    console.log('Ignoring bot user');
    return;
  }

  // Only process for our guild
  if (member.guild.id !== GUILD_ID) {
    console.log(`Member joined different guild: ${member.guild.id}`);
    return;
  }

  try {
    // Strategy 1: Try to find the used invite by comparing counts
    const newInvites = await member.guild.invites.fetch();
    let usedInviteCode = null;

    for (const [code, invite] of newInvites) {
      const cachedUses = inviteCache.get(code) || 0;
      if ((invite.uses || 0) > cachedUses) {
        usedInviteCode = code;
        break;
      }
    }

    // Update cache with new counts
    newInvites.forEach(invite => {
      inviteCache.set(invite.code, invite.uses || 0);
    });

    // Strategy 2: If invite tracking failed (common with single-use invites),
    // check database for pending users who haven't joined Discord yet
    if (!usedInviteCode) {
      console.log('Invite tracking failed, checking database for pending invites...');

      // Find any user with an invite code who hasn't linked their Discord yet
      // and has an active subscription
      const { data: pendingUsers, error: pendingError } = await supabase
        .from('users')
        .select('*')
        .is('discord_user_id', null)
        .not('discord_invite_code', 'is', null)
        .eq('subscription_status', 'active')
        .order('updated_at', { ascending: false })
        .limit(10);

      console.log(`Found ${pendingUsers?.length || 0} pending users in database`);

      if (pendingError) {
        console.error('Database query error:', pendingError);
      }

      if (!pendingError && pendingUsers && pendingUsers.length > 0) {
        // Log all pending users for debugging
        pendingUsers.forEach(u => {
          const inviteExists = newInvites.has(u.discord_invite_code);
          console.log(`  - ${u.email}: invite ${u.discord_invite_code} exists=${inviteExists}`);
        });

        // Strategy 2a: First, check if any invite codes were deleted (used)
        for (const pendingUser of pendingUsers) {
          const inviteStillExists = newInvites.has(pendingUser.discord_invite_code);

          if (!inviteStillExists) {
            console.log(`Found pending user with deleted invite: ${pendingUser.email} (code: ${pendingUser.discord_invite_code})`);
            usedInviteCode = pendingUser.discord_invite_code;
            break;
          }
        }

        // Strategy 2b: If no deleted invites found but there's exactly ONE pending user,
        // assume they're the one joining (best effort for single-use invites that haven't been deleted yet)
        if (!usedInviteCode && pendingUsers.length === 1) {
          console.log(`Only one pending user, assuming it's them: ${pendingUsers[0].email}`);
          usedInviteCode = pendingUsers[0].discord_invite_code;
        }
      }
    }

    // Look up user by invite code in Supabase
    let user = null;

    if (usedInviteCode) {
      console.log(`Looking up invite code: ${usedInviteCode}`);
      const { data, error: queryError } = await supabase
        .from('users')
        .select('*')
        .eq('discord_invite_code', usedInviteCode)
        .single();

      if (!queryError && data) {
        user = data;
      }
    }

    if (!user) {
      console.log('Could not determine which invite was used or find matching user');
      // Assign Visitor role so they have basic access
      const visitorRole = member.guild.roles.cache.get(VISITOR_ROLE_ID);
      if (visitorRole) {
        await member.roles.add(visitorRole);
        console.log(`Assigned Visitor role to unverified user ${member.user.tag}`);
      }
      await sendWelcomeDM(member, false);
      return;
    }

    console.log(`Found user: ${user.email}`);

    // Link Discord ID to user in Supabase (always, regardless of subscription status)
    const { error: updateError } = await supabase
      .from('users')
      .update({
        discord_user_id: member.id,
        discord_joined_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('Failed to update user with Discord ID:', updateError);
    } else {
      console.log(`Linked Discord ID ${member.id} to user ${user.email}`);
    }

    // Assign role based on subscription status
    if (user.subscription_status === 'active') {
      // Active subscriber — assign Member role
      const role = member.guild.roles.cache.get(MEMBER_ROLE_ID);
      if (role) {
        await member.roles.add(role);
        console.log(`Assigned Member role to ${member.user.tag}`);
      } else {
        console.error(`Member role ${MEMBER_ROLE_ID} not found`);
      }

      // Send welcome DM
      await sendWelcomeDM(member, true, user.name);
    } else {
      // Inactive/cancelled subscriber — assign Visitor role
      console.log(`User ${user.email} subscription not active: ${user.subscription_status}`);
      const visitorRole = member.guild.roles.cache.get(VISITOR_ROLE_ID);
      if (visitorRole) {
        await member.roles.add(visitorRole);
        console.log(`Assigned Visitor role to ${member.user.tag}`);
      } else {
        console.error(`Visitor role ${VISITOR_ROLE_ID} not found`);
      }

      await sendWelcomeDM(member, false, user.name);
    }

    console.log(`Successfully onboarded ${member.user.tag} (${user.email})`);

  } catch (err) {
    console.error('Error processing member join:', err);
  }
});

/**
 * Send a welcome DM to a new member
 */
async function sendWelcomeDM(member, isVerified, name = '') {
  const firstName = name ? name.split(' ')[0] : member.user.username;

  let message;
  if (isVerified) {
    message =
      `Welcome to Drippy Finance, ${firstName}! 🎉\n\n` +
      `Your subscription is active and you now have access to all member channels.\n\n` +
      `**Getting Started:**\n` +
      `• Check out #announcements for the latest updates\n` +
      `• Introduce yourself in #general\n` +
      `• Ask questions in #support if you need help\n\n` +
      `If you have any questions, the team is here to help!`;
  } else {
    message =
      `Welcome to Drippy Finance! 👋\n\n` +
      `We couldn't automatically verify your subscription. ` +
      `If you're a subscriber, please contact support to get your Member role.\n\n` +
      `If you're just checking things out, feel free to look around!`;
  }

  try {
    await member.send(message);
    console.log(`Sent welcome DM to ${member.user.tag}`);
  } catch (err) {
    console.log(`Could not send DM to ${member.user.tag}:`, err.message);
    // User might have DMs disabled - that's okay
  }
}

// Handle member leaves (optional: log for analytics)
client.on(Events.GuildMemberRemove, async (member) => {
  console.log(`Member left: ${member.user.tag} (${member.id})`);

  // Optionally update Supabase to clear discord_user_id
  // This allows them to rejoin with a new invite if they resubscribe
  try {
    const { error } = await supabase
      .from('users')
      .update({
        discord_user_id: null,
        updated_at: new Date().toISOString()
      })
      .eq('discord_user_id', member.id);

    if (!error) {
      console.log(`Cleared Discord ID for departed member ${member.id}`);
    }
  } catch (err) {
    console.error('Error clearing Discord ID:', err);
  }
});

// Error handling
client.on(Events.Error, (error) => {
  console.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

// Start the bot
console.log('Starting Drippy Discord Bot...');
client.login(process.env.DISCORD_BOT_TOKEN);
