// asmltr Portal — Wi-Fi P2P data transport. See wifi_link.h for the model and framing.
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_event.h"
#include "lwip/sockets.h"
#include "lwip/netdb.h"
#include "wifi_link.h"
#include "engine.h"
#include "ble.h"

static const char *TAG = "portal-wifi";

static bool              s_inited   = false;   // esp_wifi + netif brought up once
static volatile bool     s_want     = false;   // caller wants a connection (start) vs torn down (stop)
static volatile bool     s_active   = false;   // TCP data socket is open
static volatile int      s_sock     = -1;
static char              s_go_ip[32] = {0};
static int               s_port     = 0;
static SemaphoreHandle_t s_ip_sem   = NULL;    // given by the IP event; taken by the socket task
static SemaphoreHandle_t s_tx_mtx   = NULL;    // serialize socket writes
static TaskHandle_t      s_task     = NULL;
static int               s_retries  = 0;

bool wifi_link_active(void) { return s_active && s_sock >= 0; }

// --- events ------------------------------------------------------------------------------------
static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        s_active = false;
        if (s_want && s_retries++ < 20) { esp_wifi_connect(); }   // keep trying while a session wants us up
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        s_retries = 0;
        if (s_ip_sem) xSemaphoreGive(s_ip_sem);                    // wake the socket task to dial the GO
    }
}

// --- socket task -------------------------------------------------------------------------------
static bool read_full(int sock, uint8_t *buf, int n) {
    int off = 0;
    while (off < n) {
        int r = recv(sock, buf + off, n - off, 0);
        if (r <= 0) return false;      // peer closed / error (stop() shuts the socket down to unblock)
        off += r;
    }
    return true;
}

static void sock_task(void *arg) {
    static uint8_t fbuf[4096];
    for (;;) {
        if (!s_want) { vTaskDelay(pdMS_TO_TICKS(200)); continue; }
        // wait for an IP on the GO's group (the event gives the sem); re-check s_want on timeout
        if (xSemaphoreTake(s_ip_sem, pdMS_TO_TICKS(15000)) != pdTRUE) continue;
        if (!s_want) continue;

        int sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (sock < 0) { vTaskDelay(pdMS_TO_TICKS(1500)); continue; }
        struct sockaddr_in dst = {0};
        dst.sin_family = AF_INET;
        dst.sin_port = htons(s_port);
        inet_aton(s_go_ip, &dst.sin_addr);
        if (connect(sock, (struct sockaddr *)&dst, sizeof dst) != 0) {
            ESP_LOGW(TAG, "connect %s:%d failed (errno %d)", s_go_ip, s_port, errno);
            close(sock);
            ble_status_notify("wifi: down");
            vTaskDelay(pdMS_TO_TICKS(1500));
            continue;
        }
        int one = 1; setsockopt(sock, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
        s_sock = sock; s_active = true;
        ESP_LOGI(TAG, "wifi data socket up to %s:%d", s_go_ip, s_port);
        ble_status_notify("wifi: up");

        // frame loop: [len:2 BE][ [mode:1][data] ] -> engine
        while (s_want) {
            uint8_t hdr[2];
            if (!read_full(sock, hdr, 2)) break;
            int flen = ((int)hdr[0] << 8) | hdr[1];
            if (flen <= 0 || flen > (int)sizeof(fbuf)) break;      // framing error -> drop the link
            if (!read_full(sock, fbuf, flen)) break;
            if (flen >= 1) engine_submit_exec(fbuf[0], fbuf + 1, flen - 1);
        }

        s_active = false; s_sock = -1; close(sock);
        ESP_LOGI(TAG, "wifi data socket closed");
        ble_status_notify("wifi: down");
    }
}

// --- public API --------------------------------------------------------------------------------
static bool ensure_inited(void) {
    if (s_inited) return true;
    s_ip_sem = xSemaphoreCreateBinary();
    s_tx_mtx = xSemaphoreCreateMutex();
    if (!s_ip_sem || !s_tx_mtx) return false;

    esp_err_t e = esp_netif_init();
    if (e != ESP_OK && e != ESP_ERR_INVALID_STATE) { ESP_LOGE(TAG, "netif_init %d", e); return false; }
    e = esp_event_loop_create_default();
    if (e != ESP_OK && e != ESP_ERR_INVALID_STATE) { ESP_LOGE(TAG, "event_loop %d", e); return false; }
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    e = esp_wifi_init(&cfg);
    if (e != ESP_OK) { ESP_LOGE(TAG, "wifi_init %d (likely low RAM) -> staying on BLE", e); return false; }
    esp_wifi_set_storage(WIFI_STORAGE_RAM);
    esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi_event, NULL, NULL);
    esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi_event, NULL, NULL);
    esp_wifi_set_mode(WIFI_MODE_STA);
    esp_wifi_set_ps(WIFI_PS_NONE);                 // latency/throughput over power — we're USB-powered

    xTaskCreate(sock_task, "portal-wifi-sock", 4096, NULL, 5, &s_task);
    s_inited = true;
    return true;
}

bool wifi_link_start(const char *ssid, const char *pass, const char *go_ip, int port) {
    if (!ssid || !pass || !go_ip || port <= 0) return false;
    if (!ensure_inited()) return false;

    strlcpy(s_go_ip, go_ip, sizeof s_go_ip);
    s_port = port;
    s_retries = 0;

    wifi_config_t wc = {0};
    strlcpy((char *)wc.sta.ssid, ssid, sizeof wc.sta.ssid);
    strlcpy((char *)wc.sta.password, pass, sizeof wc.sta.password);
    wc.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;   // Android P2P GO is WPA2-PSK
    if (esp_wifi_set_config(WIFI_IF_STA, &wc) != ESP_OK) return false;

    s_want = true;
    // start (idempotent) then (re)associate; the event handler dials once we have an IP
    esp_err_t e = esp_wifi_start();
    if (e != ESP_OK && e != ESP_ERR_WIFI_CONN /* already started */) { ESP_LOGW(TAG, "wifi_start %d", e); }
    esp_wifi_connect();
    ESP_LOGI(TAG, "joining P2P group ssid='%s' -> %s:%d", ssid, go_ip, port);
    return true;
}

void wifi_link_stop(void) {
    s_want = false;
    s_active = false;
    int sock = s_sock; s_sock = -1;
    if (sock >= 0) { shutdown(sock, SHUT_RDWR); close(sock); }   // unblock the recv loop
    esp_wifi_disconnect();
}

int wifi_link_send(const uint8_t *data, int len) {
    if (!wifi_link_active() || len <= 0 || len > 0xFFFF) return -1;
    int sock = s_sock;
    if (sock < 0) return -1;
    uint8_t hdr[2] = { (uint8_t)((len >> 8) & 0xFF), (uint8_t)(len & 0xFF) };
    int rc = -1;
    if (s_tx_mtx) xSemaphoreTake(s_tx_mtx, portMAX_DELAY);
    if (send(sock, hdr, 2, 0) == 2) {
        int off = 0, ok = 1;
        while (off < len) {
            int w = send(sock, data + off, len - off, 0);
            if (w <= 0) { ok = 0; break; }
            off += w;
        }
        rc = ok ? len : -1;
    }
    if (s_tx_mtx) xSemaphoreGive(s_tx_mtx);
    return rc;
}
