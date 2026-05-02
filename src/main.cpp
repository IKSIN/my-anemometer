#include <Arduino.h>
#include <U8g2lib.h>
#include <Wire.h>
#include <NimBLEDevice.h>
#include <Preferences.h>

constexpr int OLED_SDA = 21;
constexpr int OLED_SCL = 22;
constexpr int HALL_PIN = 23;   // HW-492 anemometer hall sensor, active LOW

U8G2_SSD1306_128X64_NONAME_F_HW_I2C display(U8G2_R0, U8X8_PIN_NONE);

// BLE GATT identifiers. Random 128-bit UUIDs so the PWA filters specifically
// for our device.
static const char *BLE_DEVICE_NAME         = "ESP32-Anemo";
static const char *BLE_SERVICE_UUID        = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
static const char *BLE_TELEMETRY_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
static const char *BLE_CONFIG_CHAR_UUID    = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

NimBLECharacteristic *telemetryChar = nullptr;
NimBLECharacteristic *configChar    = nullptr;
volatile bool         bleConnected  = false;

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

// Calibration: v_mps = windK * Hz + windB. Persisted in NVS, configurable over
// BLE from the PWA. Default k=0 means "uncalibrated"; the OLED shows "uncal".
enum WindUnit { UNIT_KN = 0, UNIT_MPS = 1, UNIT_KMH = 2 };
float    windK    = 0.0f;
float    windB    = 0.0f;
WindUnit windUnit = UNIT_KN;

Preferences prefs;

static const char *unitToStr(WindUnit u) {
  switch (u) {
    case UNIT_MPS: return "mps";
    case UNIT_KMH: return "kmh";
    case UNIT_KN:
    default:       return "kn";
  }
}

static const char *unitLabel(WindUnit u) {
  switch (u) {
    case UNIT_MPS: return "m/s";
    case UNIT_KMH: return "km/h";
    case UNIT_KN:
    default:       return "kn";
  }
}

static float vInUnit(float vMps, WindUnit u) {
  switch (u) {
    case UNIT_MPS: return vMps;
    case UNIT_KMH: return vMps * 3.6f;
    case UNIT_KN:
    default:       return vMps * 1.943844f;
  }
}

static void IRAM_ATTR hallIsr() {
  hallEdgeCount++;
}

// ---------- NVS ----------

static void prefsLoad() {
  prefs.begin("anemo", true);
  windK = prefs.getFloat("k", 0.0f);
  windB = prefs.getFloat("b", 0.0f);
  String u = prefs.getString("unit", "kn");
  if      (u == "mps") windUnit = UNIT_MPS;
  else if (u == "kmh") windUnit = UNIT_KMH;
  else                 windUnit = UNIT_KN;
  prefs.end();
  Serial.printf("[nvs] loaded k=%.4f b=%.3f unit=%s\n", windK, windB, unitToStr(windUnit));
}

static void prefsSave() {
  prefs.begin("anemo", false);
  prefs.putFloat("k", windK);
  prefs.putFloat("b", windB);
  prefs.putString("unit", unitToStr(windUnit));
  prefs.end();
  Serial.printf("[nvs] saved k=%.4f b=%.3f unit=%s\n", windK, windB, unitToStr(windUnit));
}

// ---------- Display ----------

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

  char big[20];
  if (windK <= 0.0f) {
    snprintf(big, sizeof(big), "uncal");
  } else {
    float hz = (float)windHz10 / 10.0f;
    float vMps = windK * hz + windB;
    if (vMps < 0) vMps = 0;
    float v = vInUnit(vMps, windUnit);
    snprintf(big, sizeof(big), "%.1f %s", v, unitLabel(windUnit));
  }
  display.setFont(u8g2_font_logisoso16_tr);
  int w = display.getStrWidth(big);
  display.drawStr(max(0, (128 - w) / 2), Y_BLUE_MID, big);

  char small[24];
  snprintf(small, sizeof(small), "%lu.%lu Hz  %lu RPM",
           (unsigned long)(windHz10 / 10), (unsigned long)(windHz10 % 10),
           (unsigned long)windRpm);
  drawCenteredAt(Y_BLUE_BOT, u8g2_font_6x10_tr, small);

  display.sendBuffer();
}

// ---------- BLE ----------

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

