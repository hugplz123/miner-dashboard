const { chromium } = require("playwright");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname);
const DATA = path.join(ROOT, "dashboard", "data");
const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://127.0.0.1:8765/";
const DATA_ONLY = process.argv.includes("--data-only");
const EXPECTED_SITES = [
  "Blossom01", "May01", "Nimrod01", "Nimrod02", "WhiteOak01",
];
const DETAIL_LEVELS = [
  "template_rows", "model_rows", "work_mode_rows", "machine_rows",
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function close(actual, expected, tolerance = 1e-7) {
  if (actual == null && expected == null) return true;
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  return Math.abs(actual - expected) <= tolerance * scale;
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (row[key] || 0), 0);
}

function expectedOverallRatio(rows) {
  const hashrate = sum(rows, "power_ratio_valid_hashrate_sum_ths");
  return hashrate > 0
    ? sum(rows, "power_ratio_valid_power_sum_w") / hashrate
    : null;
}

function verifyPublishedData() {
  const catalog = readJson(path.join(DATA, "catalog.json"));
  assert.equal(catalog.schema_version, "3.0");
  assert.equal(catalog.date_range.days, 7);
  assert.equal(catalog.available_dates.length, 7);
  assert.deepEqual(catalog.available_dates, [...catalog.available_dates].sort());
  assert.deepEqual(
    catalog.sites.map(site => site.data_center_name).sort(),
    EXPECTED_SITES,
  );
  assert.deepEqual(catalog.detail_dates, [catalog.latest_date]);

  const rowsByDate = new Map();
  let allRows = 0;
  for (const date of catalog.available_dates) {
    const file = path.join(DATA, "days", `${date.replaceAll("-", "")}.json`);
    assert(fs.existsSync(file), `missing day file: ${file}`);
    const day = readJson(file);
    assert.equal(day.schema_version, "3.0");
    assert.equal(day.date, date);
    assert(Array.isArray(day.warehouse_rows) && day.warehouse_rows.length);
    const keys = new Set();
    for (const row of day.warehouse_rows) {
      const key = `${row.data_center_id}/${row.hour}/${row.warehouse_id}`;
      assert(!keys.has(key), `duplicate warehouse hour: ${key}`);
      keys.add(key);
      assert(sum(row.models || [], "machine_count") === row.machine_count);
      assert(sum(row.templates || [], "machine_count") === row.machine_count);
      assert(sum(row.work_modes || [], "machine_count") === row.machine_count);
      assert(row.temperature_max_c == null || row.temperature_max_c > 0);
      assert(row.temperature_min_c == null || row.temperature_min_c > -30);
    }
    rowsByDate.set(date, day.warehouse_rows);
    allRows += day.warehouse_rows.length;
  }

  assert.equal(
    catalog.daily_summary.length,
    catalog.sites.length * catalog.available_dates.length,
  );
  for (const daily of catalog.daily_summary) {
    const rows = rowsByDate.get(daily.date).filter(row =>
      row.data_center_id === daily.data_center_id
    );
    assert.equal(rows.length, daily.warehouse_rows);
    assert.equal(sum(rows, "machine_count"), daily.machine_count);
    assert(close(sum(rows, "actual_power_kw"), daily.actual_power_kw));
    assert(close(
      sum(rows, "theoretical_power_kw"),
      daily.theoretical_power_kw,
    ));
    assert(close(expectedOverallRatio(rows), daily.power_ratio_overall_w_per_th));
  }

  const latestRows = rowsByDate.get(catalog.latest_date);
  const grouped = new Map();
  for (const row of latestRows) {
    const key = `${row.data_center_id}/${row.warehouse_id}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  let machineHours = 0;
  for (const [key, rows] of grouped) {
    const [centerId, warehouseId] = key.split("/");
    const bundleFile = path.join(
      DATA, "details", centerId,
      catalog.latest_date.replaceAll("-", ""),
      `${warehouseId}.json.gz`,
    );
    assert(fs.existsSync(bundleFile), `missing detail: ${bundleFile}`);
    const bundle = JSON.parse(zlib.gunzipSync(fs.readFileSync(bundleFile)));
    assert.equal(bundle.schema_version, "3.0");
    assert.equal(bundle.data_center_id, centerId);
    assert.equal(bundle.warehouse_id, warehouseId);
    assert.equal(Object.keys(bundle.hours).length, 24);

    for (const row of rows) {
      const detail = bundle.hours[String(row.hour)];
      assert(detail, `missing hour detail: ${key}/${row.hour}`);
      const machines = detail.machine_rows;
      assert.equal(machines.length, row.machine_count);
      assert.equal(new Set(machines.map(machine => machine.ip)).size,
        row.machine_count);
      for (const level of DETAIL_LEVELS.slice(0, 3)) {
        assert.equal(sum(detail[level], "machine_count"), row.machine_count);
      }
      for (const machine of machines) {
        assert(!("mac" in machine));
        assert(!("source_id" in machine));
        assert(!("worker_location" in machine));
      }
      assert(close(sum(machines, "avg_power_w") / 1000,
        row.actual_power_kw));
      assert.equal(
        machines.filter(machine =>
          machine.avg_hashrate_ths > 0 && machine.avg_power_w > 0
        ).length,
        row.power_ratio_sample_count,
      );
      assert(close(expectedOverallRatio([row]),
        row.power_ratio_overall_w_per_th));
      machineHours += machines.length;
    }
  }

  return { catalog, catalogRows: allRows, machineHours };
}

async function verifyBrowser(catalog) {
  fs.mkdirSync(path.join(ROOT, "outputs", "dashboard-check"), {
    recursive: true,
  });
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    const requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    page.on("request", request => requests.push(request.url()));

    await page.goto(DASHBOARD_URL, { waitUntil: "networkidle" });
    await page.waitForSelector(".warehouse-card");

    const whiteoak = catalog.sites.find(site =>
      site.data_center_name === "WhiteOak01"
    );
    assert.equal(await page.locator("#site").inputValue(),
      whiteoak.data_center_id);
    assert.equal(await page.locator("#brand-name").textContent(),
      "WhiteOak01");
    assert.equal(await page.locator("#date option").count(), 7);
    assert.equal(await page.locator(".warehouse-card").count(),
      whiteoak.warehouse_count);
    assert.equal(await page.locator("#trend .chart-hit").count(), 7);
    assert.equal(await page.locator("#trend .chart-selection").count(), 1);
    assert(!requests.some(url => /\/data\/[0-9a-f]{32}_\d{10}_/.test(url)));

    await page.locator("[data-trend-mode='hourly']").click();
    assert.equal(await page.locator("#trend .chart-hit").count(), 24);
    assert((await page.locator("#trend-summary").textContent()).includes("当前小时"));
    await page.locator("[data-trend-mode='daily']").click();

    const firstDate = whiteoak.available_dates[0];
    await page.selectOption("#date", firstDate);
    await page.waitForFunction(date =>
      document.querySelector("#meta")?.textContent.includes(`当前 ${date}`),
      firstDate);
    assert.equal(await page.locator(".warehouse-card button:not([disabled])")
      .count(), 0);
    assert((await page.locator("#detail-note").textContent()).includes("历史日期"));

    const latestDate = whiteoak.available_dates.at(-1);
    await page.selectOption("#date", latestDate);
    await page.waitForFunction(date =>
      document.querySelector("#meta")?.textContent.includes(`当前 ${date}`),
      latestDate);
    const detailRequestsBefore = requests.length;
    await page.locator(".warehouse-card .card-head button").first().click();
    await page.waitForSelector("#detail-content tbody tr");
    const detailRequest = requests.slice(detailRequestsBefore)
      .find(url => url.includes("/data/details/"));
    assert(detailRequest, "detail request not found");
    assert(detailRequest.endsWith(".json.gz"));
    assert((await page.locator("#detail-meta").textContent()).includes("WhiteOak01"));
    for (const tab of ["model_rows", "work_mode_rows", "machine_rows"]) {
      await page.locator(`[data-level="${tab}"]`).click();
      assert(await page.locator("#detail-content tbody tr").count() > 0);
    }
    await page.locator("#close").click();
    await page.screenshot({
      path: path.join(ROOT, "outputs", "dashboard-check", "desktop.png"),
      fullPage: true,
    });

    const nimrod = catalog.sites.find(site =>
      site.data_center_name === "Nimrod01"
    );
    await page.selectOption("#site", nimrod.data_center_id);
    await page.waitForFunction(name =>
      document.querySelector("#brand-name")?.textContent === name, "Nimrod01");
    assert.equal(await page.locator(".warehouse-card").count(),
      nimrod.warehouse_count);
    assert((await page.locator("#trend-title").textContent()).includes("Nimrod01"));

    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth
    ));
    assert(await page.evaluate(() =>
      [...document.querySelectorAll(".warehouse-card")].every(card => {
        const box = card.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth + 1;
      })
    ));
    await page.screenshot({
      path: path.join(ROOT, "outputs", "dashboard-check", "mobile.png"),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

(async () => {
  const { catalog, catalogRows, machineHours } = verifyPublishedData();
  if (!DATA_ONLY) {
    await verifyBrowser(catalog);
  }
  console.log(
    `PASS: ${catalog.sites.length} sites, ${catalog.available_dates.length} days, ` +
    `${catalogRows} warehouse hours, ${machineHours} latest-day machine hours; ` +
    (DATA_ONLY
      ? "data and lazy gzip details"
      : "data, lazy gzip details, charts, site/date switching and mobile layout"),
  );
})().catch(error => {
  console.error(error);
  process.exit(1);
});
