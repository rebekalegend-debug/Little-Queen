// index.js
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import ical from "node-ical";
import fs from "fs";
import path from "path";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ICS_URL = process.env.ICS_URL;

const PING = process.env.PING_TEXT ?? "@everyone";
const CHECK_EVERY_MINUTES = Number(process.env.CHECK_EVERY_MINUTES ?? "10");

// Prefix commands
const PREFIX = process.env.PREFIX ?? "!";

// ✅ Role restriction (you gave the ID)
const AOO_ROLE_ID = process.env.AOO_ROLE_ID ?? "1470120925856006277";

// ✅ MGE channel mention (use env var if you set it; fallback to your ID)
const MGE_CHANNEL_ID = process.env.MGE_CHANNEL_ID ?? "1469846200042917918";
const MGE_CHANNEL_MENTION = `<#${MGE_CHANNEL_ID}>`;

// Persistent state (mount Railway Volume at /data)
const STATE_DIR = process.env.STATE_DIR ?? "/data";
const stateFile = path.resolve(STATE_DIR, "state.json");

if (!DISCORD_TOKEN || !CHANNEL_ID || !ICS_URL) {
  console.error("Missing env vars: DISCORD_TOKEN, CHANNEL_ID, ICS_URL");
  process.exit(1);
}

ensureStateDir();
const state = loadState();
state.scheduled ??= []; // scheduled pings storage

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

// ✅ role guard
function hasAooRole(member) {
  return member?.roles?.cache?.has(AOO_ROLE_ID);
}

// ✅ Robust: accepts either an event object or a string.
// Reads description + summary + location to find "Type: xyz"
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

function addMonthsUTC(date, months) {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

async function fetchEvents() {
  const data = await ical.fromURL(ICS_URL);
  return Object.values(data).filter((e) => e?.type === "VEVENT");
}

function makeKey(prefix, ev, suffix) {
  const uid = ev.uid || "no_uid";
  const day = isoDateUTC(new Date(ev.start));
  return `${prefix}_${uid}_${day}_${suffix}`;
}

// =================== Scheduled pings (AOO reminders via !aoo dropdown) ===================

function schedulePing({ channelId, runAtMs, message }) {
  const id = `${channelId}_${runAtMs}_${Math.random().toString(16).slice(2)}`;
  state.scheduled.push({
    id,
    channelId,
    runAtMs,
    message,
    sent: false,
  });
  saveState();
}

async function processScheduled(client, { silent = false } = {}) {
  const nowMs = Date.now();
  let changed = false;

  for (const item of state.scheduled) {
    if (item.sent) continue;

    if (nowMs >= item.runAtMs) {
      if (!silent) {
        try {
          const ch = await client.channels.fetch(item.channelId);
          if (ch && ch.isTextBased()) {
            await ch.send(item.message);
          }
        } catch (e) {
          console.error("Failed to send scheduled ping:", e);
        }
      }

      item.sent = true;
      changed = true;
    }
  }

  const before = state.scheduled.length;
  state.scheduled = state.scheduled.filter((x) => !x.sent);
  if (state.scheduled.length !== before) changed = true;

  if (changed) saveState();
}

// ✅ scheduled list helpers
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

function chunkReplyLines(lines, maxLen = 1800) {
  const chunks = [];
  let cur = "";
  for (const line of lines) {
    if ((cur + line + "\n").length > maxLen) {
      chunks.push(cur.trimEnd());
      cur = "";
    }
    cur += line + "\n";
  }
  if (cur.trim().length) chunks.push(cur.trimEnd());
  return chunks;
}

// =================== Announcement logic (MODIFIED per your rules) ===================

async function runCheck(client, { silent = false } = {}) {
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel || !channel.isTextBased()) {
    console.error("Channel not found or not text-based.");
    return;
  }

  const now = new Date();
  const events = await fetchEvents();

  for (const ev of events) {
    const eventType = getEventType(ev);
    if (!eventType) continue;

    const start = new Date(ev.start);
    const end = new Date(ev.end);

    // -------------------------
    // AOO Registration (ark_registration)
    // -------------------------
    if (eventType === "ark_registration") {
      const openKey = makeKey("AOO_REG", ev, "open_at_start");
      const warnKey = makeKey("AOO_REG", ev, "6h_before_end");
      const closeKey = makeKey("AOO_REG", ev, "closed_at_end");

      const warnTime = addHours(end, -6);

      if (!state[openKey] && now >= start) {
        if (!silent) {
          await channel.send(
            `${PING}\nAOO registration is opened, reach out to AOO team for registration!`
          );
        }
        state[openKey] = true;
        saveState();
      }

      if (!state[warnKey] && now >= warnTime && now < end) {
        if (!silent) {
          await channel.send(
            `${PING}\nAOO registration will close soon, be sure you are registered!`
          );
        }
        state[warnKey] = true;
        saveState();
      }

      if (!state[closeKey] && now >= end) {
        if (!silent) {
          await channel.send(`${PING}\nAOO registration closed`);
        }
        state[closeKey] = true;
        saveState();
      }
    }

    // -------------------------
    // MGE (mge)
    // -------------------------
    if (eventType === "mge") {
      const openKey = makeKey("MGE", ev, "open_24h_after_end");
      const warnKey = makeKey("MGE", ev, "48h_before_start_warn_close_24h");
      const closeKey = makeKey("MGE", ev, "closed_24h_before_start");

      const openTime = addHours(end, 24);
      const warnTime = addHours(start, -48);
      const closeTime = addHours(start, -24);

      if (!state[openKey] && now >= openTime) {
        if (!silent) {
          await channel.send(
            `${PING}\nMGE registraton is open, register in ${MGE_CHANNEL_MENTION} channel, or reach out to mge team!`
          );
        }
        state[openKey] = true;
        saveState();
      }

      if (!state[warnKey] && now >= warnTime && now < closeTime) {
        if (!silent) {
          await channel.send(
            `${PING}\nMGE registration closes in 24 hours , dont forget to apply!`
          );
        }
        state[warnKey] = true;
        saveState();
      }

      if (!state[closeKey] && now >= closeTime && now < start) {
        if (!silent) {
          await channel.send(`${PING}\nMGE registration is closed`);
        }
        state[closeKey] = true;
        saveState();
      }
    }
  }
}

