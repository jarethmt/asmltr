# asmltr Portal — Build Guide & Roadmap

## Toolchain
ESP-IDF **v5.5.6**, target **esp32s3**. The firmware is a standard ESP-IDF project under `firmware/`.

## Build
```bash
source /path/to/esp-idf/export.sh
cd firmware
idf.py set-target esp32s3
idf.py build
```
Artifacts land in `firmware/build/`:
`bootloader/bootloader.bin`, `partition_table/partition-table.bin`, `asmltr_portal.bin`.

## Flash
Full image (first flash / after a partition change):
```bash
esptool --chip esp32s3 --port <PORT> --baud 921600 --after hard-reset write-flash \
  0x0 build/bootloader/bootloader.bin \
  0x8000 build/partition_table/partition-table.bin \
  0x10000 build/asmltr_portal.bin
```
App-only reflash (fast iteration):
```bash
esptool --chip esp32s3 --port <PORT> --baud 921600 write-flash 0x10000 build/asmltr_portal.bin
```
> The board re-enumerates its serial port when firmware claims native USB-OTG — see
> [HARDWARE.md](hardware.md) gotchas. Pick the port that appears after a reset.

## Verify
Console is on USB-Serial-JTAG. Capture boot output (reset via RTS pulse or the RESET button) and
confirm the identity screen, free-heap report, and — once configured — the mesh link coming up.

## Staged roadmap (rungs)

- **R0 — toolchain + display** ✅ ST7789 172×320 driving (colors confirmed).
- **R1 — Portal UI shell** ✅ screen states (identity → menu → confirm → working → done/error),
  font/text rendering, BOOT-button menu (single=next, hold=select).
- **R2 — WS2812 status LED** ✅ mirror state (idle/working/done); TX/RX activity colors.
- **R3 — BLE control link + loader engine** ✅ GATT peripheral (`load`/`run`/`status`/`info`/`exec`);
  signed script-modules over BLE; trust-gated (paired + signed) from the start — the anti-BadUSB line.
- **R4 — Phone bridge (asmltr app)** ✅ BLE link; live status; approval surface; HID/CDC drive path.
- **R5 — Mesh client (`esp_olm`)** ⬅ *in progress*: the portal joins the asmltr mesh (Pangolin) as a
  first-class node by speaking the `olm` protocol natively in firmware (relay mode; no NAT holepunch).
  Wi-Fi + mesh identity are provisioned to NVS by the app/dashboard — never baked into firmware.
- **R6 — Deterministic provisioning from the dashboard**: buy a board → flash from the GUI → it enrolls
  against the asmltr instance in one step.
- **R7 — Host profiles**: Linux / Windows / Android detect → enroll → phone-home → teardown.
- **R8 — Remote-desktop tie-in**: console + GUI relay through the mesh.
- **R9 — Escalate-to-assistant + self-teaching library**: unknown target → observed data to the
  assistant → live probe → new profile committed.
- **R10 — Security hardening**: flash encryption + secure boot + eFuse; ephemeral/scoped/revocable
  creds; mutual auth + audit; on-device encrypted key vault.

## Out of scope
iOS (USB can't). Lock-screen/auth bypass. Exploit/CVE access (authorized-engagement-only future module,
never core).
