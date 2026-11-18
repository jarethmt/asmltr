'use strict';
/**
 * CALDAV integration — calendars as a passive `tools` capability.
 *
 * Works against SOGo (mailcow) and Google unchanged: both speak standard CalDAV, so the only
 * provider difference is auth (app password vs OAuth2 bearer).
 *
 * config: {
 *   base_url,                  // SOGo: https://host/SOGo/dav/<user>/Calendar/
 *                              // Google: https://apidata.googleusercontent.com/caldav/v2/<email>/
 *   username_ref, password_ref,      // Basic auth (mailcow)
 *   auth = 'password' | 'oauth2',
 *   refresh_token_ref, oauth_client_id_ref, oauth_client_secret_ref,   // oauth2 (Google)
 * }
 */
const dav = require('../../../shared/dav');

async function withToken(cfg) {
  if (cfg.auth !== 'oauth2') return cfg;
  if (cfg.access_token) return cfg;
  const google = require('../../../shared/google-oauth');
  const { access_token } = await google.accessToken({
    client_id: cfg.oauth_client_id, client_secret: cfg.oauth_client_secret, refresh_token: cfg.refresh_token,
  });
  return { ...cfg, access_token };
}

/**
 * Isolate the VEVENT before reading fields. An ICS from Google carries a VTIMEZONE whose DST rules
 * have their OWN DTSTART (typically `19700308T020000`) — and that one comes FIRST in the document,
 * so matching the whole body reported every event as starting in 1970.
 */
function veventOf(ics) {
  const flat = String(ics || '').replace(/\r?\n[ \t]/g, '');
  const m = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/i.exec(flat);
  return m ? m[1] : flat;
}

function icalField(ics, field, { scope = 'vevent' } = {}) {
  const body = scope === 'vevent' ? veventOf(ics) : String(ics || '').replace(/\r?\n[ \t]/g, '');
  const m = new RegExp(`^${field}(?:;[^:\\n]*)?:(.*)$`, 'im').exec(body);
  return m ? m[1].trim() : null;
}

/** The TZID off DTSTART, so a floating local time is interpretable. */
function icalTzid(ics) {
  const m = /^DTSTART;[^:\n]*TZID=([^;:\n]+)/im.exec(veventOf(ics));
  return m ? m[1].trim() : null;
}

/** `20261119T143000` / `20261119` / `…Z` → ISO, so callers are not parsing iCalendar themselves. */
function icalToIso(v) {
  if (!v) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(v).trim());
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, z] = m;
  if (!hh) return `${y}-${mo}-${d}`;                                  // all-day
  return z ? `${y}-${mo}-${d}T${hh}:${mi}:${ss}Z` : `${y}-${mo}-${d}T${hh}:${mi}:${ss}`;
}

/** Summarise an event without pretending to be a full iCalendar parser. */
function summarise(ics) {
  const rawStart = icalField(ics, 'DTSTART');
  const rawEnd = icalField(ics, 'DTEND');
  return {
    uid: icalField(ics, 'UID'),
    summary: icalField(ics, 'SUMMARY'),
    start: icalToIso(rawStart) || rawStart,
    end: icalToIso(rawEnd) || rawEnd,
    tzid: icalTzid(ics),
    all_day: !!(rawStart && /^\d{8}$/.test(rawStart)),
    location: icalField(ics, 'LOCATION'),
    organizer: icalField(ics, 'ORGANIZER'),
    status: icalField(ics, 'STATUS'),
    recurrence: icalField(ics, 'RRULE'),
  };
}

function utc(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) throw new Error('caldav: invalid date');
  return t.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

async function open(rawCfg = {}) {
  const cfg = await withToken(rawCfg);
  const c = dav.makeClient({ ...cfg, username: cfg.username, password: cfg.password });
  return {
    /** Calendar collections under base_url. */
    async calendars() { return c.collections({ marker: 'calendar' }); },
    /**
     * Events in a window. Defaults to a 30-day forward window rather than everything — an
     * unbounded calendar-query on a long-lived calendar is a lot of data for no reason.
     */
    async events({ calendar, start, end, limit = 200 } = {}) {
      const url = calendar || c.base + '/';
      const from = utc(start || Date.now());
      const to = utc(end || Date.now() + 30 * 86400000);
      const body = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop><d:getetag/><c:calendar-data/></d:prop>
        <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
        <c:time-range start="${from}" end="${to}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
      const rows = await c.report(url, body, 'calendar-data');
      return rows.slice(0, limit).map((r) => ({ href: r.href, url: r.url, etag: r.etag, ...summarise(r.data), ics: r.data }));
    },
    async getEvent(url) { const { data, etag } = await c.getItem(url); return { url, etag, ...summarise(data), ics: data }; },
    /** Create or replace. Caller supplies full iCalendar — no half-built VEVENT guessing here. */
    async putEvent({ url, ics, etag } = {}) {
      if (!url || !ics) throw new Error('caldav: url + ics required');
      return c.putItem(url, ics, 'text/calendar; charset=utf-8', { etag });
    },
    async deleteEvent({ url, etag } = {}) {
      if (!url) throw new Error('caldav: url required');
      return c.deleteItem(url, { etag });
    },
    async close() { /* stateless HTTP — nothing to tear down */ },
  };
}

async function probe(cfg = {}) {
  const h = await open(cfg);
  const cals = await h.calendars();
  return { ok: true, calendars: cals.length, names: cals.map((x) => x.name).filter(Boolean).slice(0, 8) };
}

// `summarise` and the date helper are exported so the VTIMEZONE trap can be tested against the
// REAL parser rather than a reimplementation of it in the test.
module.exports = { open, probe, kind: 'tools', lifecycle: 'passive', summarise, icalToIso, veventOf };
