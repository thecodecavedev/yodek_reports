// Pulls the support summary figures from Intercom and writes site/data.json.
// Runs inside GitHub Actions (Node 20+, no dependencies). The token comes from
// the INTERCOM_TOKEN repository secret and never reaches the published page.
//
//   INTERCOM_TOKEN=... node scripts/fetch-data.mjs
//
// Optional environment variables:
//   INTERCOM_REGION   us | eu | au        (default us)
//   HIDE_CUSTOMERS    "true" to publish customer counts without names

import { writeFile, mkdir } from "node:fs/promises";

const HOSTS = { us: "https://api.intercom.io", eu: "https://api.eu.intercom.io", au: "https://api.au.intercom.io" };
const BASE = HOSTS[process.env.INTERCOM_REGION || "us"];
const TOKEN = process.env.INTERCOM_TOKEN;
const HIDE_CUSTOMERS = process.env.HIDE_CUSTOMERS === "true";
const OUT = new URL("../site/data.json", import.meta.url);

const ATTR_PRIORITY = "Priority Level";
const ATTR_CUSTOMER = "Customer";
const PRIORITIES = ["Critical", "High", "Medium"];
// The search API can return Customer truncated. Map prefixes to full names.
const CUSTOMER_NAMES = {
  "The Luke Comm": "The Luke Commission",
  "Eswatini Rail": "Eswatini Railways",
  "Circle of Ho": "Circle of Hope",
  "Project Cana": "Project Canaan",
};

if (!TOKEN) {
  console.error("INTERCOM_TOKEN is not set");
  process.exit(1);
}

// ------------------------------------------------------------- API helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body, attempt = 0) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Intercom-Version": "2.11",
    },
    body: JSON.stringify(body),
  });
  if (res.status === 429 && attempt < 5) {          // rate limited: back off
    await sleep(2 ** attempt * 5000);
    return post(path, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`Intercom ${res.status} on ${path}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const count = async (query, path = "/conversations/search") =>
  (await post(path, { query, pagination: { per_page: 1 } })).total_count;

async function all(query, path = "/conversations/search", key = "conversations") {
  const rows = [];
  let cursor;
  do {
    const pagination = { per_page: 150, ...(cursor && { starting_after: cursor }) };
    const data = await post(path, { query, pagination });
    rows.push(...(data[key] || []));
    cursor = data.pages?.next?.starting_after;
  } while (cursor);
  return rows;
}

const q = (field, operator, value) => ({ field, operator, value });
const allOf = (...value) => ({ operator: "AND", value });
// Intercom search has no >=, so "since midnight" is "> midnight minus 1 second".
const since = (field, epoch) => q(field, ">", epoch - 1);

// ------------------------------------------------------------- SAST dates
// South Africa is UTC+2 all year (no daylight saving), so a fixed offset is exact.
const SAST_MS = 2 * 3600 * 1000;
function sastDay(daysAgo) {
  const d = new Date(Date.now() + SAST_MS);            // shift so UTC fields read as SAST
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return { epoch: (d.getTime() - SAST_MS) / 1000, date: d };
}
const dayName = (d) => d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
const dayLabel = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

// ------------------------------------------------------------- field readers
const text = (v) => (v && typeof v === "object" ? v.name || v.value || "" : v || "");
const ticketType = (c) => text(c.ticket?.ticket_type).trim() || "Not Defined";
function customerName(c) {
  const raw = text(c.custom_attributes?.[ATTR_CUSTOMER]).trim();
  if (!raw) return "Unspecified";
  const hit = Object.keys(CUSTOMER_NAMES).find((p) => raw.startsWith(p));
  return hit ? CUSTOMER_NAMES[hit] : raw;
}
function priorityOf(c) {
  const raw = text(c.custom_attributes?.[ATTR_PRIORITY]).toLowerCase();
  return PRIORITIES.find((p) => raw.includes(p.toLowerCase())) || null;
}
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ------------------------------------------------------------- the pull
async function pull() {
  const nowSec = Math.floor(Date.now() / 1000);
  const b = Array.from({ length: 28 }, (_, n) => sastDay(n));
  const created = (epoch) => count(since("created_at", epoch));
  const closed = (epoch) => count(allOf(q("state", "=", "closed"), since("statistics.last_close_at", epoch)));

  // Cumulative "since day N" counts; each day is the difference of two.
  const newCum = [], resCum = [];
  for (let n = 0; n < 7; n++) {
    newCum.push(await created(b[n].epoch));
    resCum.push(await closed(b[n].epoch));
  }
  const byDay = [];
  for (let n = 6; n >= 0; n--) {
    byDay.push({
      day: dayName(b[n].date), date: dayLabel(b[n].date),
      new: newCum[n] - (n ? newCum[n - 1] : 0),
      resolved: resCum[n] - (n ? resCum[n - 1] : 0),
    });
  }

  let waiting = null;
  try {
    waiting = await count(q("state", "=", "waiting_on_customer"), "/tickets/search");
  } catch (e) {
    console.warn("waiting-on-customer count failed:", e.message);
  }

  // Native Intercom first response: median time_to_admin_reply, past 7 days.
  const week = await all(since("created_at", b[6].epoch));
  const replies = week.map((c) => c.statistics?.time_to_admin_reply).filter(Boolean);

  // One pass over every open conversation feeds priority, type and customer.
  const open = await all(q("state", "=", "open"));
  const pri = {}, types = {}, cust = {};
  for (const c of open) {
    const p = priorityOf(c);
    if (p) pri[p] = (pri[p] || 0) + 1;
    const t = ticketType(c);
    types[t] = (types[t] || 0) + 1;
    const name = customerName(c);
    const slot = (cust[name] ||= { count: 0, ageSum: 0 });
    slot.count += 1;
    slot.ageSum += (nowSec - c.created_at) / 86400;
  }

  let customers = Object.entries(cust)
    .map(([customer, v]) => ({ customer, count: v.count, avg_days: v.ageSum / v.count }))
    .sort((x, y) => y.count - x.count);
  if (HIDE_CUSTOMERS) customers = customers.map((r, i) => ({ ...r, customer: `Customer ${i + 1}` }));

  return {
    snapshot_epoch: nowSec,
    open_total: open.length,
    waiting_on_customer: waiting,
    opened_4w: await created(b[27].epoch),
    resolved_4w: await closed(b[27].epoch),
    new_today: newCum[0],
    new_yesterday: newCum[1] - newCum[0],
    resolved_today: resCum[0],
    resolved_yesterday: resCum[1] - resCum[0],
    frt: { median_sec: median(replies), answered: replies.length, total: week.length },
    by_day: byDay,
    priority: PRIORITIES.map((label) => ({ label, count: pri[label] || 0 })),
    types: Object.entries(types)
      .map(([type, n]) => ({ type, count: n }))
      .sort((x, y) => (x.type === "Not Defined") - (y.type === "Not Defined") || y.count - x.count),
    customers,
  };
}

const data = await pull();
await mkdir(new URL("../site/", import.meta.url), { recursive: true });
await writeFile(OUT, JSON.stringify(data, null, 2));
console.log(`wrote site/data.json: ${data.open_total} open, ${data.new_today} new today`);
