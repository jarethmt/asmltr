// asmltr Portal — BLE control link (R3). NimBLE peripheral: advertise + GATT service.
//
// Connectivity is BLE-only (DESIGN §3): the dongle is driven by a controller (asmltr app on
// Android/iOS, or Chrome/Edge via Web Bluetooth). Discovery reads identity (info); the control
// plane pairs (pair), loads a signed module in chunks (load), runs it (run), and streams progress
// back (status notify). Trust-gated end to end — a module runs only if signed by the paired key.
// Wire contract: docs/PORTAL-PROTOCOL.md.
#include <stdio.h>
#include <string.h>
#include "esp_log.h"
#include "esp_mac.h"
#include "nvs_flash.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/ble_gatt.h"
#include "host/ble_att.h"
#include "host/ble_hs_mbuf.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "ble.h"
#include "trust.h"
#include "module.h"
#include "engine.h"
#include "portal_ui.h"
#include "wifi_link.h"
#include "usb_hid.h"   // usb_host_os() — host OS surfaced over the INFO characteristic
#include "cJSON.h"

static const char *TAG = "portal-ble";
#define FW_VERSION "0.2.0-r3"

// One stable 128-bit base; the first byte selects svc(01)/info(02)/load(03)/run(04)/status(05)/pair(06).
#define PUUID(n) BLE_UUID128_INIT((n),0x74,0x72,0x6f,0x70,0x72,0x74,0x6c,0x6d,0x73,0x61,0x5f,0x65,0x76,0x65,0x00)
static const ble_uuid128_t SVC_UUID    = PUUID(0x01);
static const ble_uuid128_t INFO_UUID   = PUUID(0x02);
static const ble_uuid128_t LOAD_UUID   = PUUID(0x03);
static const ble_uuid128_t RUN_UUID    = PUUID(0x04);
static const ble_uuid128_t STATUS_UUID = PUUID(0x05);
static const ble_uuid128_t PAIR_UUID   = PUUID(0x06);
static const ble_uuid128_t EXEC_UUID   = PUUID(0x08);   // WRITE: [mode][data] driver command (HID/CDC)
static const ble_uuid128_t IOBACK_UUID = PUUID(0x09);   // NOTIFY: the host's CDC return stream
static const ble_uuid128_t WIFI_UUID   = PUUID(0x0A);   // WRITE (chunked): Wi-Fi P2P creds handoff JSON

static uint8_t  s_addr_type;
static char     s_name[24];
static bool     s_connected = false;
static uint16_t s_conn_handle = 0;
static uint16_t s_status_handle = 0;      // STATUS characteristic value handle (for notify)
static bool     s_status_subscribed = false;
static uint16_t s_ioback_handle = 0;      // IOBACK characteristic value handle (for notify)
static bool     s_ioback_subscribed = false;

bool ble_is_connected(void) { return s_connected; }
const char *ble_device_name(void) { return s_name; }

static void advertise(void);

// Push a status line to a subscribed central (used by the loader + engine).
void ble_status_notify(const char *line) {
    if (!s_connected || !s_status_subscribed || !s_status_handle || !line) return;
    struct os_mbuf *om = ble_hs_mbuf_from_flat(line, strlen(line));
    if (om) ble_gatts_notify_custom(s_conn_handle, s_status_handle, om);
}

// Push the host's CDC return bytes up to a subscribed central (the ioback stream → app portal.io).
// Split by the live ATT MTU (notify payload = MTU-3): the caller may hand us up to 512 B, but a single
// notification can only carry MTU-3, so a too-big mbuf would be dropped. With a negotiated 512 MTU each
// packet carries ~509 B instead of the old ~180 — the return channel's throughput ceiling.
void ble_ioback_notify(const uint8_t *data, int len) {
    if (!s_connected || !s_ioback_subscribed || !s_ioback_handle || len <= 0) return;
    uint16_t mtu = ble_att_mtu(s_conn_handle);
    int max = (mtu > 23 ? mtu : 23) - 3;
    for (int off = 0; off < len; off += max) {
        int n = len - off; if (n > max) n = max;
        struct os_mbuf *om = ble_hs_mbuf_from_flat(data + off, n);
        if (!om) return;
        ble_gatts_notify_custom(s_conn_handle, s_ioback_handle, om);
    }
}

