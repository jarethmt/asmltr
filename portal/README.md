# asmltr Portal 🌀

A **physical key that manifests an asmltr agent on a device.** Plug the Portal (a USB dongle) into a
machine, watch its screen narrate the process, and your assistant is enrolled onto it and reachable —
no manual VPN setup, no hand-copied SSH keys. Pull it out, run teardown, and the link is cleanly
removed.

Portals are first-class to an asmltr install: this firmware is tracked in the repo so an asmltr
instance can **flash and provision a Portal straight from the dashboard** when one is plugged in.

- **Hardware:** Waveshare ESP32-S3-LCD-1.47 (ESP32-S3 N16R8, ST7789 LCD, WS2812 LED, native USB-A).
- **Firmware:** ESP-IDF v5.5.6, target `esp32s3`. The mesh client lives in
  [`firmware/components/esp_olm`](firmware/components/esp_olm).

## Full documentation

Everything — the architecture, hardware pinout, build/flash pipeline, control + drive protocols — lives
in the docs site under **[Networking & devices → Portal](https://jarethmt.github.io/asmltr/portal/)**
(source in [`docs/portal/`](../docs/portal/)).

## Quick build

```bash
source /path/to/esp-idf/export.sh
cd firmware && idf.py set-target esp32s3 && idf.py build
```

See [docs/portal/build.md](../docs/portal/build.md) for flashing and the staged roadmap.
