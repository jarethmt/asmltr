// asmltr Portal — USB actuator (R4a). The dongle presents to the plugged-in host as a composite
// USB device: HID **keyboard + mouse** (so modules can drive the host, rubber-ducky style) + a CDC
// **serial console** (so we keep logs and — critically — a remote reflash path). See DESIGN §5.
//
// Escape hatch: a host app opening the CDC port at **1200 baud** triggers a reboot into ROM download
// mode (the Arduino convention), so esptool can reflash over the new port even though switching to
// the TinyUSB (OTG) stack drops the USB-Serial-JTAG port. Physical BOOT remains the ultimate backstop.
#include <string.h>
#include <strings.h>
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/stream_buffer.h"
#include "esp_log.h"
#include "esp_system.h"
#include "soc/rtc_cntl_reg.h"
#include "esp32s3/rom/usb/usb_dc.h"              // usb_dc_prepare_persist
#include "esp32s3/rom/usb/chip_usb_dw_wrapper.h" // chip_usb_set_persist_flags
#include "esp32s3/rom/usb/usb_persist.h"         // USBDC_PERSIST_ENA
#include "tinyusb.h"
#include "tusb_cdc_acm.h"
#include "tusb_console.h"
#include "usb_hid.h"
#include "portal_ui.h"
#include "ble.h"
#include "wifi_link.h"

static const char *TAG = "portal-usb";

enum { RID_KEYBOARD = 1, RID_MOUSE = 2 };

// ASCII (0..127) -> {needs_shift, HID keycode}, the stock TinyUSB table.
static const uint8_t conv_table[128][2] = { HID_ASCII_TO_KEYCODE };

// HID report descriptor: one keyboard + one mouse, distinguished by report ID.
static const uint8_t hid_report_desc[] = {
    TUD_HID_REPORT_DESC_KEYBOARD(HID_REPORT_ID(RID_KEYBOARD)),
    TUD_HID_REPORT_DESC_MOUSE(HID_REPORT_ID(RID_MOUSE)),
};

// Composite configuration: CDC (IAD, 2 interfaces) + HID (1 interface).
enum { ITF_NUM_CDC = 0, ITF_NUM_CDC_DATA, ITF_NUM_HID, ITF_NUM_TOTAL };
#define EPNUM_CDC_NOTIF 0x81
#define EPNUM_CDC_OUT   0x02
#define EPNUM_CDC_IN    0x82
#define EPNUM_HID       0x84
#define CONFIG_TOTAL_LEN (TUD_CONFIG_DESC_LEN + TUD_CDC_DESC_LEN + TUD_HID_DESC_LEN)

static const uint8_t config_desc[] = {
    TUD_CONFIG_DESCRIPTOR(1, ITF_NUM_TOTAL, 0, CONFIG_TOTAL_LEN, 0x00, 100),
    TUD_CDC_DESCRIPTOR(ITF_NUM_CDC, 4, EPNUM_CDC_NOTIF, 8, EPNUM_CDC_OUT, EPNUM_CDC_IN, 64),
    TUD_HID_DESCRIPTOR(ITF_NUM_HID, 5, HID_ITF_PROTOCOL_NONE, sizeof(hid_report_desc), EPNUM_HID, 16, 10),
};

static const tusb_desc_device_t device_desc = {
    .bLength = sizeof(tusb_desc_device_t),
    .bDescriptorType = TUSB_DESC_DEVICE,
    .bcdUSB = 0x0210,                      // 2.1 so the host fetches the BOS (enables MS-OS-2.0 OS detect)
    .bDeviceClass = TUSB_CLASS_MISC,       // composite via IAD
    .bDeviceSubClass = MISC_SUBCLASS_COMMON,
    .bDeviceProtocol = MISC_PROTOCOL_IAD,
    .bMaxPacketSize0 = CFG_TUD_ENDPOINT0_SIZE,
    .idVendor = 0x303A,                    // Espressif
    .idProduct = 0x4002,                   // asmltr Portal composite
    .bcdDevice = 0x0100,
    .iManufacturer = 1, .iProduct = 2, .iSerialNumber = 3,
    .bNumConfigurations = 1,
};