// Reassemble a chunked `exec` write ([flags FIRST/LAST][rsvd][seqBE] + bytes). Returns true on LAST.
static uint8_t  s_exec_asm[2100];
static size_t   s_exec_asm_len;
static uint16_t s_exec_next_seq;
static bool     s_exec_active;
static bool exec_chunk(const uint8_t *d, uint16_t len) {
    if (len < 4) return false;
    uint8_t flags = d[0]; uint16_t seq = ((uint16_t)d[2] << 8) | d[3];
    const uint8_t *p = d + 4; size_t pl = len - 4;
    if (flags & 0x01) { s_exec_asm_len = 0; s_exec_next_seq = 0; s_exec_active = true; }
    if (!s_exec_active) return false;
    if (seq != s_exec_next_seq) { s_exec_active = false; return false; }
    if (s_exec_asm_len + pl > sizeof(s_exec_asm)) { s_exec_active = false; return false; }
    memcpy(s_exec_asm + s_exec_asm_len, p, pl); s_exec_asm_len += pl; s_exec_next_seq++;
    if (flags & 0x02) { s_exec_active = false; return true; }
    return false;
}

// Reassemble a chunked `wifi` write (same [flags][rsvd][seqBE] framing) — the creds handoff JSON.
static uint8_t  s_wifi_asm[512];
static size_t   s_wifi_asm_len;
static uint16_t s_wifi_next_seq;
static bool     s_wifi_active;
static bool wifi_chunk(const uint8_t *d, uint16_t len) {
    if (len < 4) return false;
    uint8_t flags = d[0]; uint16_t seq = ((uint16_t)d[2] << 8) | d[3];
    const uint8_t *p = d + 4; size_t pl = len - 4;
    if (flags & 0x01) { s_wifi_asm_len = 0; s_wifi_next_seq = 0; s_wifi_active = true; }
    if (!s_wifi_active) return false;
    if (seq != s_wifi_next_seq) { s_wifi_active = false; return false; }
    if (s_wifi_asm_len + pl > sizeof(s_wifi_asm) - 1) { s_wifi_active = false; return false; }
    memcpy(s_wifi_asm + s_wifi_asm_len, p, pl); s_wifi_asm_len += pl; s_wifi_next_seq++;
    if (flags & 0x02) { s_wifi_active = false; return true; }
    return false;
}

// Apply a reassembled creds blob: {"ssid","pass","ip","port"} brings Wi-Fi up; {"off":true} tears it down.
static void apply_wifi_creds(void) {
    s_wifi_asm[s_wifi_asm_len] = 0;
    cJSON *root = cJSON_Parse((const char *)s_wifi_asm);
    if (!root) { ble_status_notify("wifi: bad creds json"); return; }
    cJSON *off = cJSON_GetObjectItem(root, "off");
    if (cJSON_IsTrue(off)) { wifi_link_stop(); ble_status_notify("wifi: off"); cJSON_Delete(root); return; }
    cJSON *ssid = cJSON_GetObjectItem(root, "ssid");
    cJSON *pass = cJSON_GetObjectItem(root, "pass");
    cJSON *ip   = cJSON_GetObjectItem(root, "ip");
    cJSON *port = cJSON_GetObjectItem(root, "port");
    if (cJSON_IsString(ssid) && cJSON_IsString(pass) && cJSON_IsString(ip) && cJSON_IsNumber(port)) {
        bool ok = wifi_link_start(ssid->valuestring, pass->valuestring, ip->valuestring, port->valueint);
        ble_status_notify(ok ? "wifi: joining" : "wifi: start failed");
    } else {
        ble_status_notify("wifi: creds incomplete");
    }
    cJSON_Delete(root);
}

