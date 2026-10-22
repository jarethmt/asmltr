/* esp_olm — WireGuard key material: base64 + X25519 keypair (config / NVS / generate).
 *
 * Uses the vendored esp_wireguard's reference crypto (base64 + refc x25519) so our keys match
 * WireGuard's exact byte conventions (little-endian, clamped scalar). SPDX: BSD-3-Clause
 */
#include "olm_priv.h"
#include <string.h>
#include "esp_log.h"
#include "esp_random.h"
#include "nvs_flash.h"
#include "nvs.h"

/* vendored esp_wireguard private headers (exported via its CMakeLists INCLUDE_DIRS "src") */
#include "wireguard.h"          /* wireguard_base64_encode / wireguard_base64_decode */
#include "crypto/refc/x25519.h" /* x25519(), X25519_BASE_POINT                       */

static const char *TAG = "olm_crypto";
#define NVS_NS   "esp_olm"
#define NVS_KEY  "wg_priv"

esp_err_t olm_b64_encode(const uint8_t *in, size_t len, char *out, size_t outlen)
{
    size_t n = outlen;
    if (!wireguard_base64_encode(in, len, out, &n)) return ESP_FAIL;
    if (n >= outlen) return ESP_ERR_INVALID_SIZE;
    out[n] = '\0';
    return ESP_OK;
}

int olm_b64_decode(const char *in, uint8_t *out, size_t outlen)
{
    size_t n = outlen;
    if (!wireguard_base64_decode(in, out, &n)) return -1;
    return (int)n;
}

/* Clamp a Curve25519 scalar in place (RFC 7748 / WireGuard convention). */
static void clamp_priv(uint8_t key[OLM_KEYLEN])
{
    key[0]  &= 248;
    key[31]  = (key[31] & 127) | 64;
}

/* Derive the WG public key from a (clamped) private key. */
static esp_err_t derive_public(const uint8_t priv[OLM_KEYLEN], uint8_t pub[OLM_KEYLEN])
{
    /* priv is already clamped; use clamp=0 to match wireguard_generate_public_key(). */
    if (x25519(pub, priv, X25519_BASE_POINT, 0) != 0) return ESP_FAIL;
    return ESP_OK;
}

static esp_err_t nvs_load_priv(uint8_t priv[OLM_KEYLEN])
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READONLY, &h);
    if (err != ESP_OK) return err;
    size_t len = OLM_KEYLEN;
    err = nvs_get_blob(h, NVS_KEY, priv, &len);
    nvs_close(h);
    if (err == ESP_OK && len != OLM_KEYLEN) return ESP_ERR_INVALID_SIZE;
    return err;
}

static esp_err_t nvs_store_priv(const uint8_t priv[OLM_KEYLEN])
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_blob(h, NVS_KEY, priv, OLM_KEYLEN);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

esp_err_t olm_crypto_key_init(const char *priv_b64_or_null, olm_keypair_t *out)
{
    memset(out, 0, sizeof(*out));
    bool have_priv = false;
    bool persist   = false;

    /* 1. explicit base64 private key from config wins */
    if (priv_b64_or_null && priv_b64_or_null[0]) {
        int n = olm_b64_decode(priv_b64_or_null, out->priv, OLM_KEYLEN);
        if (n == OLM_KEYLEN) { have_priv = true; }
        else ESP_LOGW(TAG, "config private key invalid (%d bytes); falling back", n);
    }
    /* 2. else try NVS */
    if (!have_priv && nvs_load_priv(out->priv) == ESP_OK) {
        have_priv = true;
        ESP_LOGI(TAG, "loaded WG private key from NVS");
    }
    /* 3. else generate a fresh one and persist it */
    if (!have_priv) {
        esp_fill_random(out->priv, OLM_KEYLEN);
        have_priv = true;
        persist   = true;
        ESP_LOGI(TAG, "generated a new WG private key");
    }

    clamp_priv(out->priv);
    if (persist) {
        esp_err_t e = nvs_store_priv(out->priv);
        if (e != ESP_OK) ESP_LOGW(TAG, "failed to persist WG key to NVS: %s", esp_err_to_name(e));
    }

    if (derive_public(out->priv, out->pub) != ESP_OK) {
        ESP_LOGE(TAG, "x25519 public-key derivation failed");
        return ESP_FAIL;
    }

    esp_err_t e1 = olm_b64_encode(out->priv, OLM_KEYLEN, out->priv_b64, sizeof(out->priv_b64));
    esp_err_t e2 = olm_b64_encode(out->pub,  OLM_KEYLEN, out->pub_b64,  sizeof(out->pub_b64));
    if (e1 != ESP_OK || e2 != ESP_OK) return ESP_FAIL;
    return ESP_OK;
}
