#include <Arduino.h>
#include <U8g2lib.h>
#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>

constexpr int OLED_SDA = 21;
constexpr int OLED_SCL = 22;
constexpr int BTN_BOOT = 0;     // BOOT button on GPIO0, active LOW

U8G2_SSD1306_128X64_NONAME_F_HW_I2C display(U8G2_R0, U8X8_PIN_NONE);

constexpr const char *WIFI_SSID = "ARRIS-44F2";
constexpr const char *WIFI_PASS = "8876A08017ACAD93";
constexpr const char *IP_URL    = "http://api.ipify.org";

constexpr uint32_t SCAN_PAGE_MS    = 3000;
constexpr uint32_t LONG_PRESS_MS   = 800;
constexpr uint32_t DEBOUNCE_MS     = 30;
constexpr int      SCAN_ROWS_PAGE  = 4;

// Layout zones for two-color 0.96" SSD1306:
//   yellow band: y =  0..15  (use baseline ~ y=11 for 6x10 font)
//   gap        : y = 16..17  (avoid)
//   blue band  : y = 18..63
constexpr int Y_YELLOW   = 11;
constexpr int Y_BLUE_MID = 46;
constexpr int Y_BLUE_BOT = 61;

enum Screen { SCREEN_IP, SCREEN_SCAN };
Screen currentScreen = SCREEN_IP;

String currentIp;

int     scanCount = 0;
int     scanPage  = 0;
uint32_t lastScanFlip = 0;
bool    scanHasData = false;

// button state
bool     btnPrev = HIGH;
uint32_t btnDownAt = 0;
bool     longFired = false;

static void drawZoneFrames() {
  display.drawFrame(0, 0, 128, 16);
  display.drawFrame(0, 18, 128, 46);
}

static void beginFrame() {
  display.clearBuffer();
  drawZoneFrames();
}

static void drawHeaderYellow(const char *text) {
  display.setFont(u8g2_font_6x10_tr);
  int w = display.getStrWidth(text);
  display.drawStr((128 - w) / 2, Y_YELLOW, text);
}

static void drawCenteredAt(int y, const uint8_t *font, const char *text) {
  display.setFont(font);
  int w = display.getStrWidth(text);
  display.drawStr((128 - w) / 2, y, text);
}

static void drawTwoLine(const char *header, const char *body) {
  beginFrame();
  drawHeaderYellow(header);
  if (body) drawCenteredAt(Y_BLUE_MID, u8g2_font_6x10_tr, body);
  display.sendBuffer();
}

// ---------- WiFi / IP ----------

static bool connectWifi(uint32_t timeout_ms) {
  Serial.printf("Connecting to %s ...\n", WIFI_SSID);
  drawTwoLine("Connecting...", WIFI_SSID);

  WiFi.persistent(false);
  WiFi.mode(WIFI_OFF);
  delay(50);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true, true);
  delay(100);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeout_ms) {
    delay(250);
    Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("WiFi failed, status=%d\n", (int)WiFi.status());
    return false;
  }
  Serial.printf("Connected, local IP: %s, RSSI %d\n",
                WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
  return true;
}

static String fetchPublicIp() {
  HTTPClient http;
  http.setTimeout(8000);
  http.setUserAgent("esp32-hello/1.0");
  if (!http.begin(IP_URL)) {
    Serial.println("http.begin failed");
    return String();
  }

  int code = http.GET();
  Serial.printf("HTTP GET %s -> %d\n", IP_URL, code);
  String body;
  if (code == HTTP_CODE_OK) {
    body = http.getString();
    body.trim();
  }
  http.end();
  return body;
}

// ---------- screens ----------

static void renderIp() {
  beginFrame();
  drawHeaderYellow("Public IP");

  if (currentIp.length() == 0) {
    drawCenteredAt(Y_BLUE_MID, u8g2_font_6x10_tr, "fetch failed");
    display.sendBuffer();
    return;
  }

  display.setFont(u8g2_font_logisoso16_tr);
  int w = display.getStrWidth(currentIp.c_str());
  if (w > 128) {
    display.setFont(u8g2_font_7x13B_tr);
    w = display.getStrWidth(currentIp.c_str());
  }
  display.drawStr(max(0, (128 - w) / 2), Y_BLUE_MID, currentIp.c_str());

  String ssid = WiFi.SSID();
  String foot = ssid + " " + String((int)WiFi.RSSI()) + "dBm";
  display.setFont(u8g2_font_6x10_tr);
  while (display.getStrWidth(foot.c_str()) > 124 && ssid.length() > 1) {
    ssid.remove(ssid.length() - 1);
    foot = ssid + ". " + String((int)WiFi.RSSI()) + "dBm";
  }
  drawCenteredAt(Y_BLUE_BOT, u8g2_font_6x10_tr, foot.c_str());
  display.sendBuffer();
}