// --- GATT access -------------------------------------------------------------
static int gatt_info(struct ble_gatt_access_ctxt *ctxt) {
    char fp[9]; trust_fingerprint_hex(fp, sizeof fp);
    char json[224];   // +host_os; keep ample headroom under the INFO flatten buffer
    int n = snprintf(json, sizeof(json),
        "{\"kind\":\"asmltr-portal\",\"name\":\"%s\",\"fw\":\"%s\",\"trust\":\"%s\",\"anchor\":\"%s\",\"host_os\":\"%s\"}",
        s_name, FW_VERSION, trust_is_paired() ? "paired" : "unpaired", fp, usb_host_os());
    return os_mbuf_append(ctxt->om, json, n) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static int gatt_access(uint16_t conn, uint16_t attr, struct ble_gatt_access_ctxt *ctxt, void *arg) {
    const ble_uuid_t *u = ctxt->chr->uuid;

    if (ble_uuid_cmp(u, &INFO_UUID.u) == 0) return gatt_info(ctxt);

    // all remaining characteristics are writes — flatten the mbuf once. `buf` is static (not on the
    // NimBLE host task's small stack): access callbacks are serialized on that one task, so this is safe.
    static uint8_t buf[320]; uint16_t olen = 0;
    if (ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof buf, &olen) != 0) return BLE_ATT_ERR_UNLIKELY;

    if (ble_uuid_cmp(u, &LOAD_UUID.u) == 0) {
        const char *s = module_load_chunk(buf, olen);
        if (s) ble_status_notify(s);
        return 0;
    }
    if (ble_uuid_cmp(u, &RUN_UUID.u) == 0) {
        const char *s = module_run_staged();
        if (s) ble_status_notify(s);
        return 0;
    }
    if (ble_uuid_cmp(u, &PAIR_UUID.u) == 0) {
        bool ok = trust_pair(buf, olen);
        ble_status_notify(ok ? "pair: ok" : "pair: rejected");
        if (ok) portal_ui_led(0, 255, 40);          // green blip confirms a pair/un-pair
        return ok ? 0 : BLE_ATT_ERR_UNLIKELY;
    }
    if (ble_uuid_cmp(u, &EXEC_UUID.u) == 0) {       // driver command: [mode][data], chunked
        if (exec_chunk(buf, olen) && s_exec_asm_len >= 1)
            engine_submit_exec(s_exec_asm[0], s_exec_asm + 1, (int)s_exec_asm_len - 1);
        return 0;
    }
    if (ble_uuid_cmp(u, &WIFI_UUID.u) == 0) {       // Wi-Fi P2P creds handoff: JSON, chunked
        if (wifi_chunk(buf, olen)) apply_wifi_creds();
        return 0;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static const struct ble_gatt_svc_def gatt_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &SVC_UUID.u,
        .characteristics = (struct ble_gatt_chr_def[]){
            { .uuid = &INFO_UUID.u,   .access_cb = gatt_access, .flags = BLE_GATT_CHR_F_READ },
            { .uuid = &LOAD_UUID.u,   .access_cb = gatt_access, .flags = BLE_GATT_CHR_F_WRITE },
            { .uuid = &RUN_UUID.u,    .access_cb = gatt_access, .flags = BLE_GATT_CHR_F_WRITE },
            { .uuid = &STATUS_UUID.u, .access_cb = gatt_access, .flags = BLE_GATT_CHR_F_NOTIFY,
              .val_handle = &s_status_handle },
            { .uuid = &PAIR_UUID.u,   .access_cb = gatt_access, .flags = BLE_GATT_CHR_F_WRITE },
            { .uuid = &EXEC_UUID.u,   .access_cb = gatt_access, .flags = BLE_GATT_CHR_F_WRITE },
            { .uuid = &IOBACK_UUID.u, .access_cb = gatt_access, .flags = BLE_GATT_CHR_F_NOTIFY,
              .val_handle = &s_ioback_handle },
            { .uuid = &WIFI_UUID.u,   .access_cb = gatt_access, .flags = BLE_GATT_CHR_F_WRITE },
            { 0 }
        },
    },
    { 0 }
};

