// asmltr Portal — trust anchor (pairing). The BadUSB line: a Portal runs a module only if it is
// signed by the key it is paired to. Pairing is trust-on-first-use (TOFU) — see PORTAL-PROTOCOL.md.
//
// The 32-byte Ed25519 public key of the paired asmltr instance is persisted in NVS. Un-pairing
// (writing 32 zero bytes to the `pair` characteristic) clears it back to the factory `unpaired`
// state. Only one anchor at a time; a different key is rejected while paired.
#include <string.h>
#include "esp_log.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "trust.h"

static const char *TAG = "portal-trust";
#define NS   "portal"
#define KEY  "anchor"

static uint8_t s_anchor[32];
static bool    s_paired = false;

void trust_init(void) {
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READONLY, &h) != ESP_OK) { s_paired = false; return; }
    size_t sz = sizeof(s_anchor);
    esp_err_t e = nvs_get_blob(h, KEY, s_anchor, &sz);
    nvs_close(h);
    s_paired = (e == ESP_OK && sz == sizeof(s_anchor));
    ESP_LOGI(TAG, "trust: %s", s_paired ? "paired" : "unpaired");
}

bool trust_is_paired(void) { return s_paired; }
const uint8_t *trust_anchor(void) { return s_anchor; }

void trust_fingerprint_hex(char *out, size_t n) {
    if (!n) return;
    if (!s_paired) { out[0] = '\0'; return; }
    static const char hx[] = "0123456789abcdef";
    size_t i = 0;
    for (int b = 0; b < 4 && (i + 2) < n; b++) { out[i++] = hx[s_anchor[b] >> 4]; out[i++] = hx[s_anchor[b] & 0xf]; }
    out[i] = '\0';
}

static bool all_zero(const uint8_t *k, size_t len) {
    for (size_t i = 0; i < len; i++) if (k[i]) return false;
    return true;
}

static bool persist(const uint8_t *key /* 32 bytes, or NULL to clear */) {
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t e = key ? nvs_set_blob(h, KEY, key, 32) : nvs_erase_key(h, KEY);
    if (e == ESP_OK || (!key && e == ESP_ERR_NVS_NOT_FOUND)) e = nvs_commit(h);
    nvs_close(h);
    return e == ESP_OK;
}

bool trust_pair(const uint8_t *key, size_t len) {
    if (len != 32) { ESP_LOGW(TAG, "pair: wrong length %u", (unsigned)len); return false; }
    if (all_zero(key, 32)) {                       // un-pair (factory trust reset)
        if (!persist(NULL)) return false;
        memset(s_anchor, 0, sizeof(s_anchor)); s_paired = false;
        ESP_LOGI(TAG, "un-paired");
        return true;
    }
    if (s_paired) {                                // already paired: idempotent for same key, reject different
        if (memcmp(s_anchor, key, 32) == 0) return true;
        ESP_LOGW(TAG, "pair: rejected — already paired to a different key");
        return false;
    }
    if (!persist(key)) return false;               // TOFU: adopt the first key offered
    memcpy(s_anchor, key, 32); s_paired = true;
    ESP_LOGI(TAG, "paired (TOFU)");
    return true;
}
