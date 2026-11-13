// Pulls the support figures from Intercom and writes, next to this script:
//   data.json          screen 1, the support summary   (index.html)
//   satisfaction.json  screen 3, customer satisfaction (satisfaction.html)
// Runs inside GitHub Actions (Node 20+, no dependencies). The token comes from
// the INTERCOM_TOKEN repository secret and never reaches the published pages.
//
//   INTERCOM_TOKEN=... node ./fetch-data.mjs
//
// Optional environment variables:
//   INTERCOM_REGION   us | eu | au        (default us)
//   HIDE_CUSTOMERS    "true" to publish counts without customer names
//   SHOW_TITLES       "false" to hide ticket titles on the satisfaction page (default shown)
//   SHOW_COMMENTS     "true" to publish customers' rating comments (default hidden,
//                     because the pages are public and comments can mention patients)

import { writeFile } from "node:fs/promises";

const HOSTS = { us: "https://api.intercom.io", eu: "https://api.eu.intercom.io", au: "https://api.au.intercom.io" };
const BASE = HOSTS[process.env.INTERCOM_REGION || "us"];
const TOKEN = process.env.INTERCOM_TOKEN;
const HIDE_CUSTOMERS = process.env.HIDE_CUSTOMERS === "true";
const OUT = new URL("./data.json", import.meta.url);
const OUT_SAT = new URL("./satisfaction.json", import.meta.url);
const SHOW_TITLES = process.env.SHOW_TITLES !== "false";
const SHOW_COMMENTS = process.env.SHOW_COMMENTS === "true";

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

async function get(path, attempt = 0) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json", "Intercom-Version": "2.11" },
  });
  if (res.status === 429 && attempt < 5) { await sleep(2 ** attempt * 5000); return get(path, attempt + 1); }
  if (!res.ok) throw new Error(`Intercom ${res.status} on ${path}`);
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
async function pull(keep) {
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
  // Opened in the past 7 days and still open, by ticket type.
  const types7 = {};
  for (const c of week) {
    if (c.state !== "open") continue;
    const t = ticketType(c);
    types7[t] = (types7[t] || 0) + 1;
  }

  // One pass over every open conversation feeds priority, type and customer.
  const open = await all(q("state", "=", "open"));
  keep.open = open;
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
    types_7d: Object.entries(types7)
      .map(([type, n]) => ({ type, count: n }))
      .sort((x, y) => (x.type === "Not Defined") - (y.type === "Not Defined") || y.count - x.count),
    types: Object.entries(types)
      .map(([type, n]) => ({ type, count: n }))
      .sort((x, y) => (x.type === "Not Defined") - (y.type === "Not Defined") || y.count - x.count),
    customers,
  };
}

// ------------------------------------------------------------- satisfaction
// Monday 00:00 SAST of the current week.
function weekStart() {
  const d = new Date(Date.now() + SAST_MS);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return (d.getTime() - SAST_MS) / 1000;
}

// A short, teammate-written title. Never the customer's message body, which
// would put customer-authored text (possibly about patients) on a public page.
function ticketTitle(c) {
  const t = (c.ticket?.custom_attributes?._default_title_?.value || c.title || "").trim();
  return t ? t.slice(0, 90) : "";
}

// The search API may leave out conversation_rating. If it does, read each
// conversation individually (5 at a time) to get it.
async function withRatings(convs) {
  if (!convs.length || convs.some((c) => "conversation_rating" in c)) return convs;
  const out = [];
  for (let i = 0; i < convs.length; i += 5) {
    out.push(...await Promise.all(convs.slice(i, i + 5).map((c) => get(`/conversations/${c.id}`).catch(() => c))));
  }
  return out;
}

async function pullSatisfaction(open) {
  const nowSec = Math.floor(Date.now() / 1000);
  const wk = weekStart(), m4 = nowSec - 28 * 86400;
  // Leaving a rating updates the conversation, so this catches every rating of the last 4 weeks.
  // Rating search filters are unreliable, so ratings are read from each conversation instead.
  const recent = await withRatings(await all(since("updated_at", m4)));

  const rated = [], requestedThisWeek = [];
  for (const c of recent) {
    const r = c.conversation_rating;
    if (!r || !r.created_at) continue;
    if (r.created_at >= wk) requestedThisWeek.push(r);
    // created_at is when the rating was requested; updated_at is when the customer left it.
    if (r.rating != null && (r.updated_at || 0) >= m4) rated.push({ c, r, left: r.updated_at || r.created_at });
  }
  const week = rated.filter((x) => x.left >= wk);
  const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const x of rated) if (breakdown[x.r.rating] != null) breakdown[x.r.rating] += 1;
  const n4 = rated.length;

  let names = {};
  const label = (c) => {
    const n = customerName(c);
    if (!HIDE_CUSTOMERS) return n;
    return (names[n] ||= `Customer ${Object.keys(names).length + 1}`);
  };

  const negatives = week.filter((x) => x.r.rating <= 2)
    .sort((a, b) => a.r.rating - b.r.rating || b.left - a.left)
    .map(({ c, r, left }) => ({
      id: String(c.id), rating: r.rating, customer: label(c), type: ticketType(c),
      age_days: Math.floor((nowSec - c.created_at) / 86400), left_epoch: left,
      title: SHOW_TITLES ? ticketTitle(c) : "",
      has_comment: !!(r.remark && r.remark.trim()),
      comment: SHOW_COMMENTS && r.remark ? r.remark.trim().slice(0, 160) : "",
    }));

  // Reopened after resolved: open now, reopened before, and the latest customer
  // reply came after the latest close, this week.
  const reopened = open.filter((c) => {
    const s = c.statistics || {};
    return (s.count_reopens || 0) > 0 && (s.last_contact_reply_at || 0) > (s.last_close_at || 0) && (s.last_contact_reply_at || 0) >= wk;
  }).sort((a, b) => (b.statistics.count_reopens || 0) - (a.statistics.count_reopens || 0));

  const answered = requestedThisWeek.filter((r) => r.rating != null).length;
  return {
    snapshot_epoch: nowSec,
    week_start_epoch: wk,
    week: { ratings_left: week.length, negative: week.filter((x) => x.r.rating <= 2).length,
            requested: requestedThisWeek.length, answered },
    csat_4w: { score: n4 ? (breakdown[4] + breakdown[5]) / n4 : null, n: n4 },
    breakdown_4w: breakdown,
    negatives,
    reopened: {
      count: reopened.length,
      items: reopened.slice(0, 6).map((c) => ({
        id: String(c.id), customer: label(c), title: SHOW_TITLES ? ticketTitle(c) : "",
        type: ticketType(c), reopens: c.statistics.count_reopens,
        age_days: Math.floor((nowSec - c.created_at) / 86400),
        last_reply_epoch: c.statistics.last_contact_reply_at || null,
      })),
    },
    comments_shown: SHOW_COMMENTS,
  };
}

const keep = {};
const data = await pull(keep);
await writeFile(OUT, JSON.stringify(data, null, 2));
console.log(`wrote data.json: ${data.open_total} open, ${data.new_today} new today`);

// A failure here must not stop screen 1 from updating, so it is caught separately.
try {
  const sat = await pullSatisfaction(keep.open || []);
  await writeFile(OUT_SAT, JSON.stringify(sat, null, 2));
  console.log(`wrote satisfaction.json: ${sat.week.ratings_left} ratings this week, ${sat.week.negative} negative`);
} catch (e) {
  console.error("satisfaction pull failed (screen 1 still updated):", e.message);
}
