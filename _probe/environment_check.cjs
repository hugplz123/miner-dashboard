const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright");

const URL = process.env.DASHBOARD_URL || "http://127.0.0.1:8765/";
const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "outputs", "dashboard-check");

async function selectOptionByText(page, selector, text) {
  const value = await page.locator(`${selector} option`).evaluateAll(
    (options, expected) => options.find(option =>
      option.textContent.includes(expected)
    )?.value,
    text,
  );
  assert(value, `missing option containing ${text}`);
  await page.selectOption(selector, value);
}

async function selectLatestDate(page) {
  const value = await page.locator("#date option").evaluateAll(
    options => options.at(-1)?.value,
  );
  assert(value, "missing date options");
  await page.selectOption("#date", value);
  await page.waitForFunction(
    date => document.querySelector("#meta")?.textContent.includes(date),
    value,
  );
}

async function setHour(page, hour) {
  const value = await page.locator("#hour option").evaluateAll(
    (options, expected) => options.find(option =>
      option.value.endsWith(String(expected).padStart(2, "0"))
    )?.value,
    hour,
  );
  assert(value, `missing hour option ending in ${hour}`);
  await page.selectOption("#hour", value);
  await page.waitForTimeout(300);
}

async function assertNoHorizontalOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert(
    dimensions.scrollWidth <= dimensions.clientWidth + 1,
    `${label} has horizontal overflow: ${JSON.stringify(dimensions)}`,
  );
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: "msedge",
    args: ["--disable-ipv6"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      timezoneId: "Asia/Shanghai",
    });
    const errors = [];
    const failedResponses = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("response", response => {
      if (response.status() >= 400) {
        failedResponses.push(`${response.status()} ${response.url()}`);
      }
    });

    await page.goto(URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".warehouse-card");
    await selectOptionByText(page, "#site", "WhiteOak01");
    await selectLatestDate(page);
    await setHour(page, 12);

    assert.equal(
      await page.locator(".warehouse-card .environment-readings").count(),
      40,
    );
    assert(
      (await page.locator(".warehouse-card .environment-readings").first()
        .textContent()).includes("°C"),
    );

    await page.locator('[data-trend-metric="environment"]').click();
    assert.equal(
      await page.locator('[data-trend-mode="hourly"]').getAttribute("aria-pressed"),
      "true",
      "温湿度模式应自动切到当日逐小时",
    );
    assert(await page.locator("#environment-view-switch").isVisible());
    assert.equal(
      await page.locator('[data-environment-view="environment"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      await page.locator('[data-environment-measure="temperature"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      await page.locator('[data-environment-measure="humidity"]')
        .getAttribute("aria-pressed"),
      "false",
    );
    assert.equal(
      (await page.locator('[data-environment-view="machine-temperature"]')
        .textContent()).trim(),
      "矿机温度",
    );
    assert.equal(
      (await page.locator('[data-environment-view="environment"]')
        .textContent()).trim(),
      "环境温湿度",
    );
    assert(await page.locator("#chart-wrap").isVisible());
    assert(!await page.locator("#environment-humidity-wrap").isVisible());
    await page.waitForFunction(() =>
      document.querySelectorAll("#trend .chart-line").length >= 2
    );
    assert.equal(await page.locator("#trend .chart-hit").count(), 24);
    assert.equal(
      await page.locator(
        "#trend .chart-line.machine-temperature, "
          + "#trend .chart-line.site-environment-humidity, "
          + "#trend .chart-line.container-environment-humidity",
      ).count(),
      0,
      "环境温度图不能包含矿机温度或湿度线",
    );
    const environmentMissingHours = await page.evaluate(() =>
      hourlySeries().filter(item => !item.environmentAvailable).length
    );
    assert(environmentMissingHours > 0);
    const firstTwelveMissing = await page.evaluate(() =>
      hourlySeries().slice(0, 12).every(item => !item.environmentAvailable)
    );
    assert(
      firstTwelveMissing,
      "WhiteOak01 最新日的 0–11 点应保持缺失，不能补 0",
    );
    await page.locator("#trend .chart-hit").nth(14).hover();
    const temperatureTooltip = await page.locator("#chart-tooltip").textContent();
    assert(temperatureTooltip.includes("场地环境温度"));
    assert(temperatureTooltip.includes("矿箱环境温度"));
    assert(!temperatureTooltip.includes("矿机温度"));
    assert(!temperatureTooltip.includes("湿度"));
    assert(
      await page.locator(
        '#trend .chart-line.site-environment, '
          + '#trend .chart-series-point.site-environment',
      ).count() >= 2,
      "site environment should break at missing hours",
    );
    assert(
      await page.locator(
        '#trend .chart-line.container-environment, '
          + '#trend .chart-series-point.container-environment',
      ).count() >= 2,
      "container environment should break at missing hours",
    );
    const trendText = await page.locator("#trend-summary").textContent();
    assert(trendText.includes("场地环境"));
    assert(trendText.includes("矿箱环境"));
    assert(!trendText.includes("矿机温度"));
    assert(!trendText.includes("湿度"));
    await assertNoHorizontalOverflow(page, "desktop");
    await page.locator(".trend").screenshot({
      path: path.join(OUTPUT, "environment-temperature-desktop.png"),
    });

    await page.locator('[data-environment-view="machine-temperature"]').click();
    assert.equal(
      await page.locator('[data-environment-view="machine-temperature"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    assert(!await page.locator("#environment-measure-switch").isVisible());
    assert(await page.locator("#chart-wrap").isVisible());
    assert(!await page.locator("#environment-humidity-wrap").isVisible());
    await page.waitForFunction(() =>
      document.querySelectorAll("#trend .chart-line.machine-temperature").length
        >= 1
    );
    assert.equal(await page.locator("#trend .chart-hit").count(), 24);
    assert.equal(
      await page.locator(
        "#trend .chart-line.site-environment, "
          + "#trend .chart-line.container-environment, "
          + "#trend .chart-line.site-environment-humidity, "
          + "#trend .chart-line.container-environment-humidity",
      ).count(),
      0,
      "矿机温度图不能包含环境温度或湿度线",
    );
    await page.locator("#trend .chart-hit").nth(14).hover();
    const machineTooltip = await page.locator("#chart-tooltip").textContent();
    assert(machineTooltip.includes("矿机温度"));
    assert(!machineTooltip.includes("环境"));
    assert(!machineTooltip.includes("湿度"));
    const machineTrendText = await page.locator("#trend-summary").textContent();
    assert(machineTrendText.includes("矿机温度"));
    assert(!machineTrendText.includes("环境"));
    assert(!machineTrendText.includes("湿度"));
    await assertNoHorizontalOverflow(page, "desktop machine temperature");
    await page.locator(".trend").screenshot({
      path: path.join(OUTPUT, "machine-temperature-desktop.png"),
    });

    await page.locator('[data-environment-view="environment"]').click();
    await page.locator('[data-environment-measure="humidity"]').click();
    assert.equal(
      await page.locator('[data-environment-measure="humidity"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    assert(await page.locator("#environment-measure-switch").isVisible());
    assert(!await page.locator("#chart-wrap").isVisible());
    assert(await page.locator("#environment-humidity-wrap").isVisible());
    await page.waitForFunction(() =>
      document.querySelectorAll(
        "#environment-humidity-trend .chart-line",
      ).length >= 2
    );
    assert.equal(
      await page.locator("#environment-humidity-trend .chart-hit").count(),
      24,
    );
    assert.equal(
      await page.locator(
        "#environment-humidity-trend .chart-line.site-environment, "
          + "#environment-humidity-trend .chart-line.container-environment, "
          + "#environment-humidity-trend .chart-line.machine-temperature",
      ).count(),
      0,
      "湿度图不能包含温度线",
    );
    assert(
      await page.locator(
        "#environment-humidity-trend .chart-line.site-environment-humidity, "
          + "#environment-humidity-trend .chart-series-point.site-environment-humidity",
      ).count() >= 2,
      "场地湿度曲线应在缺失小时断开",
    );
    assert(
      await page.locator(
        "#environment-humidity-trend .chart-line.container-environment-humidity, "
          + "#environment-humidity-trend .chart-series-point.container-environment-humidity",
      ).count() >= 2,
      "矿箱湿度曲线应在缺失小时断开",
    );
    assert.equal(
      await page.locator("#environment-humidity-trend .chart-missing-band").count(),
      environmentMissingHours,
    );
    await page.locator("#environment-humidity-trend .chart-hit").nth(14).hover();
    const humidityTooltip = await page.locator(
      "#environment-humidity-tooltip",
    ).textContent();
    assert(humidityTooltip.includes("场地环境湿度"));
    assert(humidityTooltip.includes("矿箱环境湿度"));
    assert(!humidityTooltip.includes("温度"));
    const humidityTrendText = await page.locator("#trend-summary").textContent();
    assert(humidityTrendText.includes("场地环境湿度"));
    assert(humidityTrendText.includes("矿箱环境湿度"));
    assert(!humidityTrendText.includes("温度"));
    await assertNoHorizontalOverflow(page, "desktop humidity");
    await page.locator(".trend").screenshot({
      path: path.join(OUTPUT, "environment-humidity-desktop.png"),
    });

    await selectOptionByText(page, "#site", "Nimrod01");
    await selectLatestDate(page);
    await setHour(page, 12);
    assert.equal(
      await page.locator(".warehouse-card.environment-only-card").count(),
      2,
    );
    const environmentOnly = page.locator(
      ".warehouse-card.environment-only-card",
    ).first();
    assert((await environmentOnly.textContent()).includes(
      "本小时只有温湿度数据，不推断停电或 0 kW",
    ));
    assert.equal(await environmentOnly.locator("[data-detail-id]").count(), 0);
    await environmentOnly.screenshot({
      path: path.join(OUTPUT, "environment-only-card.png"),
    });

    const mobile = await browser.newPage({
      viewport: { width: 390, height: 844 },
      timezoneId: "Asia/Shanghai",
    });
    mobile.on("pageerror", error => errors.push(error.message));
    mobile.on("console", message => {
      if (message.type() === "error") errors.push(message.text());
    });
    mobile.on("response", response => {
      if (response.status() >= 400) {
        failedResponses.push(`${response.status()} ${response.url()}`);
      }
    });
    await mobile.goto(URL, { waitUntil: "domcontentloaded" });
    await mobile.waitForSelector(".warehouse-card");
    await selectOptionByText(mobile, "#site", "WhiteOak01");
    await selectLatestDate(mobile);
    await mobile.locator('[data-trend-metric="environment"]').click();
    assert(await mobile.locator("#chart-wrap").isVisible());
    assert(!await mobile.locator("#environment-humidity-wrap").isVisible());
    await mobile.waitForFunction(() =>
      document.querySelectorAll("#trend .chart-line").length >= 2
    );
    assert.equal(
      await mobile.locator(
        "#trend .chart-line.machine-temperature",
      ).count(),
      0,
    );
    await assertNoHorizontalOverflow(mobile, "mobile environment temperature");
    await mobile.locator(".trend").screenshot({
      path: path.join(OUTPUT, "environment-temperature-mobile.png"),
    });
    await mobile.locator('[data-environment-view="machine-temperature"]').click();
    await mobile.waitForFunction(() =>
      document.querySelectorAll("#trend .chart-line.machine-temperature").length
        >= 1
    );
    assert.equal(await mobile.locator("#trend .chart-hit").count(), 24);
    await assertNoHorizontalOverflow(mobile, "mobile machine temperature");
    await mobile.locator(".trend").screenshot({
      path: path.join(OUTPUT, "machine-temperature-mobile.png"),
    });
    await mobile.locator('[data-environment-view="environment"]').click();
    await mobile.locator('[data-environment-measure="humidity"]').click();
    assert(!await mobile.locator("#chart-wrap").isVisible());
    assert(await mobile.locator("#environment-humidity-wrap").isVisible());
    await mobile.waitForFunction(() =>
      document.querySelectorAll(
        "#environment-humidity-trend .chart-line",
      ).length >= 2
    );
    await assertNoHorizontalOverflow(mobile, "mobile humidity");
    await mobile.locator(".trend").screenshot({
      path: path.join(OUTPUT, "environment-humidity-mobile.png"),
    });

    assert.deepEqual(failedResponses, []);
    assert.deepEqual(errors, []);
    console.log("PASS: machine temperature and environment temperature/humidity charts");
  }
  finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
