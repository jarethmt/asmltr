/* asmltr Portal — olm mesh bring-up glue.
 *
 * Reads the provisioned config from NVS (namespace "portal"), joins the configured Wi-Fi AP for
 * internet, waits for an IP, then starts the esp_olm mesh client. Nothing is hardcoded: the app /
 * dashboard writes these keys over BLE at provisioning time. If unprovisioned, this is a no-op and
 * the dongle behaves exactly as before (BLE / Wi-Fi-Direct to the phone).
 *
 *   NVS "portal":  olm_server, olm_id, olm_secret, olm_org, wifi_ssid, wifi_pass
 */
#include "portal_olm.h"
#include "esp_olm.h"
#include "wifi_link.h"
#include "ble.h"

#include <string.h>
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"

static const char *TAG = "portal_olm";

/* provisioned config, kept alive for esp_olm_start (which copies it) */
static char s_server[160], s_id[64], s_secret[96], s_org[48], s_ssid[40], s_pass[72];

static void log_heap(const char *when)
{
    ESP_LOGI(TAG, "heap @ %s: free=%u largest=%u internal-free=%u",
             when,
             (unsigned)esp_get_free_heap_size(),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
}

static void on_state(esp_olm_state_t st, void *ctx)
{
    (void)ctx;
    static const char *names[] = { "disconnected", "connecting", "registering", "connected", "error" };
    const char *n = (st <= ESP_OLM_ERROR) ? names[st] : "?";
    ESP_LOGI(TAG, "mesh state: %s", n);
    char msg[48];
    if (st == ESP_OLM_CONNECTED) snprintf(msg, sizeof msg, "mesh: %s", esp_olm_tunnel_ip());
    else                         snprintf(msg, sizeof msg, "mesh: %s", n);
    ble_status_notify(msg);
}

static void on_error(const char *code, const char *message, void *ctx)
{
    (void)ctx;
    ESP_LOGW(TAG, "mesh error [%s]: %s", code ? code : "?", message ? message : "");
}

static bool nvs_get(nvs_handle_t h, const char *k, char *buf, size_t n)
{
    size_t len = n;
    return nvs_get_str(h, k, buf, &len) == ESP_OK && buf[0] != '\0';
}

static void olm_bringup_task(void *arg)
{
    (void)arg;
    /* wait for the STA to obtain an IP (up to ~40s) */
    int waited = 0;
    while (!wifi_link_sta_got_ip() && waited < 40000) { vTaskDelay(pdMS_TO_TICKS(500)); waited += 500; }
    if (!wifi_link_sta_got_ip()) {
        ESP_LOGW(TAG, "no IP after %d ms; mesh not started (staying on BLE/phone)", waited);
        vTaskDelete(NULL);
        return;
    }
    ESP_LOGI(TAG, "STA has IP after %d ms; starting mesh client", waited);
    log_heap("pre-olm");

    esp_olm_config_t cfg = {
        .server_url = s_server,
        .olm_id     = s_id,
        .secret     = s_secret,
        .org_id     = s_org,
        .relay      = true,          /* hub-and-spoke through the exit node; no holepunch */
        .on_state   = on_state,
        .on_error   = on_error,
    };
    esp_err_t err = esp_olm_start(&cfg);
    if (err != ESP_OK) ESP_LOGE(TAG, "esp_olm_start: %s", esp_err_to_name(err));
    else               ESP_LOGI(TAG, "esp_olm started; pubkey=%s", esp_olm_public_key());
    log_heap("post-olm-start");
    vTaskDelete(NULL);
}

void portal_olm_start(void)
{
    nvs_handle_t h;
    if (nvs_open("portal", NVS_READONLY, &h) != ESP_OK) {
        ESP_LOGI(TAG, "no 'portal' NVS namespace; mesh not provisioned — skipping");
        return;
    }
    bool ok = nvs_get(h, "olm_server", s_server, sizeof s_server)
           && nvs_get(h, "olm_id",     s_id,     sizeof s_id)
           && nvs_get(h, "olm_secret", s_secret, sizeof s_secret)
           && nvs_get(h, "olm_org",    s_org,    sizeof s_org)
           && nvs_get(h, "wifi_ssid",  s_ssid,   sizeof s_ssid);
    nvs_get(h, "wifi_pass", s_pass, sizeof s_pass);  /* open networks allowed */
    nvs_close(h);

    if (!ok) {
        ESP_LOGI(TAG, "mesh config incomplete in NVS — skipping (dongle stays BLE/phone-only)");
        return;
    }

    ESP_LOGI(TAG, "mesh provisioned: server=%s org=%s id=%.6s.. ssid=%s", s_server, s_org, s_id, s_ssid);
    if (!wifi_link_sta_join(s_ssid, s_pass)) {
        ESP_LOGW(TAG, "wifi STA join failed to start; mesh not started");
        return;
    }
    xTaskCreate(olm_bringup_task, "olm-bringup", 4096, NULL, 4, NULL);
}
