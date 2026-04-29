# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

PlatformIO project for an IdeaSpark ESP32 dev board with an onboard 0.96" SSD1306 OLED (128×64, I²C @ `0x3C`, SDA=GPIO21, SCL=GPIO22). Single Arduino-framework sketch in `src/main.cpp` that draws "Hello" via U8g2.

## Build / flash / monitor

PlatformIO CLI (`pio`) drives everything; there is no Makefile, no test runner, no linter configured.

- Build: `pio run`
- Upload to board: `pio run -t upload`
- Serial monitor: `pio device monitor` (115200 baud, configured in `platformio.ini`)
- Build + upload + monitor in one shot: `pio run -t upload -t monitor`
- Clean: `pio run -t clean`
- List attached serial ports (when the upload port changes): `pio device list`

The `upload_port` / `monitor_port` in `platformio.ini` is hard-coded to `/dev/cu.usbserial-10` (macOS, CH340/CP210x-style USB-UART). If the port differs on a given machine, override per invocation with `--upload-port` / `--monitor-port` rather than editing the file unless the change is permanent.

## Layout notes

- `platformio.ini` — single `env:esp32dev` (board `esp32dev`, framework `arduino`). `lib_deps` pulls `olikraus/U8g2`; do not vendor U8g2 manually.
- `src/main.cpp` — entire firmware. Standard Arduino `setup()` / `loop()`; the OLED is drawn once in `setup()` and `loop()` is empty.
- `.pio/` — PlatformIO build cache and downloaded libraries; never edit, never commit-worthy. Safe to delete; `pio run` regenerates it.

## Conventions

- Russian Cyrillic appears in source strings (e.g. `Serial.println("Hello отправлен на OLED")`); the file is UTF-8 — preserve encoding when editing.
- U8g2 is used in **full-buffer** mode (`..._F_HW_I2C`). Any drawing change must follow the `clearBuffer()` → draw → `sendBuffer()` pattern; partial-buffer (`_1_`/`_2_`) constructors require a different page loop.
