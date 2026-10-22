#pragma once
#include <stdbool.h>
// Actuator surface the module engine drives, implemented by portal_main.c. All calls are bus-safe
// (internal mutex). While a module runs, the engine sets busy=true so the idle UI yields the screen.
void portal_ui_led(int r, int g, int b);                                   // WS2812 (0-255)
// A module frame: optional accent icon ("check"/"cross"/"lock"/"bolt"/"info"/"link"/"portal"/"dot"),
// a big wrapped title, a wrapped body, and an accent color (r,g,b) for the icon + title. Any may be NULL.
void portal_ui_screen(const char *icon, const char *title, const char *body, int r, int g, int b);
void portal_ui_progress(const char *label, int pct);                       // progress bar (0-100)
void portal_ui_set_busy(bool busy);
bool portal_ui_busy(void);

// A single host-output line, drawn into a persistent CDC panel that updates IN PLACE (no full-screen
// clear between lines, so a stream of output doesn't strobe). Call per completed line from the CDC rx.
void portal_ui_cdc_line(const char *line);

// Activity model: any CDC rx/tx / HID / exec is "activity". The idle UI treats the screen as busy
// while activity is recent (debounce window), so a live CDC/remote panel is never painted over.
void portal_ui_mark_activity(void);        // bump the last-activity timestamp
bool portal_ui_activity_active(void);      // true during the debounce window after the last activity

// Back LED (WS2812) data-direction flash: magenta = transmitting to host, cyan = receiving from host.
// Each call also marks activity. A decay task returns the LED to its ambient color after the flash.
void portal_ui_tx_flash(void);             // dongle -> host (HID keys, CDC writes, module data out)
void portal_ui_rx_flash(void);             // host -> dongle (CDC rx)
