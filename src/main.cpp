#include <Arduino.h>
#include <U8g2lib.h>
#include <Wire.h>
#include <NimBLEDevice.h>

constexpr int OLED_SDA = 21;
constexpr int OLED_SCL = 22;
constexpr int HALL_PIN = 23;   // HW-492 anemometer hall sensor, active LOW

U8G2_SSD1306_128X64_NONAME_F_HW_I2C display(U8G2_R0, U8X8_PIN_NONE);

// BLE GATT identifiers. Random 128-bit UUIDs so the PWA filters specifically
// for our device.
static const char *BLE_DEVICE_NAME         = "ESP32-Anemo";
static const char *BLE_SERVICE_UUID        = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
static const char *BLE_TELEMETRY_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";

NimBLECharacteristic *telemetryChar = nullptr;
volatile bool         bleConnected  = false;

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *) override {
    bleConnected = true;
    Serial.println("[ble] connected");
  }
  void onDisconnect(NimBLEServer *) override {
    bleConnected = false;
    Serial.println("[ble] disconnected, restarting advertising");
    NimBLEDevice::startAdvertising();
  }
};

// Layout zones for two-color 0.96" SSD1306:
//   yellow band: y =  0..15  (use baseline ~ y=11 for 6x10 font)
//   gap        : y = 16..17  (avoid)
//   blue band  : y = 18..63
constexpr int Y_YELLOW   = 11;
constexpr int Y_BLUE_MID = 46;
constexpr int Y_BLUE_BOT = 61;

// CPU / RAM stats sampled in loop().
constexpr uint32_t STATS_WINDOW_MS = 1000;
uint64_t busyAccumUs   = 0;
uint32_t statsWindowAt = 0;
uint8_t  cpuPct        = 0;
uint8_t  ramPct        = 0;

// Anemometer: HW-492 hall sensor pulses each time a magnet on the rotor passes
// the chip. ISR counts edges; the 1 s stats tick samples and clears the counter
// to compute Hz / RPM.
volatile uint32_t hallEdgeCount = 0;
uint32_t windHz10    = 0;   // tenths of Hz, e.g. 23 == 2.3 Hz
uint32_t windRpm     = 0;
uint32_t totalPulses = 0;   // cumulative since boot, sent to PWA

static void IRAM_ATTR hallIsr() {
  hallEdgeCount++;
}

static void drawZoneFrames() {
  display.drawFrame(0, 0, 128, 16);
  display.drawFrame(0, 18, 128, 46);
}

static void beginFrame() {
  display.clearBuffer();
  drawZoneFrames();
}

static void drawHeaderStats() {
  char buf[28];
  snprintf(buf, sizeof(buf), "%s CPU %u%%  RAM %u%%",
           bleConnected ? "BT*" : "BT-",
           (unsigned)cpuPct, (unsigned)ramPct);
  display.setFont(u8g2_font_6x10_tr);
  int w = display.getStrWidth(buf);
  display.drawStr((128 - w) / 2, Y_YELLOW, buf);
}

static void drawCenteredAt(int y, const uint8_t *font, const char *text) {
  display.setFont(font);
  int w = display.getStrWidth(text);
  display.drawStr((128 - w) / 2, y, text);
}

static void renderAnemo() {
  beginFrame();
  drawHeaderStats();

  char rbuf[16];
  snprintf(rbuf, sizeof(rbuf), "%lu RPM", (unsigned long)windRpm);
  display.setFont(u8g2_font_logisoso16_tr);
  int w = display.getStrWidth(rbuf);
  display.drawStr(max(0, (128 - w) / 2), Y_BLUE_MID, rbuf);

  char hbuf[16];
  snprintf(hbuf, sizeof(hbuf), "%lu.%lu Hz",
           (unsigned long)(windHz10 / 10), (unsigned long)(windHz10 % 10));
  drawCenteredAt(Y_BLUE_BOT, u8g2_font_6x10_tr, hbuf);

  display.sendBuffer();
}

static void bleInit() {
  NimBLEDevice::init(BLE_DEVICE_NAME);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);   // max TX power for outdoor use

  NimBLEServer *srv = NimBLEDevice::createServer();
  srv->setCallbacks(new ServerCallbacks());

  NimBLEService *svc = srv->createService(BLE_SERVICE_UUID);
  telemetryChar = svc->createCharacteristic(
    BLE_TELEMETRY_CHAR_UUID,
    NIMBLE_PROPERTY::NOTIFY | NIMBLE_PROPERTY::READ);
  svc->start();

  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(BLE_SERVICE_UUID);
  adv->setScanResponse(true);
  NimBLEDevice::startAdvertising();
  Serial.println("[ble] advertising as " + String(BLE_DEVICE_NAME));
}

static void bleNotifyTelemetry(uint32_t windowPulses, uint32_t nowMs) {
  if (!telemetryChar || !bleConnected) return;
  char json[96];
  int n = snprintf(json, sizeof(json),
    "{\"hz\":%lu.%lu,\"rpm\":%lu,\"pulses\":%lu,\"total\":%lu,\"ms\":%lu}",
    (unsigned long)(windHz10 / 10), (unsigned long)(windHz10 % 10),
    (unsigned long)windRpm, (unsigned long)windowPulses,
    (unsigned long)totalPulses, (unsigned long)nowMs);
  if (n <= 0) return;
  telemetryChar->setValue((uint8_t *)json, n);
  telemetryChar->notify();
}

void setup() {
  Serial.begin(115200);
  delay(100);

  pinMode(HALL_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(HALL_PIN), hallIsr, FALLING);

  Wire.begin(OLED_SDA, OLED_SCL);
  display.begin();
  renderAnemo();

  bleInit();
}

void loop() {
  uint32_t iterStartUs = micros();
  uint32_t now = millis();
  busyAccumUs += micros() - iterStartUs;

  if (now - statsWindowAt >= STATS_WINDOW_MS) {
    uint32_t winMs = now - statsWindowAt;
    uint32_t pct = (uint32_t)(busyAccumUs / (winMs * 10ULL));
    cpuPct = pct > 100 ? 100 : (uint8_t)pct;
    busyAccumUs = 0;
    statsWindowAt = now;

    uint32_t total = ESP.getHeapSize();
    uint32_t freeb = ESP.getFreeHeap();
    ramPct = total ? (uint8_t)(((uint64_t)(total - freeb) * 100) / total) : 0;

    noInterrupts();
    uint32_t pulses = hallEdgeCount;
    hallEdgeCount = 0;
    interrupts();
    windHz10 = (uint32_t)((uint64_t)pulses * 10000ULL / winMs);
    windRpm  = (uint32_t)((uint64_t)pulses * 60000ULL / winMs);
    totalPulses += pulses;

    Serial.printf("anemo: %lu pulses/%lums -> %lu.%lu Hz, %lu RPM, total %lu\n",
                  (unsigned long)pulses, (unsigned long)winMs,
                  (unsigned long)(windHz10 / 10), (unsigned long)(windHz10 % 10),
                  (unsigned long)windRpm, (unsigned long)totalPulses);

    renderAnemo();
    bleNotifyTelemetry(pulses, now);
  }

  delay(10);
}
