# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ESP32-based **wind-speed meter (anemometer)** with a paired **PWA** for live readout and calibration. The firmware is a single Arduino-framework sketch; the PWA is served from `docs/` and talks to the device over **Web Bluetooth** (no Wi-Fi anywhere in this project).

The local directory is named `esp32-hello` for legacy reasons; the GitHub remote is `IKSIN/my-anemometer`.

## Hardware

- ESP32 dev board (board id `esp32dev`).
- **Single** two-colour 0.96" SSD1306 OLED, I²C @ `0x3C`, `SDA=GPIO21`, `SCL=GPIO22`. Two-colour means a fixed split: yellow band `y=0..15`, gap `y=16..17` (do not draw here), blue band `y=18..63`. Layout constants in `src/main.cpp` (`Y_YELLOW`, `Y_BLUE_MID`, `Y_BLUE_BOT`) encode this — preserve them when rearranging the screen.
- **HW-492 hall sensor** on `GPIO23`, `INPUT_PULLUP`, active LOW. One magnet on the rotor → one falling edge per revolution. The ISR (`hallIsr`) only increments a counter; all math happens in the 1 s stats tick in `loop()`.

## Firmware (`src/main.cpp`)

Single file, ~340 lines. Standard Arduino `setup()` / `loop()`. Major blocks:

- **Stats window** (1000 ms): samples `hallEdgeCount`, computes `windHz10` (tenths of Hz, integer), `windRpm`, `cpuPct`, `ramPct`, then re-renders the OLED and notifies BLE.
- **Calibration model:** `v_mps = windK * Hz + windB`. `windK == 0` means uncalibrated and the OLED shows `uncal` instead of a number. Display unit (`kn` / `mps` / `kmh`) is a separate setting from the model.
- **NVS** via `Preferences`: namespace `anemo`, keys `k` (float), `b` (float), `unit` (string `"kn"|"mps"|"kmh"`). Loaded once in `setup()`, re-saved whenever BLE config write changes anything.
- **BLE (NimBLE-Arduino), Nordic UART–style UUIDs:**
  - service `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
  - **telemetry** char `…0002…` — NOTIFY/READ, JSON `{"hz":..,"rpm":..,"pulses":..,"total":..,"ms":..,"v_mps":..}`, pushed once per stats window.
  - **config** char `…0003…` — READ/WRITE/NOTIFY, JSON `{"k":..,"b":..,"unit":".."}`. The on-device JSON parser (`parseAndApplyConfig`) is hand-rolled and only understands this exact shape — don't add fields without extending it. Any subset of keys is accepted; missing keys leave current values intact.
- Device advertises as `ESP32-Anemo`. Auto-restarts advertising on disconnect.

## PWA (`docs/`)

Plain static site, no bundler. `docs/` is the conventional GitHub Pages source root — keep it self-contained (no build step, no imports outside `docs/`).

- `index.html` — two tabs: **Monitor** (live charts, rolling min/avg/max, preview-`k` chart) and **Calibration** (live readout, sessions, linear-fit table, manual `(Hz, wind)` entry, push to device).
- `app.js` (~1200 lines) — Web Bluetooth client, GPS via `geolocation.watchPosition`, IndexedDB-backed sessions, Chart.js rendering, two linear fits (`v=k·f` and `v=k·f+b`) with R².
- `sw.js` — service worker, cache-first for the listed assets.
- `lib/chart.umd.min.js` — vendored Chart.js. Don't replace with a CDN URL; the PWA must work offline once installed.
- `manifest.json` — installable PWA (`Anemo`).

### Versioning rule (important)

Two constants must stay in lockstep, or the footer will lie about which build is running:

- `CACHE` in `docs/sw.js` (e.g. `'anemo-calib-v8'`)
- `APP_VERSION` in `docs/app.js` (e.g. `'v8'`)

Bump **both** whenever any cached asset (`index.html`, `app.js`, `style.css`, `manifest.json`, `icon.svg`, `lib/chart.umd.min.js`) changes. Forgetting to bump `CACHE` means clients keep serving the old asset list from the previous SW.

### BLE UUIDs are duplicated

The same three UUIDs live in `src/main.cpp` and `docs/app.js`. If you rotate them, change both sides in the same commit.

### Local PWA testing

Web Bluetooth requires a secure context. Two options:

- Run the device + open the PWA on `http://localhost:<port>` (e.g. `python3 -m http.server -d docs 8000`). `localhost` counts as secure.
- Push to `main` and use the GitHub Pages URL (HTTPS).

File-protocol (`file://`) won't work — Web Bluetooth and service workers are both blocked there.

## Build / flash / monitor (firmware)

PlatformIO CLI (`pio`) drives everything; there is no Makefile, no test runner, no linter configured.

- Build: `pio run`
- Upload: `pio run -t upload`
- Serial monitor: `pio device monitor` (115200 baud)
- Build + upload + monitor: `pio run -t upload -t monitor`
- Clean: `pio run -t clean`
- List serial ports: `pio device list`

`upload_port` / `monitor_port` in `platformio.ini` is hard-coded to `/dev/cu.usbserial-10` (macOS, CH340/CP210x USB-UART). If the port differs on a given machine, override per invocation with `--upload-port` / `--monitor-port` rather than editing the file unless the change is permanent.

## Layout

- `platformio.ini` — single `env:esp32dev`. `lib_deps`: `olikraus/U8g2`, `h2zero/NimBLE-Arduino`. Don't vendor either manually.
- `src/main.cpp` — entire firmware.
- `docs/` — PWA (also the GitHub Pages source).
- `.pio/` — PlatformIO build cache and downloaded libraries; never edit, never commit. Safe to delete; `pio run` regenerates it.

## Conventions

- Russian Cyrillic may appear in source strings; files are UTF-8 — preserve encoding when editing.
- U8g2 is used in **full-buffer** mode (`..._F_HW_I2C`). Any drawing change must follow the `clearBuffer()` → draw → `sendBuffer()` pattern; partial-buffer (`_1_`/`_2_`) constructors require a different page loop.
- The on-device BLE JSON parser is intentionally tiny and tolerant (any subset of `k`/`b`/`unit`). If you need to send richer data from the PWA, extend the parser rather than swapping in a JSON library — RAM and flash are the constraint, not parsing convenience.
- ISR (`hallIsr`) is `IRAM_ATTR` and touches only `volatile uint32_t hallEdgeCount`. Keep it that way; do not call non-IRAM code or floating-point math from it.
