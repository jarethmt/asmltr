'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const dav = require('../shared/dav');
const caldav = require('../integrations/types/caldav');
const carddav = require('../integrations/types/carddav');

test('both DAV drivers are passive tools capabilities', () => {
  for (const d of [caldav, carddav]) {
    assert.equal(d.kind, 'tools');
    assert.equal(d.lifecycle, 'passive');
    assert.equal(typeof d.open, 'function');
    assert.equal(typeof d.probe, 'function');
  }
});

test('auth is Basic for a password and Bearer for oauth2', () => {
  assert.match(dav.authHeader({ username: 'u', password: 'p' }), /^Basic /);
  assert.equal(dav.authHeader({ auth: 'oauth2', access_token: 'tok' }), 'Bearer tok');
  assert.throws(() => dav.authHeader({ auth: 'oauth2' }), /access_token required/);
  assert.throws(() => dav.authHeader({ username: 'u' }), /username \+ password required/);
});

test('responses() pairs each href with its own props', () => {
  const xml = `<d:multistatus xmlns:d="DAV:">
    <d:response><d:href>/a/</d:href><d:propstat><d:prop><d:displayname>A</d:displayname>
      <d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
    <d:response><d:href>/b/</d:href><d:propstat><d:prop><d:displayname>B</d:displayname>
      <d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
  </d:multistatus>`;
  const rs = dav.responses(xml);
  assert.equal(rs.length, 2);
  assert.deepEqual(rs.map((r) => [r.href, r.displayname]), [['/a/', 'A'], ['/b/', 'B']]);
});

// The bug this pins: SOGo advertises one calendar THREE times — the real collection plus `.ics`
// and `.xml` alternate representations with an EMPTY resourcetype. Matching the whole response
// block accepted all three, and handing a REPORT the `.ics` href answers 501.
test('a collection is identified by resourcetype, not by the response block', () => {
  const xml = `<d:multistatus xmlns:d="DAV:">
    <d:response><d:href>/Calendar/</d:href><d:propstat><d:prop><d:displayname>Calendar</d:displayname>
      <d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
    <d:response><d:href>/Calendar/personal.ics</d:href><d:propstat><d:prop>
      <d:displayname>Personal Calendar</d:displayname><d:resourcetype></d:resourcetype></d:prop></d:propstat></d:response>
    <d:response><d:href>/Calendar/personal.xml</d:href><d:propstat><d:prop>
      <d:displayname>Personal Calendar</d:displayname><d:resourcetype></d:resourcetype></d:prop></d:propstat></d:response>
    <d:response><d:href>/Calendar/personal/</d:href><d:propstat><d:prop>
      <d:displayname>Personal Calendar</d:displayname>
      <d:resourcetype><d:collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></d:resourcetype>
    </d:prop></d:propstat></d:response>
  </d:multistatus>`;
  const rows = dav.responses(xml);
  const isCalendar = (r) => {
    const rt = (dav.one(r.raw, 'resourcetype') || '').replace(/\s+/g, '');
    return /collection/i.test(rt) && /calendar/i.test(rt);
  };
  const hits = rows.filter(isCalendar).map((r) => r.href);
  assert.deepEqual(hits, ['/Calendar/personal/'], 'only the real collection may match');
  // the alternate representations must NOT be selected
  assert.ok(!hits.some((h) => h.endsWith('.ics') || h.endsWith('.xml')));
});

test('abs() resolves server-relative hrefs against the origin', () => {
  const c = dav.makeClient({ base_url: 'https://h/SOGo/dav/u/Calendar/', username: 'u', password: 'p' });
  assert.equal(c.abs('/SOGo/dav/u/Calendar/personal/'), 'https://h/SOGo/dav/u/Calendar/personal/');
  assert.equal(c.abs('https://other/x'), 'https://other/x');
});

test('caldav requires base_url and rejects a bad window', async () => {
  await assert.rejects(() => caldav.open({ username: 'u', password: 'p' }), /base_url required/);
  const h = await caldav.open({ base_url: 'https://h/c/', username: 'u', password: 'p' });
  await assert.rejects(() => h.events({ start: 'not-a-date' }), /invalid date/);
});

test('writes require explicit payloads — no half-built VEVENT/vCard guessing', async () => {
  const cal = await caldav.open({ base_url: 'https://h/c/', username: 'u', password: 'p' });
  await assert.rejects(() => cal.putEvent({ url: 'https://h/c/x.ics' }), /url \+ ics required/);
  await assert.rejects(() => cal.deleteEvent({}), /url required/);
  const card = await carddav.open({ base_url: 'https://h/a/', username: 'u', password: 'p' });
  await assert.rejects(() => card.putContact({ url: 'https://h/a/x.vcf' }), /url \+ vcard required/);
  await assert.rejects(() => card.searchContacts({}), /query required/);
});
