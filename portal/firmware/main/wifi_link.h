#pragma once
#include <stdbool.h>
#include <stdint.h>
// asmltr Portal — Wi-Fi P2P data transport (the fast path; BLE stays as bootstrap + fallback).
//
// Model: the Android app is the Wi-Fi
// Direct *Group Owner*; the dongle joins that group as a plain STA ("legacy client") using the
// group's SSID/passphrase, which the app hands over via BLE at pair time (char 0x0A). The dongle
// then opens a TCP socket to the GO (default 192.168.49.1) and the drive protocol flows over it —
// ordered + reliable, so bulk transfers (screenshots, file contents) that BLE notifications dropped
// just work. We deliberately do NOT use SoftAP (that would steal the phone's internet station).
//
// Lazy + graceful: Wi-Fi is only brought up when the first creds arrive, and ANY failure (no RAM,
// no association, no socket) leaves wifi_link_active()==false so the caller silently stays on BLE.
//
// TCP framing, both directions: [len:2 big-endian][payload].
//   app -> dongle payload = [mode:1][data...]  (identical to the BLE exec char's [mode][data])
//   dongle -> app payload = raw ioback bytes    (identical to what ble_ioback_notify would send)

// Bring the dongle onto the app's Wi-Fi Direct group and connect the TCP data socket.
// Idempotent: a second call with new creds reconnects. Returns false if Wi-Fi can't even start
// (caller stays on BLE). Reaching active() still depends on association + socket, reported async.
bool wifi_link_start(const char *ssid, const char *pass, const char *go_ip, int port);

// Tear down the socket + disassociate (revert to BLE). Leaves the Wi-Fi stack initialized.
void wifi_link_stop(void);

// True once the TCP data socket to the GO is open — i.e. the fast path is live.
bool wifi_link_active(void);

// Send ioback bytes to the app over the TCP socket (framed). Returns bytes sent, or -1 if not active.
int wifi_link_send(const uint8_t *data, int len);