static const char *string_desc[] = {
    (char[]){0x09, 0x04},   // 0: langid en-US
    "asmltr",               // 1: manufacturer
    "asmltr Portal",        // 2: product
    "portal",               // 3: serial
    "asmltr Portal Console",// 4: CDC
    "asmltr Portal HID",    // 5: HID
};

// --- required TinyUSB HID callbacks (esp_tinyusb provides CDC's, not HID's) -------------------
uint8_t const *tud_hid_descriptor_report_cb(uint8_t instance) { (void)instance; return hid_report_desc; }
uint16_t tud_hid_get_report_cb(uint8_t instance, uint8_t report_id, hid_report_type_t type, uint8_t *buffer, uint16_t reqlen) {
    (void)instance; (void)report_id; (void)type; (void)buffer; (void)reqlen; return 0;
}
void tud_hid_set_report_cb(uint8_t instance, uint8_t report_id, hid_report_type_t type, uint8_t const *buffer, uint16_t bufsize) {
    (void)instance; (void)report_id; (void)type; (void)buffer; (void)bufsize;
}

// --- host OS detection (MS-OS-2.0 handshake → Windows; refined later by the CDC probe) ---------
static const char *s_host_os = "—";   // "—" (no host) | "connected" | "Windows" | later: exact via probe
const char *usb_host_os(void) { return s_host_os; }
void usb_host_os_set(const char *os) { if (os) s_host_os = os; }   // the CDC probe calls this with the exact OS

#define MS_VENDOR_CODE 0x17
#define MS_OS_20_DESC_LEN 0x0A
static const uint8_t ms_os_20_desc[] = {   // minimal set header — enough for Windows to send (= detect) it
    0x0A, 0x00,              // wLength
    0x00, 0x00,              // MS OS 2.0 descriptor set header
    0x00, 0x00, 0x03, 0x06,  // dwWindowsVersion = Win 8.1
    MS_OS_20_DESC_LEN, 0x00, // wTotalLength
};
#define BOS_TOTAL_LEN (TUD_BOS_DESC_LEN + TUD_BOS_MICROSOFT_OS_DESC_LEN)
static const uint8_t bos_desc[] = {
    TUD_BOS_DESCRIPTOR(BOS_TOTAL_LEN, 1),
    TUD_BOS_MS_OS_20_DESCRIPTOR(MS_OS_20_DESC_LEN, MS_VENDOR_CODE),
};
uint8_t const *tud_descriptor_bos_cb(void) { return bos_desc; }

// Windows (and only Windows) sends this vendor request for the MS OS 2.0 descriptor → detect it.
bool tud_vendor_control_xfer_cb(uint8_t rhport, uint8_t stage, tusb_control_request_t const *req) {
    if (stage != CONTROL_STAGE_SETUP) return true;
    if (req->bRequest == MS_VENDOR_CODE && req->wIndex == 7 /* MS OS 2.0 descriptor index */) {
        s_host_os = "Windows";
        ESP_LOGI(TAG, "host OS detected: Windows (MS-OS-2.0)");
        return tud_control_xfer(rhport, req, (void *)ms_os_20_desc, sizeof(ms_os_20_desc));
    }
    return false;
}

void tud_mount_cb(void)   { if (s_host_os[0] == 0 || !strcmp(s_host_os, "—")) s_host_os = "connected"; }
void tud_umount_cb(void)  { s_host_os = "—"; }

