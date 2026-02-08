import { Client, GatewayIntentBits } from "discord.js";
import ical from "node-ical";
import fs from "fs";
import path from "path";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ICS_URL = process.env.ICS_URL;

const PING = process.env.PING_TEXT ?? "@everyone";
const CHECK_EVERY_MINUTES = Number(process.env.CHECK_EVERY_MINUTES ?? "10");

if (!DISCORD_TOKEN || !CHANNEL_ID || !ICS_URL) {
  console.error("Missing env vars: DISCORD_TOKEN, CHANNEL_ID, ICS_URL");
  process.exit(1);
}

const stateFile = path.resolve("./state.json");
const state = loadState();

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}
function saveState() {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function getEventType(description = "") {
  const m = description.match(/Type:\s*([a-z_]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function isoDateUTC(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function hoursBetween(a, b) {
  return (b.getTime() - a.getTime()) / (1000 * 60 * 60);
}

async function fetchEvents() {
  const data = await ical.fromURL(ICS_URL);
  return Object.values(data).filter((e) => e?.type === "VEVENT");
}

function makeKey(prefix, ev, suffix) {
  const uid = ev.uid || "no_uid";
  const day = isoDateUTC(ev.start);
  return `${prefix}_${uid}_${day}_${suffix}`;
}

async function runCheck(client) {
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel || !channel.isTextBased()) {
    console.error("Channel not found or not text-based.");
    return;
  }

  const now = new Date(); // UTC-safe comparisons using timestamps
  const events = await fetchEvents();

  for (const ev of events) {
    const eventType = getEventType(ev.description || "");
    if (!eventType) continue;

    // Calendar uses VALUE=DATE events (all-day). Start/end are UTC midnight boundaries. :contentReference[oaicite:1]{index=1}
    const start = new Date(ev.start);
    const end = new Date(ev.end);

    // 1) AOO Registration: Type = ark_registration
    if (eventType === "ark_registration") {
      const openKey = makeKey("AOO", ev, "open");
      const warnKey = makeKey("AOO", ev, "24h_before_end");

      // at start
      if (!state[openKey] && now >= start) {
        await channel.send(
          `${PING}\nAOO registration is open! Reach out to AOO team to apply.`
        );
        state[openKey] = true;
        saveState();
      }

      // 24h before end
      const hoursToEnd = hoursBetween(now, end);
      if (!state[warnKey] && hoursToEnd <= 24 && hoursToEnd > 0) {
        await channel.send(
          `${PING}\nAOO registration ends in 1 day — don’t forget to register!`
        );
        state[warnKey] = true;
        saveState();
      }
    }

    // 2) MGE: Type = mge
    if (eventType === "mge") {
      const openKey = makeKey("mge", ev, "open_after_end");
      const closeKey = makeKey("mge", ev, "closed_24h_before_start");

      // at end => registration open
      if (!state[openKey] && now >= end) {
        await channel.send(
  `${PING}\nMGE registration is open! Reach out to <#1469846200042917918> channel for registration!`
);

        state[openKey] = true;
        saveState();
      }

      // 24h before start => registration closed
      const hoursToStart = hoursBetween(now, start);
      if (!state[closeKey] && hoursToStart <= 24 && hoursToStart > 0) {
        await channel.send(`${PING}\nMGE registration is now closed.`);
        state[closeKey] = true;
        saveState();
      }
    }

    // 3) 20 Gold Head Event: Type = goldhead
    if (eventType === "goldhead") {
      const warnKey = makeKey("goldhead", ev, "24h_before_start");
      const hoursToStart = hoursBetween(now, start);

      if (!state[warnKey] && hoursToStart <= 24 && hoursToStart > 0) {
        await channel.send(
          `${PING}\n20 Gold Head Event starts in 1 day — get ready!`
        );
        state[warnKey] = true;
        saveState();
      }
    }
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await runCheck(client);
  setInterval(() => runCheck(client).catch(console.error), CHECK_EVERY_MINUTES * 60 * 1000);
});

client.login(DISCORD_TOKEN);