static String configJson() {
  char buf[80];
  snprintf(buf, sizeof(buf), "{\"k\":%.4f,\"b\":%.3f,\"unit\":\"%s\"}",
           windK, windB, unitToStr(windUnit));
  return String(buf);
}

static void publishConfig() {
  if (!configChar) return;
  String s = configJson();
  configChar->setValue((uint8_t *)s.c_str(), s.length());
  if (bleConnected) configChar->notify();
}

// Hand-rolled JSON parser for our tiny known shape:
//   {"k":0.512,"b":0.0,"unit":"kn"}
// Any subset of keys is accepted; missing keys leave current values intact.
static bool parseAndApplyConfig(const std::string &raw) {
  String s(raw.c_str());
  bool changed = false;

  int kp = s.indexOf("\"k\"");
  if (kp >= 0) {
    int c = s.indexOf(':', kp);
    if (c > 0) {
      float v = s.substring(c + 1).toFloat();
      if (!isnan(v) && v != windK) { windK = v; changed = true; }
    }
  }
  int bp = s.indexOf("\"b\"");
  if (bp >= 0) {
    int c = s.indexOf(':', bp);
    if (c > 0) {
      float v = s.substring(c + 1).toFloat();
      if (!isnan(v) && v != windB) { windB = v; changed = true; }
    }
  }
  int up = s.indexOf("\"unit\"");
  if (up >= 0) {
    int c = s.indexOf(':', up);
    int q1 = c >= 0 ? s.indexOf('"', c + 1) : -1;
    int q2 = q1 >= 0 ? s.indexOf('"', q1 + 1) : -1;
    if (q1 >= 0 && q2 > q1) {
      String u = s.substring(q1 + 1, q2);
      WindUnit nu = windUnit;
      if      (u == "kn")  nu = UNIT_KN;
      else if (u == "mps") nu = UNIT_MPS;
      else if (u == "kmh") nu = UNIT_KMH;
      if (nu != windUnit) { windUnit = nu; changed = true; }
    }
  }
  return changed;
}

class ConfigCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c) override {
    std::string val = c->getValue();
    Serial.printf("[ble] config write: %s\n", val.c_str());
    if (parseAndApplyConfig(val)) {
      prefsSave();
      publishConfig();
    }
  }
};

static void bleInit() {
  NimBLEDevice::init(BLE_DEVICE_NAME);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);

  NimBLEServer *srv = NimBLEDevice::createServer();
  srv->setCallbacks(new ServerCallbacks());

  NimBLEService *svc = srv->createService(BLE_SERVICE_UUID);

  telemetryChar = svc->createCharacteristic(
    BLE_TELEMETRY_CHAR_UUID,
    NIMBLE_PROPERTY::NOTIFY | NIMBLE_PROPERTY::READ);

  configChar = svc->createCharacteristic(
    BLE_CONFIG_CHAR_UUID,
    NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
  configChar->setCallbacks(new ConfigCallbacks());
  // initial value so a fresh client gets the current config on its first read
  String initial = configJson();
  configChar->setValue((uint8_t *)initial.c_str(), initial.length());

  svc->start();

  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(BLE_SERVICE_UUID);
  adv->setScanResponse(true);
  NimBLEDevice::startAdvertising();
  Serial.println("[ble] advertising as " + String(BLE_DEVICE_NAME));
}

static void bleNotifyTelemetry(uint32_t windowPulses, uint32_t nowMs) {
  if (!telemetryChar || !bleConnected) return;
  float hz = (float)windHz10 / 10.0f;
  float vMps = windK > 0.0f ? (windK * hz + windB) : 0.0f;
  if (vMps < 0) vMps = 0;
  char json[120];
  int n = snprintf(json, sizeof(json),
    "{\"hz\":%lu.%lu,\"rpm\":%lu,\"pulses\":%lu,\"total\":%lu,\"ms\":%lu,\"v_mps\":%.3f}",
    (unsigned long)(windHz10 / 10), (unsigned long)(windHz10 % 10),
    (unsigned long)windRpm, (unsigned long)windowPulses,
    (unsigned long)totalPulses, (unsigned long)nowMs, vMps);
  if (n <= 0) return;
  telemetryChar->setValue((uint8_t *)json, n);
  telemetryChar->notify();
}

// ---------- Arduino ----------

void setup() {
  Serial.begin(115200);
  delay(100);

  pinMode(HALL_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(HALL_PIN), hallIsr, FALLING);

  prefsLoad();

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
