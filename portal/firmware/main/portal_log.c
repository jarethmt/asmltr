/* asmltr Portal — ESP_LOG capture: a boot-to-now RAM ring + live BLE forward.
 *
 * Every ESP_LOG line is sanitized (ANSI/newlines stripped) and stored in a PSRAM ring buffer that
 * survives from boot, independent of whether anyone is connected. A low-priority drain task forwards
 * NEW lines to the BLE STATUS characteristic as they happen. Critically, when a central subscribes to
 * STATUS, the firmware REPLAYS the whole ring (portal_log_replay) — so the app gets the full history
 * (boot, Wi-Fi join, olm connect, route programming, drive-agent start) even though it connected long
 * after those lines were emitted. That ends the "connected too late → boot logs lost" problem that made
 * the mesh chain impossible to debug. The ring lives in PSRAM so retention costs no internal heap.
 * SPDX: BSD-3-Clause
 */
#include "portal_log.h"
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdarg.h>
#include "ble.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#define LINE_MAX    120
#define Q_DEPTH     64
#define RING_LINES  256            /* ~30 KB in PSRAM — holds a full boot + several minutes of trace  */

static QueueHandle_t   s_q;
static vprintf_like_t  s_orig;

/* boot-to-now ring (PSRAM) */
static char          (*s_ring)[LINE_MAX];
static int             s_ring_head;    /* next slot to write */
static int             s_ring_count;   /* valid lines, saturating at RING_LINES */
static volatile bool   s_replay_req;   /* set by portal_log_replay(), served by the drain task */

/* copy src→dst dropping ANSI escape sequences (ESC … 'm') and CR/LF; NUL-terminate */
static void sanitize(const char *src, int n, char *dst)
{
    int di = 0;
    for (int i = 0; i < n && di < LINE_MAX - 1; i++) {
        char c = src[i];
        if (c == 0x1b) { while (i < n && src[i] != 'm') i++; continue; }
        if (c == '\n' || c == '\r') continue;
        dst[di++] = c;
    }
    dst[di] = 0;
}

static void ring_put(const char *line)
{
    if (!s_ring) return;
    strlcpy(s_ring[s_ring_head], line, LINE_MAX);
    s_ring_head = (s_ring_head + 1) % RING_LINES;
    if (s_ring_count < RING_LINES) s_ring_count++;
}

static int log_vprintf(const char *fmt, va_list ap)
{
    va_list ap2; va_copy(ap2, ap);
    char buf[192];
    int n = vsnprintf(buf, sizeof buf, fmt, ap2);
    va_end(ap2);
    if (n > 0 && s_q) {
        char line[LINE_MAX];
        sanitize(buf, n < (int)sizeof buf ? n : (int)sizeof buf - 1, line);
        /* Break the feedback loop: forwarding a line over BLE makes NimBLE log a "GATT procedure
         * initiated: notify" line, which would come straight back here and drown the real trace.
         * Never store/forward NimBLE's own chatter. */
        if (line[0] && !strstr(line, "NimBLE")) {
            ring_put(line);                 /* retain from boot, regardless of BLE state */
            xQueueSend(s_q, line, 0);        /* and forward live if a central is listening */
        }
    }
    return s_orig ? s_orig(fmt, ap) : n;          /* keep UART output too */
}

/* Replay the whole ring (oldest→newest) to the STATUS notify, bracketed by markers so the reader can
 * tell a history dump from live lines. Runs on the drain task so it never blocks a logging caller. */
static void do_replay(void)
{
    ble_status_notify("=== log replay (boot->now) ===");
    vTaskDelay(pdMS_TO_TICKS(40));
    int start = (s_ring_count < RING_LINES) ? 0 : s_ring_head;
    for (int i = 0; i < s_ring_count; i++) {
        ble_status_notify(s_ring[(start + i) % RING_LINES]);
        vTaskDelay(pdMS_TO_TICKS(25));       /* pace so NimBLE's notify queue doesn't overflow */
    }
    ble_status_notify("=== end replay ===");
}

static void drain_task(void *arg)
{
    (void)arg;
    char line[LINE_MAX];
    for (;;) {
        if (s_replay_req) { s_replay_req = false; do_replay(); }
        /* short timeout so the replay request is served promptly even when idle */
        if (xQueueReceive(s_q, line, pdMS_TO_TICKS(200)) == pdTRUE) {
            ble_status_notify(line);              /* no-op if no central subscribed */
            vTaskDelay(pdMS_TO_TICKS(40));        /* rate-limit the notifies */
        }
    }
}

void portal_log_replay(void) { s_replay_req = true; }

void portal_log_init(void)
{
    s_ring = heap_caps_malloc(sizeof(char[RING_LINES][LINE_MAX]), MALLOC_CAP_SPIRAM);
    if (!s_ring) s_ring = heap_caps_malloc(sizeof(char[RING_LINES][LINE_MAX]), MALLOC_CAP_8BIT);
    s_ring_head = 0; s_ring_count = 0;
    s_q = xQueueCreate(Q_DEPTH, LINE_MAX);
    if (!s_q) return;
    xTaskCreate(drain_task, "portal-log", 3072, NULL, 1, NULL);
    s_orig = esp_log_set_vprintf(log_vprintf);
}
