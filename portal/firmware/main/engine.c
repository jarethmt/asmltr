// asmltr Portal — the loader engine task. It owns BOTH the heavy signature-verify (finalize) and the
// step-DSL execution (run), so neither runs on the NimBLE host task (whose small stack Ed25519 verify
// overflows). The BLE callbacks just enqueue a command here. See PORTAL-PROTOCOL.md.
//
// v1 opcodes drive the actuators the hardware has today: led / screen / progress / wait / status.
// `type`/`keys` (USB-HID keystroke injection) is the R4 rung — recognized, reported as deferred.
#include <string.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_log.h"
#include "cJSON.h"
#include "engine.h"
#include "module.h"
#include "portal_ui.h"
#include "usb_hid.h"
#include "ble.h"

static const char *TAG = "portal-engine";

#define STAGE_MAX 8192
static char          s_staged[STAGE_MAX + 1];
static bool          s_have = false;
static volatile bool s_busy = false;
static TaskHandle_t  s_task = NULL;
static QueueHandle_t s_cmdq = NULL;

enum { CMD_FINALIZE = 1, CMD_RUN = 2, CMD_EXEC = 3 };

// exec staging: a driver command from the controller (keystroke script or CDC bytes). Commands are
// sequential (the controller waits for ioback before the next), so a single buffer is fine.
#define EXEC_MAX 2048
static char    s_exec[EXEC_MAX + 1];
static int     s_exec_len = 0;
static uint8_t s_exec_mode = 0;   // 1 = HID keystroke script, 2 = CDC write-through

bool engine_is_busy(void) { return s_busy; }

bool engine_stage(const uint8_t *json, size_t len) {
    if (len > STAGE_MAX) return false;
    memcpy(s_staged, json, len);
    s_staged[len] = '\0';           // NUL-terminate so cJSON_Parse is safe
    s_have = true;
    return true;
}

static void notify(const char *s) { ble_status_notify(s); ESP_LOGI(TAG, "%s", s); }

static int int_field(cJSON *obj, const char *k, int dflt) {
    cJSON *v = cJSON_GetObjectItem(obj, k);
    return (v && cJSON_IsNumber(v)) ? v->valueint : dflt;
}
static const char *str_field(cJSON *obj, const char *k) {
    cJSON *v = cJSON_GetObjectItem(obj, k);
    return (v && cJSON_IsString(v)) ? v->valuestring : NULL;
}
// Named colors → RGB (module authors write "cyan", not raw triples). Defaults to violet.
static void color_rgb(const char *name, int *r, int *g, int *b) {
    *r = 139; *g = 92; *b = 246;
    if (!name) return;
    if      (!strcmp(name, "violet"))                         { *r=139; *g=92;  *b=246; }
    else if (!strcmp(name, "magenta") || !strcmp(name, "pink")){ *r=236; *g=72;  *b=153; }
    else if (!strcmp(name, "cyan"))                           { *r=34;  *g=211; *b=238; }
    else if (!strcmp(name, "green"))                          { *r=34;  *g=197; *b=94;  }
    else if (!strcmp(name, "amber") || !strcmp(name, "yellow")){ *r=245; *g=158; *b=11;  }
    else if (!strcmp(name, "red"))                            { *r=239; *g=68;  *b=68;  }
    else if (!strcmp(name, "blue"))                           { *r=59;  *g=130; *b=246; }
    else if (!strcmp(name, "white"))                          { *r=255; *g=255; *b=255; }
}