// --- remote reflash escape hatch ---------------------------------------------------------------
void usb_reboot_to_download(void) {
    // The proven native-USB "restart to serial bootloader" sequence (matches ESP-IDF's usb_console.c
    // and arduino-esp32's usb_persist_restart): persist the OTG controller across the reset, then set
    // the ROM force-download bit, then reset. Plain REG_SET_BIT + esp_restart alone does NOT stick.
    usb_dc_prepare_persist();
    chip_usb_set_persist_flags(USBDC_PERSIST_ENA);
    REG_WRITE(RTC_CNTL_OPTION1_REG, RTC_CNTL_FORCE_DOWNLOAD_BOOT);
    esp_restart();
}
static void on_line_coding(int itf, cdcacm_event_t *event) {
    (void)itf;
    const cdc_line_coding_t *lc = event->line_coding_changed_data.p_line_coding;
    if (lc && lc->bit_rate == 1200) { ESP_LOGW(TAG, "1200-baud touch -> download mode"); usb_reboot_to_download(); }
}

// --- CDC return channel: the host writes here (e.g. `cmd > \\.\COMx`), we relay it up -----------
// The feedback half of the generic driver (DESIGN §6a). For now: echo back (self-test from the host)
// + show the latest line on-screen + buffer it for the BLE relay (drained by usb_cdc_rx_take).
// The return buffer is a FreeRTOS stream buffer: single-producer (this rx callback) / single-consumer
// (ioback_task), lock-free, so a fast host burst can't race the drain and lose its tail — the bug that
// silently capped the old hand-rolled memmove buffer at ~one drain window (~180 B) and shredded anything
// larger (e.g. a screenshot). 16 KB absorbs a downscaled JPEG in flight.
static char   s_rxline[160]; static int s_rxlen = 0;
#define RX_STREAM_SZ 16384
static StreamBufferHandle_t s_rx_stream = NULL;

static void on_cdc_rx(int itf, cdcacm_event_t *event) {
    (void)event;
    uint8_t buf[128]; size_t rx = 0;
    if (tinyusb_cdcacm_read(itf, buf, sizeof buf, &rx) != ESP_OK || rx == 0) return;
    portal_ui_rx_flash();                                          // host -> dongle: cyan + mark activity
    if (s_rx_stream) xStreamBufferSend(s_rx_stream, buf, rx, 0);   // for the BLE relay (no echo — would loop the REPL)
    for (size_t i = 0; i < rx; i++) {                              // mirror the latest line to the screen
        char c = buf[i];
        if (c == '\n' || c == '\r' || s_rxlen >= (int)sizeof(s_rxline) - 1) {
            // In-place CDC panel (updates the body band only — no full clear, so a stream doesn't strobe).
            if (s_rxlen > 0) { s_rxline[s_rxlen] = 0; portal_ui_cdc_line(s_rxline); }
            s_rxlen = 0;
        } else s_rxline[s_rxlen++] = c;
    }
}

// Drain the return buffer (the BLE relay / app console calls this). Returns bytes copied.
int usb_cdc_rx_take(char *out, int max) {
    if (!s_rx_stream) return 0;
    return (int)xStreamBufferReceive(s_rx_stream, out, max, 0);   // non-blocking; take whatever's queued
}
// Write bytes to the host over CDC (dongle->host). Chunk to the TX FIFO with flush-waits so a large
// command (e.g. an 800 B+ screenshot-capture one-liner) can't outrun the FIFO and get truncated.
void usb_cdc_write(const char *data, int len) {
    portal_ui_tx_flash();   // dongle -> host: magenta + mark activity
    int off = 0;
    while (off < len) {
        size_t q = tinyusb_cdcacm_write_queue(TINYUSB_CDC_ACM_0, (const uint8_t *)data + off, len - off);
        off += (int)q;
        tinyusb_cdcacm_write_flush(TINYUSB_CDC_ACM_0, pdMS_TO_TICKS(20));
        if (q == 0) vTaskDelay(pdMS_TO_TICKS(2));   // FIFO full — let it drain, then continue
    }
}

