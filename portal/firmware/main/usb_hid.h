#pragma once
#include <stdbool.h>
#include <stdint.h>
// asmltr Portal USB actuator (R4a) — composite HID keyboard+mouse + CDC console. See usb_hid.c.
void usb_hid_init(void);             // bring up TinyUSB; routes the console to the CDC port
bool usb_hid_ready(void);            // host enumerated + HID endpoint ready
void usb_hid_type(const char *str);  // type an ASCII string into the host (US layout)
void usb_hid_script(const char *s);  // run a keystroke script (literals + {KEY}/{COMBO}/{DELAY}) — PORTAL-DRIVE.md
void usb_mouse_move(int dx, int dy, int wheel);
void usb_mouse_click(uint8_t button);// 1=left, 2=right, 4=middle
void usb_reboot_to_download(void);   // force ROM download mode (remote reflash escape hatch)
const char *usb_host_os(void);       // detected host OS ("—"/"connected"/"Windows"/exact)
void usb_host_os_set(const char *os);
int  usb_cdc_rx_take(char *out, int max);  // drain host->dongle return bytes (for the BLE relay)
void usb_cdc_write(const char *data, int len); // dongle->host over CDC (session bridge commands)
