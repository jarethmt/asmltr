// asmltr Portal — module loader: reassemble the chunked `load` writes, then hand off to the engine
// task to verify the Ed25519 signature and stage. See PORTAL-PROTOCOL.md.
//
// CRITICAL: the signature verify (libsodium) and JSON work must NOT run on the NimBLE host task —
// that task has a small stack and Ed25519 verify overflows it (observed: "stack overflow in task
// nimble_host"). So `module_load_chunk` (called from the BLE callback) only does light memcpy and,
// on the last chunk, signals the engine task; `module_finalize` (the heavy verify) runs there.
#include <string.h>
#include "esp_log.h"
#include "sodium.h"
#include "module.h"
#include "trust.h"
#include "engine.h"

static const char *TAG = "portal-module";

#define MODULE_MAX 8192                 // step-DSL is KB-scale; cap staging well under RAM
#define ENV_MAGIC  "AMD1"
#define ENV_HDR    (4 + 1 + 64)         // magic(4) + version(1) + sig(64), then payload

static uint8_t  s_buf[MODULE_MAX];
static size_t   s_len;
static uint16_t s_next_seq;
static bool     s_active;
static volatile bool s_ready;           // a complete envelope awaits finalize (on the engine task)

void module_init(void) {
    if (sodium_init() < 0) ESP_LOGE(TAG, "sodium_init failed");
}

// Runs on the ENGINE task (not the BLE callback) — safe to do the heavy Ed25519 verify here.
const char *module_finalize(void) {
    if (!s_ready) return "load: nothing to finalize";
    s_ready = false;
    if (s_len < ENV_HDR + 2) return "load: runt envelope";
    if (memcmp(s_buf, ENV_MAGIC, 4) != 0) return "load: bad magic";
    if (s_buf[4] != 0x01) return "load: bad envelope version";
    if (!trust_is_paired()) return "load: unpaired — pair first";
    const uint8_t *sig = s_buf + 5;
    const uint8_t *payload = s_buf + ENV_HDR;
    size_t plen = s_len - ENV_HDR;
    if (crypto_sign_verify_detached(sig, payload, plen, trust_anchor()) != 0) {
        ESP_LOGW(TAG, "signature verify FAILED (%u byte payload)", (unsigned)plen);
        return "load: bad signature";
    }
    if (!engine_stage(payload, plen)) return "load: stage failed";
    ESP_LOGI(TAG, "module verified + staged (%u bytes)", (unsigned)plen);
    return "load: ok — verified + staged";
}

// Runs on the NimBLE host task — keep it light (memcpy only). On the last chunk, signal the engine.
const char *module_load_chunk(const uint8_t *data, size_t len) {
    if (len < 4) return "load: short chunk";
    uint8_t  flags = data[0];
    uint16_t seq   = ((uint16_t)data[2] << 8) | data[3];
    const uint8_t *payload = data + 4;
    size_t plen = len - 4;

    if (flags & 0x01) { s_len = 0; s_next_seq = 0; s_active = true; }   // FIRST
    if (!s_active) return "load: expected FIRST chunk";
    if (seq != s_next_seq) { s_active = false; return "load: seq gap"; }
    if (s_len + plen > MODULE_MAX) { s_active = false; return "load: module too big"; }
    memcpy(s_buf + s_len, payload, plen);
    s_len += plen;
    s_next_seq++;

    if (flags & 0x02) {                                                // LAST
        s_active = false; s_ready = true;
        engine_request_finalize();                                     // verify happens on the engine task
        return "load: received — verifying";
    }
    return NULL;                                                       // in-progress, no status line
}

const char *module_run_staged(void) { return engine_run_staged(); }
