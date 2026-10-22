#pragma once
#include <stdbool.h>
// asmltr Portal BLE control link. Advertises as "asmltr-portal-XXXX" and exposes a GATT service
// (info / load / run / status / pair). See ble.c and docs/PORTAL-PROTOCOL.md.
void ble_init(void);
bool ble_is_connected(void);          // for the UI/LED to reflect link state
const char *ble_device_name(void);    // "asmltr-portal-XXXX" (valid after ble_init)
void ble_status_notify(const char *line);  // push a progress/result line to a subscribed central
void ble_ioback_notify(const uint8_t *data, int len); // push the host CDC return stream (ioback)