// --- init --------------------------------------------------------------------------------------
// Drain the CDC return buffer and push it up over BLE (ioback). The app surfaces it as portal.io.
static void ioback_task(void *arg) {
    char buf[512];
    for (;;) {
        int n = usb_cdc_rx_take(buf, sizeof buf);
        if (n > 0) {
            // Transport selector: the Wi-Fi TCP socket (ordered + reliable) when it's up, else the
            // BLE ioback notify path (the fallback). ble_ioback_notify re-splits by the live MTU.
            if (wifi_link_active()) wifi_link_send((const uint8_t *)buf, n);
            else                    ble_ioback_notify((const uint8_t *)buf, n);
        } else vTaskDelay(pdMS_TO_TICKS(10));
    }
}

void usb_hid_init(void) {
    const tinyusb_config_t cfg = {
        .device_descriptor = &device_desc,
        .string_descriptor = string_desc,
        .string_descriptor_count = sizeof(string_desc) / sizeof(string_desc[0]),
        .external_phy = false,
        .configuration_descriptor = config_desc,
    };
    ESP_ERROR_CHECK(tinyusb_driver_install(&cfg));

    const tinyusb_config_cdcacm_t acm = {
        .usb_dev = TINYUSB_USBDEV_0,
        .cdc_port = TINYUSB_CDC_ACM_0,
        .rx_unread_buf_sz = 2048,                          // bigger FIFO so a host burst doesn't overflow
        .callback_rx = on_cdc_rx,                          // the return channel (host -> dongle)
        .callback_line_coding_changed = on_line_coding,    // 1200-baud -> download
    };
    tusb_cdc_acm_init(&acm);
    // NB: raw CDC (no esp_tusb_init_console) so RX goes to on_cdc_rx, not stdin. Logs go to UART.
    s_rx_stream = xStreamBufferCreate(RX_STREAM_SZ, 1);               // return-channel buffer (trigger level 1)
    xTaskCreate(ioback_task, "portal-ioback", 4096, NULL, 4, NULL);   // relay CDC-RX up over BLE
    ESP_LOGI(TAG, "TinyUSB composite up (HID keyboard+mouse + CDC return channel)");
}

bool usb_hid_ready(void) { return tud_mounted() && tud_hid_ready(); }

static bool wait_ready(int ms) {
    for (int i = 0; i < ms / 5 && !usb_hid_ready(); i++) vTaskDelay(pdMS_TO_TICKS(5));
    return usb_hid_ready();
}

void usb_hid_type(const char *str) {
    if (!str || !wait_ready(2000)) return;
    for (const char *p = str; *p; p++) {
        uint8_t c = (uint8_t)*p; if (c > 127) continue;
        uint8_t kc[6] = {0}; kc[0] = conv_table[c][1];
        uint8_t mod = conv_table[c][0] ? KEYBOARD_MODIFIER_LEFTSHIFT : 0;
        if (!kc[0]) continue;
        if (!wait_ready(500)) return;
        portal_ui_tx_flash();   // dongle -> host: magenta + mark activity
        tud_hid_keyboard_report(RID_KEYBOARD, mod, kc);
        vTaskDelay(pdMS_TO_TICKS(30));
        if (!wait_ready(500)) return;
        tud_hid_keyboard_report(RID_KEYBOARD, 0, NULL);    // release
        vTaskDelay(pdMS_TO_TICKS(30));
    }
}

// Send one key (optional modifiers) as press+release.
static void send_key(uint8_t mod, uint8_t kc) {
    // Hold each press/release well past the HID poll interval (~10ms) so no keystroke falls between
    // host polls and gets dropped. 30ms ≈ 3 polls each — reliable for blind scripting.
    if (!wait_ready(500)) return;
    portal_ui_tx_flash();   // dongle -> host: magenta + mark activity
    uint8_t k[6] = {0}; k[0] = kc;
    tud_hid_keyboard_report(RID_KEYBOARD, mod, k);
    vTaskDelay(pdMS_TO_TICKS(30));
    if (!wait_ready(500)) return;
    tud_hid_keyboard_report(RID_KEYBOARD, 0, NULL);
    vTaskDelay(pdMS_TO_TICKS(30));
}

