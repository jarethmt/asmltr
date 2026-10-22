# Portal control protocol (R3 — signed loader engine)

The wire contract shared by all four layers: the ESP32 **firmware**, the asmltr **core** signer, the
app's **native bridge**, and the **Portal.vue** UI. Change it in one place and update the others.

This is the *control* layer that sits on top of [discovery](index.md): once a Portal is connected,
this is how a trusted controller **pairs** with it and **loads + runs signed modules**.

## Trust model (the BadUSB line)

A Portal runs a module **only if** it carries a valid Ed25519 signature from the key the Portal is
**paired** to. Out of the box a Portal is `unpaired` and refuses every `load`.

- **Signing key** — a dedicated Ed25519 keypair owned by the asmltr instance, held in the TRUST
  vault as `portal_module_signing_key` (PKCS#8 private). It is **not** the mesh SSH identity
  (`mesh/sshkey`): different purpose, and SSH-agent wire signatures aren't raw Ed25519. The core
  mints it lazily on first use and never exposes the private half.
- **Pairing (TOFU)** — the controller writes the signing key's **32-byte raw public key** to the
  `pair` characteristic. If the Portal is `unpaired` it stores that key in NVS as its trust anchor
  and becomes `paired` (and shows it on-screen). If already paired to the *same* key: idempotent OK.
  A *different* key is rejected. Writing 32 zero bytes un-pairs (factory trust reset).
  > v1 is trust-on-first-use with on-screen disclosure. Requiring a physical button-tap to confirm a
  > pair is a hardening follow-up (R10) — noted, not built.

## GATT

Service `00657665-5f61-736d-6c74-72706f727401`. The last byte of the base UUID selects the
characteristic (`…7402` = `02`, etc.):

| byte | name | ops | payload |
|------|------|-----|---------|
| `01` | **service** | — | advertised in the scan response |
| `02` | **info** | READ | identity JSON (below) |
| `03` | **load** | WRITE | one chunk of a signed module envelope (framing below) |
| `04` | **run** | WRITE | `""`/`"run"` → execute the staged module; (future: a stored-module id) |
| `05` | **status** | NOTIFY | one UTF-8 progress/result line per notification |
| `06` | **pair** | WRITE | 32-byte raw Ed25519 public key (TOFU); 32 zero bytes = un-pair |

### info JSON

```json
{"kind":"asmltr-portal","name":"asmltr-portal-66DA","fw":"0.2.0-r3","trust":"paired","anchor":"ab12cd34"}
```

`trust` ∈ `unpaired|paired`. `anchor` = first 4 bytes of the paired public key, hex (`""` when unpaired).

## Signed module envelope

What travels over `load`, reassembled from chunks:

```
"AMD1"  (4 bytes, magic)
0x01    (1 byte, envelope version)
sig     (64 bytes, Ed25519 detached signature over PAYLOAD only)
PAYLOAD (UTF-8 JSON, the module — the exact bytes the core signed)
```

Verify = `crypto_sign_verify_detached(sig, PAYLOAD, len, anchor_pubkey)` (libsodium on-device; the core
signs with the same bytes via `node:crypto` Ed25519 — both RFC 8032, interoperable). The signature
covers the **exact payload bytes sent**, so there is no canonical-JSON hazard: the core signs
`Buffer.from(JSON.stringify(module))` and ships those bytes verbatim.

### load chunk framing

`load` is written in order, each write ≤ (ATT_MTU − 3). 4-byte header + data:

```
byte0  flags  (0x01 = FIRST, 0x02 = LAST — a one-chunk module sets both)
byte1  reserved (0)
byte2  seq hi  (big-endian u16, starts at 0, +1 per chunk)
byte3  seq lo
…data…
```

FIRST resets the staging buffer; each chunk must arrive in `seq` order; LAST finalizes → verify →
parse. Staging is capped (8 KB — the step-DSL is KB-scale). A gap, overflow, bad magic, or bad
signature clears staging and emits a `status` error line.

## Module (step-DSL v1)

```json
{"id":"self-test","name":"Self-test","v":1,"steps":[
  {"op":"screen","icon":"bolt","title":"Self-test","body":"Running a signed module on your Portal","color":"violet"},
  {"op":"status","text":"Signature verified on the dongle — running."},
  {"op":"led","color":"violet"},
  {"op":"wait","ms":700},
  {"op":"progress","label":"Finishing self-test","pct":100},
  {"op":"screen","icon":"check","title":"All good","body":"Screen, LED and signed-run all work","color":"green"},
  {"op":"led","color":"green"},
  {"op":"status","text":"Self-test passed."}
]}
```

Opcodes the engine executes against **hardware that exists today**:

| op | fields | effect |
|----|--------|--------|
| `screen` | `icon?`, `title?`, `body?`, `color?` | a module frame: accent icon on top, a big wrapped **title**, a wrapped **body** below. Everything word-wraps to the 172 px width; titles ≤6 chars render extra-large. (`lines[]` is still accepted and joined into the body.) |
| `led` | `color` (name) **or** `r,g,b` (0–255) | set the WS2812 |
| `progress` | `label`, `pct` (0–100) | labelled progress bar |
| `wait` | `ms` | delay (capped at 10 s/step) |
| `status` | `text` | emit a `status` notification (module-authored line) |
| `type` / `keys` | `text` | **deferred to R4** — recognized, emits `status: "type deferred to R4 (USB-HID)"`; no-op |

**Colors** (for `led` and `screen`): `violet` (default), `magenta`/`pink`, `cyan`, `green`, `amber`/`yellow`,
`red`, `blue`, `white`. **Icons** (for `screen`): `check`, `cross`, `lock`, `bolt`, `info`, `link`, `portal`, `dot`.

**Narration:** the engine emits a concise `status` line for *every* step it runs (`Screen: …`, `LED: cyan`,
`<label> — 100%`) plus the module's own `status` lines, so the app's Status console shows a real execution
trace rather than just start/done. After the last step the dongle **holds the final frame ~4.5 s** so it's
readable before the idle UI resumes.

`type`/`keys` are the USB-HID keystroke actuator. The dongle has a single USB port currently bound to
the Serial-JTAG console; driving HID means switching it to USB-OTG (and losing the console), which is
the R4 wireless-KVM rung. Recognizing the opcode now keeps modules authored today forward-compatible.

> **Firmware note:** the heavy work — Ed25519 verify (`module_finalize`) and step execution (`run`) — runs
> on the engine task, never on the NimBLE host task (whose small stack a verify overflows). The BLE
> callbacks only assemble chunks and enqueue a command.

## End-to-end flow

1. **connect + read `info`** → UI shows `trust`.
2. if `unpaired`: **pair** — `GET /v2/portal/signing-key` → write the 32-byte key to `pair` → re-read
   `info` → `paired`.
3. **load** — `POST /v2/portal/modules/sign` → chunk the envelope to `load`.
4. **subscribe** `status`, then **run** — write `run`; stream notifications into the UI log.

## Core endpoints

- `GET /v2/portal/signing-key` → `{ pubkey_b64, pubkey_fp }` (raw 32-byte key, b64; fp = first 4 bytes hex).
- `GET /v2/portal/modules` → `{ modules: [...] }` — the built-in library.
- `POST /v2/portal/modules/sign` — body `{ module }` (inline) **or** `{ id }` (from the library) →
  `{ module_id, envelope_b64, sig_b64, pubkey_b64, size }`.