static String truncate(const String &s, int maxChars) {
  if ((int)s.length() <= maxChars) return s;
  return s.substring(0, maxChars - 1) + ".";
}

static void renderScan() {
  beginFrame();

  int totalPages = scanCount > 0
      ? (scanCount + SCAN_ROWS_PAGE - 1) / SCAN_ROWS_PAGE
      : 1;
  String hdr = "WiFi " + String(scanCount) + "  " +
               String(scanPage + 1) + "/" + String(totalPages);
  drawHeaderYellow(hdr.c_str());

  if (!scanHasData) {
    drawCenteredAt(Y_BLUE_MID, u8g2_font_6x10_tr, "Scanning...");
    display.sendBuffer();
    return;
  }
  if (scanCount == 0) {
    drawCenteredAt(Y_BLUE_MID, u8g2_font_6x10_tr, "no networks");
    display.sendBuffer();
    return;
  }

  display.setFont(u8g2_font_6x10_tr);
  int start = scanPage * SCAN_ROWS_PAGE;
  int end = min(start + SCAN_ROWS_PAGE, scanCount);
  for (int i = start; i < end; i++) {
    int y = 28 + (i - start) * 10;
    int rssi = WiFi.RSSI(i);
    bool open = WiFi.encryptionType(i) == WIFI_AUTH_OPEN;
    String line = String(rssi);
    while (line.length() < 4) line = " " + line;
    line += open ? "  " : " *";
    line += truncate(WiFi.SSID(i), 14);
    display.drawStr(3, y, line.c_str());
  }
  display.sendBuffer();
}

static void runScan() {
  scanHasData = false;
  scanPage = 0;
  renderScan();

  WiFi.scanDelete();
  int n = WiFi.scanNetworks(false, true, false, 500);
  scanCount = (n >= 0) ? n : 0;
  scanHasData = true;
  lastScanFlip = millis();
  Serial.printf("scanNetworks -> %d\n", n);
  for (int i = 0; i < scanCount; i++) {
    Serial.printf("  %2d: %4d dBm  ch%2d  %s  %s\n",
                  i, WiFi.RSSI(i), WiFi.channel(i),
                  WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "open" : "enc ",
                  WiFi.SSID(i).c_str());
  }
}

static void refreshIp() {
  drawTwoLine("Fetching IP...", nullptr);
  currentIp = fetchPublicIp();
  Serial.printf("Public IP: '%s'\n", currentIp.c_str());
}

static void renderCurrent() {
  if (currentScreen == SCREEN_IP) renderIp();
  else                            renderScan();
}

// ---------- button ----------

static void onShortPress() {
  currentScreen = (currentScreen == SCREEN_IP) ? SCREEN_SCAN : SCREEN_IP;
  Serial.printf("[btn] short -> screen %d\n", currentScreen);
  if (currentScreen == SCREEN_SCAN && !scanHasData) {
    runScan();
  }
  renderCurrent();
}

static void onLongPress() {
  Serial.printf("[btn] long press, screen %d\n", currentScreen);
  if (currentScreen == SCREEN_IP) {
    if (WiFi.status() != WL_CONNECTED) connectWifi(15000);
    refreshIp();
    renderIp();
  } else {
    runScan();
    renderScan();
  }
}

static void pollButton() {
  static uint32_t lastEdge = 0;
  uint32_t now = millis();
  bool raw = digitalRead(BTN_BOOT);

  if (raw != btnPrev && (now - lastEdge) >= DEBOUNCE_MS) {
    lastEdge = now;
    if (raw == LOW) {           // pressed
      btnDownAt = now;
      longFired = false;
    } else {                    // released
      uint32_t held = now - btnDownAt;
      if (!longFired && held < LONG_PRESS_MS) onShortPress();
    }
    btnPrev = raw;
  }

  // long-press fires while still held
  if (btnPrev == LOW && !longFired &&
      (now - btnDownAt) >= LONG_PRESS_MS) {
    longFired = true;
    onLongPress();
  }
}

// ---------- arduino ----------

void setup() {
  Serial.begin(115200);
  delay(100);
  pinMode(BTN_BOOT, INPUT_PULLUP);
  Wire.begin(OLED_SDA, OLED_SCL);
  display.begin();

  if (!connectWifi(20000)) {
    drawTwoLine("WiFi failed", WIFI_SSID);
    return;
  }

  refreshIp();
  renderIp();
}

void loop() {
  pollButton();

  uint32_t now = millis();

  if (WiFi.status() != WL_CONNECTED) {
    connectWifi(20000);
  }

  if (currentScreen == SCREEN_SCAN && scanHasData && scanCount > SCAN_ROWS_PAGE &&
      now - lastScanFlip >= SCAN_PAGE_MS) {
    int totalPages = (scanCount + SCAN_ROWS_PAGE - 1) / SCAN_ROWS_PAGE;
    scanPage = (scanPage + 1) % totalPages;
    lastScanFlip = now;
    renderScan();
  }

  delay(10);
}
