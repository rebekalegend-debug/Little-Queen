// index.js
import {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import ical from "node-ical";
import fs from "fs";
import path from "path";

/* ================= ENV ================= */

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ICS_URL = process.env.ICS_URL;

const PING = process.env.PING_TEXT ?? "@everyone";
const CHECK_EVERY_MINUTES = Number(process.env.CHECK_EVERY_MINUTES ?? "10");
const PREFIX = process.env.PREFIX ?? "!";

// Persistent state (Railway volume at /data)
const STATE_DIR = process.env.STATE_DIR ?? "/data";
const stateFile = path.resolve(STATE_DIR, "state.json");

if (!DISCORD_TOKEN || !ICS_URL) {
  console.error("Missing env vars: DISCORD_TOKEN or ICS_URL");
  process.exit(1);
}

/* ================= STATE ================= */

ensureStateDir();
const state = loadState();

state.scheduled ??= [];
state.config ??= {
  pingChannelId: null,
  accessRoleId: null,
  aooTeamRoleId: null,
  mgeChannelId: null,
  mgeRoleId: null,
};
saveState();

function ensureStateDir() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch (e) {
    console.error("Failed to create STATE_DIR:", STATE_DIR, e);
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

function saveState() {
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("Failed to save state:", e);
  }
}

/* ================= HELPERS ================= */

function isAdmin(member) {
  try {
    return member?.permissions?.has(PermissionsBitField.Flags.Administrator);
  } catch {
    return false;
  }
}

function canUseCommands(member) {
  const roleId = state.config.accessRoleId;
  if (!roleId) return isAdmin(member);
  return member?.roles?.cache?.has(roleId);
}

function getPingChannelId(fallbackFromMessageChannelId = null) {
  return state.config.pingChannelId || fallbackFromMessageChannelId || null;
}

function getAooRoleMention() {
  return state.config.aooTeamRoleId ? `<@&${state.config.aooTeamRoleId}>` : "";
}

function getMgeChannelMention() {
  return state.config.mgeChannelId
    ? `<#${state.config.mgeChannelId}>`
    : "**[MGE channel not set]**";
}

function getMgeRoleMention() {
  return state.config.mgeRoleId
    ? `<@&${state.config.mgeRoleId}>`
    : "**[MGE role not set]**";
}

function getEventType(evOrText = "") {
  const text =
    typeof evOrText === "string"
      ? evOrText
      : [evOrText?.description, evOrText?.summary, evOrText?.location]
          .filter(Boolean)
          .join("\n");

  const m = text.match(/Type:\s*([a-z0-9_]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function isoDateUTC(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatUTC(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} UTC`;
}

function addHours(date, h) {
  return new Date(date.getTime() + h * 3600000);
}

function makeKey(prefix, ev, suffix) {
  const uid = ev?.uid || ev?.id || "no_uid";
  const day = isoDateUTC(new Date(ev.start));
  return `${prefix}_${uid}_${day}_${suffix}`;
}

async function fetchEvents() {
  const data = await ical.fromURL(ICS_URL);
  return Object.values(data).filter((e) => e?.type === "VEVENT");
}

function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(s / 86400);
  const hrs = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hrs) parts.push(`${hrs}h`);
  parts.push(`${mins}m`);
  return parts.join(" ");
}

/* ================= MESSAGES ================= */

function aooOpenMsg() {
  const role = getAooRoleMention();
  return role
    ? `AOO registration is opened, reach out to ${role} for registration!`
    : `AOO registration is opened. Reach out to the AOO team for registration!`;
}
function aooWarnMsg() {
  return `AOO registration will close soon, be sure you are registered!`;
}
function aooClosedMsg() {
  return `AOO registration closed`;
}

function mgeOpenMsg() {
  return `MGE registration is open, register in ${getMgeChannelMention()} channel, or reach out to ${getMgeRoleMention()} !`;
}
function mgeWarnMsg() {
  return `MGE registration closes in 24 hours, don’t forget to apply!`;
}
function mgeClosedMsg() {
  return `MGE registration is closed`;
}

/* ================= SCHEDULED REMINDERS ================= */

// We tag scheduled items with a "groupKey" so we can overwrite them later.
function schedulePing({ channelId, runAtMs, message, groupKey = null }) {
  const id = `${channelId}_${runAtMs}_${Math.random().toString(16).slice(2)}`;
  state.scheduled.push({ id, channelId, runAtMs, message, sent: false, groupKey });
  saveState();
}

// Remove pending scheduled items (used to overwrite old AOO selections)
function removeScheduledByGroupKey(groupKey) {
  if (!groupKey) return 0;
  const before = state.scheduled.length;
  state.scheduled = state.scheduled.filter((x) => x.sent || x.groupKey !== groupKey);
  const removed = before - state.scheduled.length;
  if (removed) saveState();
  return removed;
}

async function processScheduled(client) {
  const nowMs = Date.now();
  let changed = false;

  for (const item of state.scheduled) {
    if (item.sent) continue;
    if (nowMs < item.runAtMs) continue;

    try {
      const ch = await client.channels.fetch(item.channelId);
      if (ch && ch.isTextBased()) {
        await ch.send(item.message);
      }
    } catch (e) {
      console.error("Failed to send scheduled ping:", e);
    }

    item.sent = true;
    changed = true;
  }

  const before = state.scheduled.length;
  state.scheduled = state.scheduled.filter((x) => !x.sent);
  if (state.scheduled.length !== before) changed = true;

  if (changed) saveState();
}

/* ================= ANNOUNCEMENTS ================= */

let runCheckRunning = false;

async function runCheck(client) {
  if (runCheckRunning) return;
  runCheckRunning = true;

  try {
    const pingChannelId = getPingChannelId();
    if (!pingChannelId) return;

    const channel = await client.channels.fetch(pingChannelId);
    if (!channel?.isTextBased()) return;

    const now = new Date();
    const events = await fetchEvents();

    for (const ev of events) {
      const type = getEventType(ev);
      if (!type) continue;

      const start = new Date(ev.start);
      const end = new Date(ev.end);

      if (type === "ark_registration") {
        const openKey = makeKey("AOO_REG", ev, "open_at_start");
        const warnKey = makeKey("AOO_REG", ev, "6h_before_end");
        const closeKey = makeKey("AOO_REG", ev, "closed_at_end");
        const warnTime = addHours(end, -6);

        if (!state[openKey] && now >= start) {
          await channel.send(`${PING}\n${aooOpenMsg()}`);
          state[openKey] = true;
          saveState();
        }

        if (!state[warnKey] && now >= warnTime && now < end) {
          await channel.send(`${PING}\n${aooWarnMsg()}`);
          state[warnKey] = true;
          saveState();
        }

        if (!state[closeKey] && now >= end) {
          await channel.send(`${PING}\n${aooClosedMsg()}`);
          state[closeKey] = true;
          saveState();
        }
      }

      if (type === "mge") {
        const openKey = makeKey("MGE", ev, "open_24h_after_end");
        const warnKey = makeKey("MGE", ev, "48h_before_start_warn_close_24h");
        const closeKey = makeKey("MGE", ev, "closed_24h_before_start");

        const openTime = addHours(end, 24);
        const warnTime = addHours(start, -48);
        const closeTime = addHours(start, -24);

        if (!state[openKey] && now >= openTime) {
          await channel.send(`${PING}\n${mgeOpenMsg()}`);
          state[openKey] = true;
          saveState();
        }

        if (!state[warnKey] && now >= warnTime && now < closeTime) {
          await channel.send(`${PING}\n${mgeWarnMsg()}`);
          state[warnKey] = true;
          saveState();
        }

        if (!state[closeKey] && now >= closeTime && now < start) {
          await channel.send(`${PING}\n${mgeClosedMsg()}`);
          state[closeKey] = true;
          saveState();
        }
      }
    }
  } catch (e) {
    console.error("runCheck error:", e);
  } finally {
    runCheckRunning = false;
  }
}

/* ================= !aoo DROPDOWN FLOW ================= */

const AOO_TYPES = new Set(["ark_battle", "aoo"]);

async function getNextAooRunEvent() {
  const now = new Date();
  const events = await fetchEvents();

  const aoo = events
    .filter((ev) => AOO_TYPES.has(getEventType(ev)))
    .map((ev) => ({
      uid: ev.uid || ev.id || "no_uid",
      start: new Date(ev.start),
      end: new Date(ev.end),
    }))
    .filter((x) => x.end > now)
    .sort((a, b) => a.start - b.start);

  return aoo[0] || null;
}

function listUtcDatesInRange(start, end) {
  const dates = [];
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), 0, 0, 0));
  const endDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), 0, 0, 0));
  while (d < endDay) {
    dates.push(new Date(d.getTime()));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

function buildDateSelect({ startMs, endMs, dates }) {
  const options = dates.slice(0, 25).map((d) => ({
    label: isoDateUTC(d),
    value: isoDateUTC(d),
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`aoo_date|${startMs}|${endMs}`)
      .setPlaceholder("Select AOO date (UTC)")
      .addOptions(options)
  );
}

function buildHourSelect({ startMs, endMs, dateISO }) {
  const [yyyy, mm, dd] = dateISO.split("-").map((x) => Number(x));
  const options = [];

  for (let h = 0; h < 24; h++) {
    const t = Date.UTC(yyyy, mm - 1, dd, h, 0, 0, 0);
    if (t >= startMs && t < endMs) {
      options.push({ label: `${String(h).padStart(2, "0")}:00 UTC`, value: String(h) });
    }
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`aoo_hour|${startMs}|${endMs}|${dateISO}`)
      .setPlaceholder("Select AOO start hour (UTC)")
      .addOptions(options.length ? options : [{ label: "No valid hours", value: "none" }])
  );
}

/* ================= CLIENT ================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await runCheck(client);
  await processScheduled(client);

  setInterval(() => runCheck(client).catch(console.error), CHECK_EVERY_MINUTES * 60 * 1000);
  setInterval(() => processScheduled(client).catch(console.error), 30 * 1000);
});

/* ================= INTERACTIONS (AOO dropdown) ================= */

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isStringSelectMenu()) return;

    if (!canUseCommands(interaction.member)) {
      await interaction.reply({
        content: state.config.accessRoleId
          ? "❌ You don’t have permission to use this menu."
          : "❌ Access role not set yet. Only **Admins** can use this menu right now.",
        ephemeral: true,
      });
      return;
    }

    const id = interaction.customId || "";

    if (id.startsWith("aoo_date|")) {
      const [, startMsStr, endMsStr] = id.split("|");
      const startMs = Number(startMsStr);
      const endMs = Number(endMsStr);

      const dateISO = interaction.values?.[0];
      if (!dateISO) {
        await interaction.reply({ content: "No date selected.", ephemeral: true });
        return;
      }

      const hourRow = buildHourSelect({ startMs, endMs, dateISO });

      // ✅ This updates the SAME message (no spam)
      await interaction.update({
        content: `Selected date: **${dateISO}** (UTC)\nNow select the hour (UTC) you want AOO to start.`,
        components: [hourRow],
      });
      return;
    }

    if (id.startsWith("aoo_hour|")) {
      const parts = id.split("|");
      const startMs = Number(parts[1]);
      const endMs = Number(parts[2]);
      const dateISO = parts[3];

      const hourStr = interaction.values?.[0];
      if (!hourStr || hourStr === "none") {
        await interaction.reply({ content: "No valid hour selected.", ephemeral: true });
        return;
      }

      const hour = Number(hourStr);
      const [yyyy, mm, dd] = dateISO.split("-").map((x) => Number(x));
      const aooStartMs = Date.UTC(yyyy, mm - 1, dd, hour, 0, 0, 0);

      if (!(aooStartMs >= startMs && aooStartMs < endMs)) {
        await interaction.reply({ content: "That hour is outside the AOO event window. Try again.", ephemeral: true });
        return;
      }

      const nowMs = Date.now();
      const thirtyMs = aooStartMs - 30 * 60 * 1000;
      const tenMs = aooStartMs - 10 * 60 * 1000;

      const channelId = interaction.channelId;

      // ✅ OVERWRITE: remove previous AOO reminders by this user in this channel
      const groupKey = `aoo:${interaction.guildId}:${channelId}:${interaction.user.id}`;
      removeScheduledByGroupKey(groupKey);

      let scheduledCount = 0;

      if (thirtyMs > nowMs) {
        schedulePing({
          channelId,
          runAtMs: thirtyMs,
          groupKey,
          message: `${PING}\nAOO starts in **30 minutes** — get ready! (Start: ${formatUTC(new Date(aooStartMs))})`,
        });
        scheduledCount++;
      }

      if (tenMs > nowMs) {
        schedulePing({
          channelId,
          runAtMs: tenMs,
          groupKey,
          message: `${PING}\nAOO starts in **10 minutes** — be ready! (Start: ${formatUTC(new Date(aooStartMs))})`,
        });
        scheduledCount++;
      }

      const startText = formatUTC(new Date(aooStartMs));
      const note =
        scheduledCount === 0
          ? "Both reminder times are already in the past, so nothing was scheduled."
          : `Scheduled **${scheduledCount}** reminder(s). (Overwrote your previous AOO selection in this channel)`;

      await interaction.update({
        content: `✅ AOO start selected: **${startText}**\n${note}`,
        components: [],
      });
      return;
    }
  } catch (e) {
    console.error("Interaction error:", e);
    try {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: "Error handling selection.", ephemeral: true });
      }
    } catch {}
  }
});

/* ================= COMMANDS ================= */

client.on("messageCreate", async (msg) => {
  try {
    if (msg.author?.bot) return;
    if (!msg.guild) return;
    if (!msg.content?.startsWith(PREFIX)) return;

    const member = msg.member;
    if (!canUseCommands(member)) {
      return msg.reply(
        state.config.accessRoleId
          ? "❌ You don’t have permission to use this bot."
          : "❌ Access role not set yet. Only **Admins** can run setup commands right now."
      );
    }

    const content = msg.content.slice(PREFIX.length).trim();
    const [cmdRaw] = content.split(/\s+/);
    const cmd = (cmdRaw || "").toLowerCase();

    if (cmd === "set_access_role") {
      const role = msg.mentions.roles.first();
      if (!role) return msg.reply("Usage: `!set_access_role @role`");
      state.config.accessRoleId = role.id;
      saveState();
      return msg.reply(`✅ Access role set. Users with ${role} can use bot commands.`);
    }

    if (cmd === "set_ping_channel") {
      const ch = msg.mentions.channels.first();
      if (!ch) return msg.reply("Usage: `!set_ping_channel #channel`");
      state.config.pingChannelId = ch.id;
      saveState();
      return msg.reply(`✅ Ping/announcement channel set to ${ch}`);
    }

    if (cmd === "set_aoo_team_role") {
      const role = msg.mentions.roles.first();
      if (!role) return msg.reply("Usage: `!set_aoo_team_role @role`");
      state.config.aooTeamRoleId = role.id;
      saveState();
      return msg.reply(`✅ AOO Team role mention set to ${role}`);
    }

    if (cmd === "clear_aoo_team_role") {
      state.config.aooTeamRoleId = null;
      saveState();
      return msg.reply("✅ AOO Team role mention cleared (no role will be mentioned).");
    }

    if (cmd === "set_mge_channel") {
      const ch = msg.mentions.channels.first();
      if (!ch) return msg.reply("Usage: `!set_mge_channel #channel`");
      state.config.mgeChannelId = ch.id;
      saveState();
      return msg.reply(`✅ MGE channel set to ${ch}`);
    }

    if (cmd === "set_mge_role") {
      const role = msg.mentions.roles.first();
      if (!role) return msg.reply("Usage: `!set_mge_role @role`");
      state.config.mgeRoleId = role.id;
      saveState();
      return msg.reply(`✅ MGE role set to ${role}`);
    }

    if (cmd === "show_config") {
      const lines = [
        "Current config:",
        `Ping channel: ${state.config.pingChannelId ? `<#${state.config.pingChannelId}>` : "NOT SET"}`,
        `Access role: ${state.config.accessRoleId ? `<@&${state.config.accessRoleId}>` : "NOT SET (Admins only bootstrap)"}`,
        `AOO Team role: ${state.config.aooTeamRoleId ? `<@&${state.config.aooTeamRoleId}>` : "NOT SET"}`,
        `MGE channel: ${state.config.mgeChannelId ? `<#${state.config.mgeChannelId}>` : "NOT SET"}`,
        `MGE role: ${state.config.mgeRoleId ? `<@&${state.config.mgeRoleId}>` : "NOT SET"}`,
        `Scheduled reminders: ${(state.scheduled || []).filter(x => !x.sent).length}`,
      ];
      return msg.reply("```" + lines.join("\n") + "```");
    }

    // ✅ FIXED: scheduled list command
    if (cmd === "scheduled_list") {
      const nowMs = Date.now();
      const items = (state.scheduled || [])
        .filter((x) => !x.sent)
        .sort((a, b) => a.runAtMs - b.runAtMs);

      if (!items.length) return msg.reply("No scheduled reminders right now.");

      const lines = [];
      lines.push(`Scheduled reminders: ${items.length}`);
      lines.push("");

      const limited = items.slice(0, 40);
      for (let i = 0; i < limited.length; i++) {
        const it = limited[i];
        const when = new Date(it.runAtMs);
        const inTxt = formatDuration(it.runAtMs - nowMs);
        const preview = String(it.message || "").replace(/\n/g, " ").slice(0, 120);
        lines.push(
          `${i + 1}) ${formatUTC(when)} (in ${inTxt}) — ${preview}${preview.length === 120 ? "…" : ""}`
        );
      }

      if (items.length > limited.length) {
        lines.push("");
        lines.push(`(Showing first ${limited.length} of ${items.length})`);
      }

      return msg.reply("```" + lines.join("\n") + "```");
    }

    if (cmd === "ping") return msg.reply("pong");

    if (cmd === "aoo") {
      const aoo = await getNextAooRunEvent();
      if (!aoo) {
        return msg.reply(
          "No upcoming/ongoing AOO run event found. Make sure the calendar event has `Type: ark_battle` (or `Type: aoo`)."
        );
      }

      const startMs = aoo.start.getTime();
      const endMs = aoo.end.getTime();
      const dates = listUtcDatesInRange(aoo.start, aoo.end);

      if (!dates.length) return msg.reply("AOO event has no selectable dates (check start/end).");

      const dateRow = buildDateSelect({ startMs, endMs, dates });

      return msg.reply({
        content:
          `AOO event window (UTC): **${formatUTC(aoo.start)}** → **${formatUTC(aoo.end)}**\n` +
          `Select the date you want for the AOO start time:`,
        components: [dateRow],
      });
    }

    return msg.reply(`Unknown command. Try \`${PREFIX}show_config\``);
  } catch (e) {
    console.error("Command error:", e);
    try {
      await msg.reply("Error while processing command.");
    } catch {}
  }
});

client.login(DISCORD_TOKEN);