// ---------- Prefix command helpers ----------

async function getNextEventOfType(type) {
  const now = new Date();
  const events = await fetchEvents();

  const typed = events
    .filter((ev) => getEventType(ev) === type)
    .map((ev) => ({ ev, start: new Date(ev.start), end: new Date(ev.end) }))
    .filter((x) => x.start > now)
    .sort((a, b) => a.start - b.start);

  return typed[0] || null;
}

async function getNextAnnouncementTime() {
  const now = new Date();
  const events = await fetchEvents();
  const candidates = [];

  for (const ev of events) {
    const eventType = getEventType(ev);
    if (!eventType) continue;

    const start = new Date(ev.start);
    const end = new Date(ev.end);

    if (eventType === "ark_registration") {
      const openKey = makeKey("AOO_REG", ev, "open_at_start");
      const warnKey = makeKey("AOO_REG", ev, "6h_before_end");
      const closeKey = makeKey("AOO_REG", ev, "closed_at_end");

      const warnTime = addHours(end, -6);

      if (!state[openKey] && start > now) {
        candidates.push({
          when: start,
          text: "AOO registration is opened, reach out to AOO team for registration!",
          key: openKey,
        });
      }

      if (!state[warnKey] && warnTime > now) {
        candidates.push({
          when: warnTime,
          text: "AOO registration will close soon, be sure you are registered!",
          key: warnKey,
        });
      }

      if (!state[closeKey] && end > now) {
        candidates.push({
          when: end,
          text: "AOO registration closed",
          key: closeKey,
        });
      }
    }

    if (eventType === "mge") {
      const openKey = makeKey("MGE", ev, "open_24h_after_end");
      const warnKey = makeKey("MGE", ev, "48h_before_start_warn_close_24h");
      const closeKey = makeKey("MGE", ev, "closed_24h_before_start");

      const openTime = addHours(end, 24);
      const warnTime = addHours(start, -48);
      const closeTime = addHours(start, -24);

      if (!state[openKey] && openTime > now) {
        candidates.push({
          when: openTime,
          text: `MGE registraton is open, register in ${MGE_CHANNEL_MENTION} channel, or reach out to mge team!`,
          key: openKey,
        });
      }

      if (!state[warnKey] && warnTime > now) {
        candidates.push({
          when: warnTime,
          text: "MGE registration closes in 24 hours , dont forget to apply!",
          key: warnKey,
        });
      }

      if (!state[closeKey] && closeTime > now) {
        candidates.push({
          when: closeTime,
          text: "MGE registration is closed",
          key: closeKey,
        });
      }
    }
  }

  candidates.sort((a, b) => a.when - b.when);
  return candidates[0] || null;
}

