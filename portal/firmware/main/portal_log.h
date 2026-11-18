/* asmltr Portal — debug trace: capture ESP-IDF log lines into a boot-to-now PSRAM ring and mirror
 * them to the BLE STATUS notify (the dongle's UART console isn't exposed over USB). The ring is
 * replayed to a central on subscribe so the full history is recoverable even on a late connect. */
#pragma once

void portal_log_init(void);

/* Replay the entire retained log ring to the STATUS notify. Call when a central subscribes to STATUS
 * so a freshly-connected app receives the full boot→now trace, not just lines emitted after it joined. */
void portal_log_replay(void);