static void run_module(void) {
    cJSON *root = cJSON_Parse(s_staged);
    if (!root) { notify("run: bad JSON"); return; }

    cJSON *name = cJSON_GetObjectItem(root, "name");
    char line[256];   // narration buffer — must exceed a joined body (160) plus a prefix
    snprintf(line, sizeof line, "Running: %s", cJSON_IsString(name) ? name->valuestring : "module");
    notify(line);

    cJSON *steps = cJSON_GetObjectItem(root, "steps");
    if (!cJSON_IsArray(steps)) { notify("run: no steps[]"); cJSON_Delete(root); return; }

    portal_ui_set_busy(true);       // take the screen from the idle UI loop for the duration
    int n = cJSON_GetArraySize(steps);
    for (int i = 0; i < n; i++) {
        cJSON *st = cJSON_GetArrayItem(steps, i);
        const char *op = str_field(st, "op"); if (!op) op = "";

        if (!strcmp(op, "led")) {
            const char *cname = str_field(st, "color");
            int r, g, b;
            if (cname) color_rgb(cname, &r, &g, &b);
            else { r = int_field(st, "r", 0); g = int_field(st, "g", 0); b = int_field(st, "b", 0); }
            portal_ui_led(r, g, b);
            snprintf(line, sizeof line, "LED: %s", cname ? cname : "custom"); notify(line);
        } else if (!strcmp(op, "screen")) {
            const char *icon  = str_field(st, "icon");
            const char *title = str_field(st, "title");
            const char *body  = str_field(st, "body");
            char bodybuf[160];
            if (!body) {   // backward-compat: join a lines[] array into the body
                cJSON *ls = cJSON_GetObjectItem(st, "lines");
                if (cJSON_IsArray(ls)) {
                    bodybuf[0] = '\0';
                    int m = cJSON_GetArraySize(ls);
                    for (int k = 0; k < m; k++) { cJSON *e = cJSON_GetArrayItem(ls, k);
                        if (cJSON_IsString(e)) { if (bodybuf[0]) strncat(bodybuf, " ", sizeof(bodybuf)-strlen(bodybuf)-1); strncat(bodybuf, e->valuestring, sizeof(bodybuf)-strlen(bodybuf)-1); } }
                    body = bodybuf;
                }
            }
            int r, g, b; color_rgb(str_field(st, "color"), &r, &g, &b);
            portal_ui_screen(icon, title, body, r, g, b);
            snprintf(line, sizeof line, "Screen: %s", title ? title : (body ? body : "(frame)")); notify(line);
        } else if (!strcmp(op, "progress")) {
            const char *l = str_field(st, "label"); int pct = int_field(st, "pct", 0);
            portal_ui_progress(l ? l : "", pct);
            snprintf(line, sizeof line, "%s — %d%%", l ? l : "progress", pct); notify(line);
        } else if (!strcmp(op, "wait")) {
            int d = int_field(st, "ms", 0); if (d < 0) d = 0; if (d > 10000) d = 10000;
            vTaskDelay(pdMS_TO_TICKS(d));
        } else if (!strcmp(op, "status")) {
            const char *x = str_field(st, "text");
            notify(x ? x : "");
        } else if (!strcmp(op, "type") || !strcmp(op, "keys")) {
            const char *t = str_field(st, "text");
            if (t) { snprintf(line, sizeof line, "Typing into host: %.80s", t); notify(line); usb_hid_type(t); }
        } else if (!strcmp(op, "move")) {
            usb_mouse_move(int_field(st, "dx", 0), int_field(st, "dy", 0), int_field(st, "wheel", 0));
            notify("Mouse: move");
        } else if (!strcmp(op, "click")) {
            usb_mouse_click((uint8_t)int_field(st, "button", 1));
            notify("Mouse: click");
        } else {
            snprintf(line, sizeof line, "run: unknown op '%s'", op); notify(line);
        }
    }
    cJSON_Delete(root);
    notify("Done.");
    // Leave the final frame up (portal_ui stays busy) — the UI holds it and never repaints over it.
    // The user taps the dongle button to dismiss it back to the idle screen. A later run just redraws.
}

static void engine_task(void *arg) {
    uint8_t c;
    for (;;) {
        if (xQueueReceive(s_cmdq, &c, portMAX_DELAY) != pdTRUE) continue;
        s_busy = true;
        if (c == CMD_FINALIZE) {
            const char *r = module_finalize();   // heavy Ed25519 verify — safe on this task's big stack
            notify(r);
        } else if (c == CMD_RUN) {
            if (!s_have) notify("run: no module staged");
            else run_module();
        } else if (c == CMD_EXEC) {
            char snip[48]; snprintf(snip, sizeof snip, "%.44s", s_exec);   // on-screen feedback (operator command + probe)
            // No fixed busy/1200ms hold: mark activity so the idle UI yields and the panel holds for the
            // debounce window after the LAST write. Back-to-back commands keep re-marking, so the remote
            // panel stays stable instead of tearing down and snapping back between each one.
            portal_ui_mark_activity();
            portal_ui_screen("link", s_exec_mode == 1 ? "Remote: keys" : "Remote: cmd", snip, 34, 211, 238);
            if (s_exec_mode == 1) usb_hid_script(s_exec);          // type a keystroke script via HID (TX-flashes)
            else if (s_exec_mode == 2) usb_cdc_write(s_exec, s_exec_len); // write-through to the host over CDC (TX-flashes)
            portal_ui_screen("check", "Remote done", snip, 34, 197, 94);
            portal_ui_led(34, 197, 94);     // green ambient while the done frame holds
            portal_ui_mark_activity();      // extend the debounce past this command
        }
        s_busy = false;
    }
}

void engine_init(void) {
    s_cmdq = xQueueCreate(4, sizeof(uint8_t));
    // 12 KB: Ed25519 verify + cJSON parse both want headroom (they run at different times, same stack).
    xTaskCreate(engine_task, "portal-engine", 12288, NULL, 4, &s_task);
}

void engine_request_finalize(void) { uint8_t c = CMD_FINALIZE; if (s_cmdq) xQueueSend(s_cmdq, &c, 0); }

// A driver command from the controller (BLE exec): mode 1 = HID keystroke script, 2 = CDC write-through.
void engine_submit_exec(uint8_t mode, const uint8_t *data, int len) {
    if (len < 0) len = 0;
    if (len > EXEC_MAX) len = EXEC_MAX;
    memcpy(s_exec, data, len); s_exec[len] = 0;
    s_exec_len = len; s_exec_mode = mode;
    uint8_t c = CMD_EXEC; if (s_cmdq) xQueueSend(s_cmdq, &c, 0);
}

const char *engine_run_staged(void) {
    if (!s_have) return "run: no module staged";
    if (s_busy)  return "run: busy";
    uint8_t c = CMD_RUN;
    if (s_cmdq) xQueueSend(s_cmdq, &c, 0);
    return "run: triggered";
}