async function getAnnouncementsInNextMonths(months = 2) {
  const now = new Date();
  const until = addMonthsUTC(now, months);
  const events = await fetchEvents();
  const out = [];

  for (const ev of events) {
    const eventType = getEventType(ev);
    if (!eventType) continue;

    const start = new Date(ev.start);
    const end = new Date(ev.end);

    if (eventType === "ark_registration") {
      const openKey = makeKey("AOO_REG", ev, "open_at_start");
      const warnKey = makeKey("AOO_REG", ev, "6h_before_end");
      const closeKey = makeKey("AOO_REG", ev, "closed_at_end");

      const warnTime = addHours(end, -6);

      if (!state[openKey] && start >= now && start <= until) {
        out.push({
          when: start,
          text: "AOO registration is opened, reach out to AOO team for registration!",
          key: openKey,
        });
      }

      if (!state[warnKey] && warnTime >= now && warnTime <= until) {
        out.push({
          when: warnTime,
          text: "AOO registration will close soon, be sure you are registered!",
          key: warnKey,
        });
      }

      if (!state[closeKey] && end >= now && end <= until) {
        out.push({
          when: end,
          text: "AOO registration closed",
          key: closeKey,
        });
      }
    }

    if (eventType === "mge") {
      const openKey = makeKey("MGE", ev, "open_24h_after_end");
      const warnKey = makeKey("MGE", ev, "48h_before_start_warn_close_24h");
      const closeKey = makeKey("MGE", ev, "closed_24h_before_start");

      const openTime = addHours(end, 24);
      const warnTime = addHours(start, -48);
      const closeTime = addHours(start, -24);

      if (!state[openKey] && openTime >= now && openTime <= until) {
        out.push({
          when: openTime,
          text: `MGE registraton is open, register in ${MGE_CHANNEL_MENTION} channel, or reach out to mge team!`,
          key: openKey,
        });
      }

      if (!state[warnKey] && warnTime >= now && warnTime <= until) {
        out.push({
          when: warnTime,
          text: "MGE registration closes in 24 hours , dont forget to apply!",
          key: warnKey,
        });
      }

      if (!state[closeKey] && closeTime >= now && closeTime <= until) {
        out.push({
          when: closeTime,
          text: "MGE registration is closed",
          key: closeKey,
        });
      }
    }
  }

  out.sort((a, b) => a.when - b.when);

  const seen = new Set();
  const deduped = [];
  for (const x of out) {
    if (seen.has(x.key)) continue;
    seen.add(x.key);
    deduped.push(x);
  }

  return { items: deduped, until };
}

// =================== AOO dropdown flow (KEEPED) ===================

// ✅ IMPORTANT: your calendar uses Type: ark_battle for Ark of Osiris
const AOO_TYPES = new Set(["ark_battle", "aoo"]);

async function getNextAooRunEvent() {
  const now = new Date();
  const events = await fetchEvents();

  const aoo = events
    .filter((ev) => AOO_TYPES.has(getEventType(ev)))
    .map((ev) => ({
      uid: ev.uid || "no_uid",
      start: new Date(ev.start),
      end: new Date(ev.end),
    }))
    .filter((x) => x.end > now)
    .sort((a, b) => a.start - b.start);

  return aoo[0] || null;
}

function listUtcDatesInRange(start, end) {
  const dates = [];
  const d = new Date(
    Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth(),
      start.getUTCDate(),
      0,
      0,
      0
    )
  );
  const endDay = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), 0, 0, 0)
  );

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
      options.push({
        label: `${String(h).padStart(2, "0")}:00 UTC`,
        value: String(h),
      });
    }
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`aoo_hour|${startMs}|${endMs}|${dateISO}`)
      .setPlaceholder("Select AOO start hour (UTC)")
      .addOptions(
        options.length ? options : [{ label: "No valid hours", value: "none" }]
      )
  );
}

function helpText() {
  return [
    `Commands (prefix: ${PREFIX})`,
    `- ${PREFIX}mge_start -> shows next MGE start time (UTC)`,
    `- ${PREFIX}next_announcement -> shows next scheduled announcement time (UTC)`,
    `- ${PREFIX}announcements_2m -> lists all announcements for next 2 months (UTC)`,
    `- ${PREFIX}aoo -> dropdown: pick AOO date + hour, schedules 30m/10m pings`,
    `- ${PREFIX}scheduled_list -> shows scheduled reminders (UTC)`,
    `- ${PREFIX}ping -> bot health check`,
    `- ${PREFIX}help -> this list`,
  ].join("\n");
}

// =================== Discord client ===================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await runCheck(client, { silent: true });
  await processScheduled(client, { silent: true });

  await runCheck(client, { silent: false });

  setInterval(
    () => runCheck(client, { silent: false }).catch(console.error),
    CHECK_EVERY_MINUTES * 60 * 1000
  );

  setInterval(
    () => processScheduled(client, { silent: false }).catch(console.error),
    30 * 1000
  );
});