static uint8_t modbit(const char *m) {
    if (!strcasecmp(m, "GUI") || !strcasecmp(m, "WIN") || !strcasecmp(m, "CMD")) return KEYBOARD_MODIFIER_LEFTGUI;
    if (!strcasecmp(m, "CTRL")) return KEYBOARD_MODIFIER_LEFTCTRL;
    if (!strcasecmp(m, "ALT"))  return KEYBOARD_MODIFIER_LEFTALT;
    if (!strcasecmp(m, "SHIFT"))return KEYBOARD_MODIFIER_LEFTSHIFT;
    return 0;
}

// Run a keystroke script: literal text types as-is; {KEY}/{COMBO}/{DELAY:ms} tokens (PORTAL-DRIVE.md §1).
void usb_hid_script(const char *s) {
    if (!s || !wait_ready(2000)) return;
    while (*s) {
        if (*s == '{' && s[1] == '{') {   // "{{" → literal '{' (so scripts can contain real braces)
            send_key(conv_table['{'][0] ? KEYBOARD_MODIFIER_LEFTSHIFT : 0, conv_table['{'][1]);
            s += 2; continue;
        }
        if (*s == '{') {
            const char *e = strchr(s, '}');
            if (!e) break;
            char tok[40]; int n = (int)(e - (s + 1)); if (n >= (int)sizeof tok) n = sizeof tok - 1;
            memcpy(tok, s + 1, n); tok[n] = 0; s = e + 1;
            if (!strncasecmp(tok, "DELAY:", 6)) { int ms = atoi(tok + 6); if (ms < 0) ms = 0; if (ms > 10000) ms = 10000; vTaskDelay(pdMS_TO_TICKS(ms)); continue; }
            uint8_t mod = 0; char *key = tok, *plus;
            while ((plus = strchr(key, '+')) != NULL) { *plus = 0; mod |= modbit(key); key = plus + 1; }
            uint8_t kc = 0;
            if      (!strcasecmp(key, "ENTER") || !strcasecmp(key, "RETURN")) kc = HID_KEY_ENTER;
            else if (!strcasecmp(key, "TAB"))                                 kc = HID_KEY_TAB;
            else if (!strcasecmp(key, "ESC") || !strcasecmp(key, "ESCAPE"))   kc = HID_KEY_ESCAPE;
            else if (!strcasecmp(key, "SPACE"))                               kc = HID_KEY_SPACE;
            else if (!strcasecmp(key, "BKSP") || !strcasecmp(key, "BACKSPACE")) kc = HID_KEY_BACKSPACE;
            else if (modbit(key)) mod |= modbit(key);   // a bare modifier token, e.g. {GUI}
            else if (strlen(key) == 1) { uint8_t c = (uint8_t)key[0]; if (c < 128) kc = conv_table[c][1]; }
            send_key(mod, kc);
        } else {
            uint8_t c = (uint8_t)*s++; if (c > 127) continue;
            uint8_t kc = conv_table[c][1];
            if (kc) send_key(conv_table[c][0] ? KEYBOARD_MODIFIER_LEFTSHIFT : 0, kc);
        }
    }
}

void usb_mouse_move(int dx, int dy, int wheel) {
    if (!wait_ready(1000)) return;
    tud_hid_mouse_report(RID_MOUSE, 0x00, (int8_t)dx, (int8_t)dy, (int8_t)wheel, 0);
}
void usb_mouse_click(uint8_t button) {
    if (!wait_ready(1000)) return;
    tud_hid_mouse_report(RID_MOUSE, button, 0, 0, 0, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
    tud_hid_mouse_report(RID_MOUSE, 0x00, 0, 0, 0, 0);
}
