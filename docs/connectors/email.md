# Email connector

The email connector (`connectors/types/email/index.js`) turns the assistant's mailbox into a
channel: IMAP IDLE for inbound, SMTP for replies, same core trust and moderation as every other
surface.

## Inbound Authentication-Results

Inbound mail is accepted only when **Authentication-Results** on the message says DKIM, SPF, and
DMARC each `pass`, **and** the header's authserv-id is on a host allowlist.

The CHECK is in this public connector (every install). The VALUE is personal:

- File: `~/.asmltr/email-authserv.json` (mode `600`), shape `{ "authserv_ids": ["…"] }`
- Override path with `ASMLTR_EMAIL_AUTHSERV_FILE` if you need a temp/test file
- Empty or missing file: fail closed (no turn, no reply). Logged reason: `authserv unset`

Honor **only** `Authentication-Results`. Never use `ARC-Authentication-Results` as a substitute.
If several AR headers are present, only the one whose authserv-id is allowlisted counts. Fail
closed for missing AR, wrong authserv, or ARC-only.

### How to set the value (LLM-assisted installs)

Look at a **real message in the bot mailbox** (mail delivered TO the assistant address). Copy the
**first token** of `Authentication-Results` — the authserv-id before the first `;`.

That token is the stamp from the server that **hosts the bot address**, not the sender.

Examples (examples only, not repo defaults):

- Google-hosted mailbox: `mx.google.com`
- Microsoft 365-hosted mailbox: `mx.microsoft.com`

Do **not** copy the DNS MX hostname. Google MX is `aspmx.l.google.com`; the AR token is
`mx.google.com`. Microsoft MX may look like `protection.outlook.com`; the AR token is typically
`mx.microsoft.com`.

```json
{ "authserv_ids": ["mx.google.com"] }
```
