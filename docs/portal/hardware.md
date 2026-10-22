# asmltr Portal — Hardware Reference

Board: **Waveshare ESP32-S3-LCD-1.47**. Identified by matching its backlight pin (GPIO48) to
Waveshare's official pinout; every pin below verified empirically or from the Waveshare schematic.
(Note: this is **not** a LilyGO T-Dongle-S3 — different vendor, pins, and controller.)

## Specs
- ESP32-S3 (QFN56) rev v0.2, dual LX7 @ 240 MHz + LP core, vector/AI SIMD.
- **16 MB** quad flash + **8 MB** octal PSRAM (N16R8).
- Wi-Fi b/g/n + **BLE 5 (LE only; no Bluetooth Classic / A2DP)**. Native USB-OTG (any USB device class).
- USB-A plug form factor, bus-powered.

## Pinout (verified)
| Function | GPIO | Notes |
|----------|------|-------|
| **LCD (ST7789, 172×320)** | | SPI2, 40 MHz, mode 0. X offset 34, Y 0. INVON for normal colors. |
| &nbsp;&nbsp;MOSI | 45 | |
| &nbsp;&nbsp;SCLK | 40 | |
| &nbsp;&nbsp;CS | 42 | |
| &nbsp;&nbsp;DC | 41 | |
| &nbsp;&nbsp;RST | 39 | |
| &nbsp;&nbsp;Backlight | **48** | **active-HIGH** (high=on) — verified via sweep |
| **RGB LED** | **38** | **WS2812B** single-wire (NOT APA102). Drive via RMT. |
| SD / TF (SDMMC) | CLK=14, CMD=15, D0=16, D1=18, D2=17, D3=21 | |
| BOOT button | 0 | the only physical control; multi-press + hold for menu |
| RESET button | — | hardware reset |

## NOT present (confirmed from schematic)
- **No microphone**, **no IMU**, **no speaker**, **no touch.**
- Only notable peripheral ICs: ESP32-S3, WS2812B (LED), SI2302 MOSFET (backlight). It's a display board.
- Free GPIOs for expansion: roughly **1–13, 43, 44, 46, 47**.

## Gotchas
- Firmware that grabs the **native USB-OTG** stack (TinyUSB HID/CDC/NET) makes the board drop its
  USB-Serial-JTAG port and re-enumerate (PID 1001→4001). Download mode still works, but some OSes keep a
  stale PnP node for the old port — disable/re-enable the composite device to recover. Design USB-class
  firmware as **composite** so a console survives alongside the device class.
- GPIO39/40 are JTAG pins (MTCK/MTDO) but used here for LCD RST/SCLK — fine as GPIO; `gpio_reset_pin`
  if ever flaky.
- Console is on **USB-Serial-JTAG** (`CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y`).

## Factory backup
Before first flashing a new board, dump its factory image so it can be restored:
```
esptool --chip esp32s3 --port <PORT> read-flash 0x0 0x1000000 factory-16MB.bin   # 16 MB
# restore:
esptool --chip esp32s3 --port <PORT> write-flash 0x0 factory-16MB.bin
```
Record the sha256 of the dump alongside the file.