// --- GAP ---------------------------------------------------------------------
static int gap_event(struct ble_gap_event *event, void *arg) {
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        s_connected = (event->connect.status == 0);
        if (s_connected) {
            s_conn_handle = event->connect.conn_handle;
            // Self-heal: request a short (~6s) supervision timeout. If the central vanishes — phone
            // locked, app killed, out of range — the link is detected dead and dropped within ~6s and
            // we re-advertise on our own, instead of staying clamped until a physical replug.
            // supervision_timeout in 10ms units. 1800 = 18s: long enough that a LOCKED/DOZING phone's
            // BLE event gaps don't trip a false "central gone" (the blue/green→red→reconnect flap), still
            // short enough to drop a truly-dead central and re-advertise within ~18s. (Was 600/6s — too tight.)
            struct ble_gap_upd_params up = { .itvl_min = 24, .itvl_max = 40, .latency = 0, .supervision_timeout = 1800 };
            ble_gap_update_params(s_conn_handle, &up);
            ESP_LOGI(TAG, "central connected");
        } else advertise();   // failed — keep advertising
        break;
    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "central disconnected; re-advertising");
        s_connected = false; s_status_subscribed = false; s_ioback_subscribed = false;
        advertise();
        break;
    case BLE_GAP_EVENT_SUBSCRIBE:
        if (event->subscribe.attr_handle == s_status_handle) s_status_subscribed = event->subscribe.cur_notify;
        if (event->subscribe.attr_handle == s_ioback_handle) s_ioback_subscribed = event->subscribe.cur_notify;
        break;
    case BLE_GAP_EVENT_ADV_COMPLETE:
        advertise();
        break;
    default: break;
    }
    return 0;
}

static void advertise(void) {
    // adv packet (31B): flags + the 128-bit **service UUID**.  scan-rsp (31B): the complete name.
    // The UUID must be in the PRIMARY packet (not the scan response) so a central can run a *filtered*
    // scan for it — Android blocks UNFILTERED scans while the screen is off, and its hardware-offload
    // filter only sees the primary packet (no scan-request/response when screen-off). UUID-in-adv is
    // what lets the single-owner service DISCOVER the dongle with the phone locked / app closed.
    struct ble_hs_adv_fields adv = {0};
    adv.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    adv.uuids128 = (ble_uuid128_t *)&SVC_UUID; adv.num_uuids128 = 1; adv.uuids128_is_complete = 1;
    int rc = ble_gap_adv_set_fields(&adv);
    if (rc) { ESP_LOGE(TAG, "adv_set_fields rc=%d", rc); return; }

    struct ble_hs_adv_fields rsp = {0};
    rsp.name = (uint8_t *)s_name; rsp.name_len = strlen(s_name); rsp.name_is_complete = 1;
    ble_gap_adv_rsp_set_fields(&rsp);

    struct ble_gap_adv_params p = {0};
    p.conn_mode = BLE_GAP_CONN_MODE_UND;
    p.disc_mode = BLE_GAP_DISC_MODE_GEN;
    rc = ble_gap_adv_start(s_addr_type, NULL, BLE_HS_FOREVER, &p, gap_event, NULL);
    if (rc) ESP_LOGE(TAG, "adv_start rc=%d", rc);
    else    ESP_LOGI(TAG, "advertising as '%s'", s_name);
}

static void on_sync(void) {
    ble_hs_util_ensure_addr(0);
    ble_hs_id_infer_auto(0, &s_addr_type);
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_BT);
    snprintf(s_name, sizeof(s_name), "asmltr-portal-%02X%02X", mac[4], mac[5]);
    ble_svc_gap_device_name_set(s_name);
    advertise();
}

static void host_task(void *param) {
    nimble_port_run();            // returns only at nimble_port_stop()
    nimble_port_freertos_deinit();
}

void ble_init(void) {
    if (nvs_flash_init() == ESP_ERR_NVS_NO_FREE_PAGES) { nvs_flash_erase(); nvs_flash_init(); }
    trust_init();                 // load the paired anchor (needs NVS, which is now ready)
    if (nimble_port_init() != ESP_OK) { ESP_LOGE(TAG, "nimble_port_init failed"); return; }
    ble_svc_gap_init();
    ble_svc_gatt_init();
    ble_gatts_count_cfg(gatt_svcs);
    ble_gatts_add_svcs(gatt_svcs);
    ble_att_set_preferred_mtu(512);   // bigger ATT MTU → ~509 B per ioback notify (was ~180); grant up to central's ask
    ble_hs_cfg.sync_cb = on_sync;
    nimble_port_freertos_init(host_task);
    ESP_LOGI(TAG, "BLE init done (fw %s, trust %s)", FW_VERSION, trust_is_paired() ? "paired" : "unpaired");
}