// Handle dropdown interactions (select menus)
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isStringSelectMenu()) return;

    // 🔒 Role check for dropdowns
    const member = interaction.member;
    if (!hasAooRole(member)) {
      await interaction.reply({
        content: "❌ You need the **AOO role** to use this menu.",
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
        await interaction.reply({
          content: "That hour is outside the AOO event window. Try again.",
          ephemeral: true,
        });
        return;
      }

      const nowMs = Date.now();
      const thirtyMs = aooStartMs - 30 * 60 * 1000;
      const tenMs = aooStartMs - 10 * 60 * 1000;

      const channelId = interaction.channelId;
      let scheduledCount = 0;

      if (thirtyMs > nowMs) {
        schedulePing({
          channelId,
          runAtMs: thirtyMs,
          message: `${PING}\nAOO starts in **30 minutes** — get ready! (Start: ${formatUTC(
            new Date(aooStartMs)
          )})`,
        });
        scheduledCount++;
      }

      if (tenMs > nowMs) {
        schedulePing({
          channelId,
          runAtMs: tenMs,
          message: `${PING}\nAOO starts in **10 minutes** — be ready! (Start: ${formatUTC(
            new Date(aooStartMs)
          )})`,
        });
        scheduledCount++;
      }

      const startText = formatUTC(new Date(aooStartMs));
      const note =
        scheduledCount === 0
          ? "Both reminder times are already in the past, so nothing was scheduled."
          : `Scheduled **${scheduledCount}** reminder(s).`;

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

client.on("messageCreate", async (msg) => {
  try {
    if (msg.author?.bot) return;
    if (!msg.guild) return;
    if (!msg.content?.startsWith(PREFIX)) return;

    // 🔒 Role check for all prefix commands
    if (!hasAooRole(msg.member)) {
      await msg.reply({
        content: "❌ You need the **AOO role** to use this command.",
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    const content = msg.content.slice(PREFIX.length).trim();
    const [cmdRaw] = content.split(/\s+/);
    const cmd = (cmdRaw || "").toLowerCase();

    if (cmd === "ping") {
      await msg.reply("pong");
      return;
    }

    if (cmd === "help") {
      await msg.reply("```" + helpText() + "```");
      return;
    }

    if (cmd === "mge_start") {
      const next = await getNextEventOfType("mge");
      if (!next) {
        await msg.reply("No upcoming MGE event found in the calendar.");
        return;
      }
      await msg.reply(`Next MGE starts at **${formatUTC(next.start)}**.`);
      return;
    }

    if (cmd === "next_announcement") {
      const next = await getNextAnnouncementTime();
      if (!next) {
        await msg.reply("No upcoming announcements found (based on calendar + current state).");
        return;
      }
      await msg.reply(`Next announcement: **${next.text}** at **${formatUTC(next.when)}**.`);
      return;
    }

    if (cmd === "announcements_2m") {
      const { items, until } = await getAnnouncementsInNextMonths(2);

      if (!items.length) {
        await msg.reply("No upcoming announcements in the next 2 months (based on calendar + current state).");
        return;
      }

      const header = `Upcoming announcements (UTC) until ${formatUTC(until)}:\n`;
      const lines = items.map((x, i) => `${i + 1}) ${formatUTC(x.when)} — ${x.text}`);

      const chunks = chunkReplyLines([header.trimEnd(), ...lines], 1800);
      for (const c of chunks) {
        await msg.reply("```" + c + "```");
      }
      return;
    }

    if (cmd === "scheduled_list") {
      const nowMs = Date.now();
      const items = (state.scheduled || [])
        .filter((x) => !x.sent)
        .sort((a, b) => a.runAtMs - b.runAtMs);

      if (!items.length) {
        await msg.reply("No scheduled reminders right now.");
        return;
      }

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

      const chunks = chunkReplyLines(lines, 1800);
      for (const c of chunks) {
        await msg.reply("```" + c + "```");
      }
      return;
    }

    if (cmd === "aoo") {
      const aoo = await getNextAooRunEvent();
      if (!aoo) {
        await msg.reply(
          "No upcoming/ongoing AOO run event found. Make sure the calendar event has `Type: ark_battle` (or `Type: aoo`)."
        );
        return;
      }

      const startMs = aoo.start.getTime();
      const endMs = aoo.end.getTime();

      const dates = listUtcDatesInRange(aoo.start, aoo.end);
      if (!dates.length) {
        await msg.reply("AOO event has no selectable dates (check start/end).");
        return;
      }

      const dateRow = buildDateSelect({ startMs, endMs, dates });

      await msg.reply({
        content:
          `AOO event window (UTC): **${formatUTC(aoo.start)}** → **${formatUTC(aoo.end)}**\n` +
          `Select the date you want for the AOO start time:`,
        components: [dateRow],
      });

      return;
    }

    await msg.reply(`Unknown command. Try \`${PREFIX}help\``);
  } catch (e) {
    console.error("Command error:", e);
    try {
      await msg.reply("Error while processing command.");
    } catch {}
  }
});

client.login(DISCORD_TOKEN);

