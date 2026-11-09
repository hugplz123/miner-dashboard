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
const EXPECTED_HOURS_PER_DAY = 24;
const EXPECTED_LARK_COUNTS = {
  Blossom01: 10,
  May01: 12,
  Nimrod01: 18,
  Nimrod02: 16,
  WhiteOak01: 40,
};
const LARK_RECORD_FIELDS = [
  "mounted_machine_count",
  "mounted_power_kw",
  "occupied_slots",
  "offline_machine_count",
  "power_limit_kw",
  "reserved_power_kw",
  "site",
  "total_slots",
  "unit_theoretical_power_kw",
  "vacant_slots",
  "warehouse_number",
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readGzipJson(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
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

function normalizeWarehouseNumber(value) {
  return Number(String(value).trim().replace(/^C/i, ""));
}

function larkKey(site, warehouseNumber) {
  return `${String(site).trim().toLocaleLowerCase()}/${Number(warehouseNumber)}`;
}

function verifyPublishedData() {
  const catalog = readJson(path.join(DATA, "catalog.json"));
  assert.equal(catalog.schema_version, "3.2");
  assert.equal(catalog.date_range.days, 7);
  assert.equal(catalog.available_dates.length, 7);
  assert.deepEqual(catalog.available_dates, [...catalog.available_dates].sort());
  assert.deepEqual(
    catalog.sites.map(site => site.data_center_name).sort(),
    EXPECTED_SITES,
  );
  assert.deepEqual(catalog.detail_dates, [catalog.latest_date]);

  const lark = readJson(path.join(DATA, "lark_power.json"));
  assert.equal(lark.schema_version, "1.0");
  assert.equal(lark.snapshot_date, "2026-11-08");
  assert.equal(lark.source, "lark_bitable");
  assert.equal(lark.base_token, "VuLLbn5bNaIWkoswngWlyEOygof");
  assert.equal(lark.table_id, "tblNq169SbT5aD2N");
  assert.equal(lark.view_id, "vewUWFcYgO");
  assert(Number.isFinite(Date.parse(lark.synced_at)));
  assert.equal(lark.record_count, 96);
  assert.equal(lark.records.length, lark.record_count);
  assert(!/SourceID|ip[_ -]?range|IP范围|app[_ -]?secret/i.test(
    JSON.stringify(lark),
  ));

  const larkCounts = Object.fromEntries(
    Object.keys(EXPECTED_LARK_COUNTS).map(site => [site, 0]),
  );
  const larkRecords = new Map();
  for (const record of lark.records) {
    assert.deepEqual(Object.keys(record).sort(), LARK_RECORD_FIELDS);
    assert(EXPECTED_SITES.includes(record.site));
    assert(Number.isInteger(record.warehouse_number));
    assert(record.warehouse_number > 0);
    const key = larkKey(record.site, record.warehouse_number);
    assert(!larkRecords.has(key), `duplicate Lark warehouse key: ${key}`);
    larkRecords.set(key, record);
    larkCounts[record.site] += 1;
  }
  assert.deepEqual(larkCounts, EXPECTED_LARK_COUNTS);
  assert.deepEqual(catalog.lark_power, {
    latest_snapshot_date: lark.snapshot_date,
    snapshots: [{
      snapshot_date: lark.snapshot_date,
      schema_version: lark.schema_version,
      source: lark.source,
      synced_at: lark.synced_at,
      record_count: lark.record_count,
      matched_warehouses: lark.record_count,
      unmatched_records: [],
    }],
  });
  const historyFile = path.join(
    DATA, "lark_power_history", `${lark.snapshot_date.replaceAll("-", "")}.json`,
  );
  assert(fs.existsSync(historyFile), `missing Lark history: ${historyFile}`);
  assert.deepEqual(readJson(historyFile), lark);

  const larkMissing = { Nimrod01: 0, WhiteOak01: 0 };
  for (const record of lark.records) {
    if (!Number.isFinite(record.mounted_power_kw)) {
      assert(Object.hasOwn(larkMissing, record.site));
      larkMissing[record.site] += 1;
    }
  }
  assert.deepEqual(larkMissing, { Nimrod01: 3, WhiteOak01: 1 });

  assert.equal(catalog.warehouses.length, 98);
  let matchedWarehouses = 0;
  for (const warehouse of catalog.warehouses) {
    const key = larkKey(
      warehouse.data_center_name,
      normalizeWarehouseNumber(warehouse.warehouse_name),
    );
    const expectedLark = larkRecords.get(key);
    if (expectedLark) {
      assert.deepEqual(warehouse.lark_power_by_date, {
        [lark.snapshot_date]: expectedLark,
      });
      matchedWarehouses += 1;
    }
    else {
      assert(!("lark_power_by_date" in warehouse));
    }
  }
  assert.equal(matchedWarehouses, 96);
  assert.equal(larkRecords.size, matchedWarehouses);

  for (const site of catalog.sites) {
    const snapshot = site.lark_power_by_date?.[lark.snapshot_date];
    assert(snapshot, `missing site Lark snapshot: ${site.data_center_name}`);
    assert.equal(snapshot.matched_warehouses,
      EXPECTED_LARK_COUNTS[site.data_center_name]);
    assert.equal(snapshot.total_warehouses, site.warehouse_count);
    for (const date of catalog.available_dates) {
      if (date !== lark.snapshot_date) {
        assert(!site.lark_power_by_date[date],
          `unexpected historical Lark snapshot: ${date}`);
      }
    }
  }
  const nimrod02 = catalog.sites.find(site =>
    site.data_center_name === "Nimrod02"
  );
  assert.equal(
    nimrod02.lark_power_by_date[lark.snapshot_date].matched_warehouses,
    16,
  );
  assert.equal(
    nimrod02.lark_power_by_date[lark.snapshot_date].total_warehouses,
    18,
  );

  const rowsByDate = new Map();
  let allRows = 0;
  for (const date of catalog.available_dates) {
    const file = path.join(DATA, "days", `${date.replaceAll("-", "")}.json.gz`);
    assert(fs.existsSync(file), `missing day file: ${file}`);
    const day = readGzipJson(file);
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
      if (row.temperature_max_c != null) {
        assert(row.temperature_max_c >= -30 && row.temperature_max_c <= 125);
      }
      if (row.temperature_min_c != null) {
        assert(row.temperature_min_c >= -30 && row.temperature_min_c <= 125);
      }
      if (row.temperature_min_c != null && row.temperature_max_c != null) {
        assert(row.temperature_min_c <= row.temperature_max_c);
      }
    }
    rowsByDate.set(date, day.warehouse_rows);
    allRows += day.warehouse_rows.length;
  }

  const nimrod02Warehouses = catalog.warehouses.filter(warehouse =>
    warehouse.data_center_name === "Nimrod02"
  );
  assert.equal(nimrod02Warehouses.length, 18);
  const nimrod02LatestRows = rowsByDate.get(catalog.latest_date).filter(row =>
    row.data_center_id === nimrod02.data_center_id
  );
  const nimrod02LatestIds = new Set(
    nimrod02LatestRows.map(row => row.warehouse_id),
  );
  assert.equal(nimrod02LatestIds.size, 16);
  for (const warehouseName of ["C17", "C18"]) {
    const warehouse = nimrod02Warehouses.find(item =>
      item.warehouse_name === warehouseName
    );
    assert(warehouse);
    assert(!nimrod02LatestIds.has(warehouse.warehouse_id));
  }

  const expectedDailyKeys = new Set();
  for (const [date, rows] of rowsByDate) {
    for (const row of rows) {
      expectedDailyKeys.add(`${date}/${row.data_center_id}`);
    }
  }
  assert.equal(catalog.daily_summary.length, expectedDailyKeys.size);
  const actualDailyKeys = new Set();
  for (const daily of catalog.daily_summary) {
    const dailyKey = `${daily.date}/${daily.data_center_id}`;
    assert(expectedDailyKeys.has(dailyKey), `unexpected daily row: ${dailyKey}`);
    assert(!actualDailyKeys.has(dailyKey), `duplicate daily row: ${dailyKey}`);
    actualDailyKeys.add(dailyKey);
    const rows = rowsByDate.get(daily.date).filter(row =>
      row.data_center_id === daily.data_center_id
    );
    const expectedHours = [...new Set(rows.map(row => row.hour))]
      .sort((a, b) => a - b);
    const warehouseCounts = {};
    for (const row of rows) {
      if (!warehouseCounts[row.warehouse_id]) warehouseCounts[row.warehouse_id] = 0;
      warehouseCounts[row.warehouse_id] += 1;
    }
    assert.equal(rows.length, daily.warehouse_rows);
    assert.deepEqual(daily.hours, expectedHours);
    assert.equal(daily.hours_with_data, expectedHours.length);
    assert.equal(daily.expected_hours, EXPECTED_HOURS_PER_DAY);
    assert.equal(daily.is_complete,
      expectedHours.length === EXPECTED_HOURS_PER_DAY);
    assert.equal(daily.is_fully_complete,
      expectedHours.length === EXPECTED_HOURS_PER_DAY
        && Object.values(warehouseCounts).length === daily.warehouse_count
        && Object.values(warehouseCounts)
          .every(count => count === EXPECTED_HOURS_PER_DAY));
    assert(close(
      daily.hours_coverage_ratio,
      expectedHours.length / EXPECTED_HOURS_PER_DAY,
    ));
    assert.deepEqual(daily.warehouse_hour_counts, warehouseCounts);
    assert.equal(daily.complete_warehouse_count,
      Object.values(warehouseCounts)
        .filter(count => count === EXPECTED_HOURS_PER_DAY).length);
    assert.equal(daily.incomplete_warehouse_count,
      Object.values(warehouseCounts)
        .filter(count => count < EXPECTED_HOURS_PER_DAY).length);
    assert.equal(daily.warehouses_with_data,
      Object.keys(warehouseCounts).length);
    assert.equal(daily.warehouses_without_data,
      daily.warehouse_count - Object.keys(warehouseCounts).length);
    assert.equal(daily.min_warehouse_hours,
      Math.min(...Object.values(warehouseCounts)));
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
    assert.deepEqual(
      Object.keys(bundle.hours).sort(),
      [...new Set(rows.map(row => String(row.hour)))].sort(),
    );

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

  return { catalog, lark, catalogRows: allRows, machineHours };
}

async function verifyBrowser(catalog) {
  fs.mkdirSync(path.join(ROOT, "outputs", "dashboard-check"), {
    recursive: true,
  });
  const browserArgs = ["--disable-ipv6"];
  if (process.env.DASHBOARD_HOST_IP) {
    const host = new URL(DASHBOARD_URL).hostname;
    browserArgs.push(
      `--host-resolver-rules=MAP ${host} ${process.env.DASHBOARD_HOST_IP}`,
    );
  }
  const browser = await chromium.launch({
    headless: true,
    channel: "msedge",
    // Some networks advertise IPv6 for GitHub Pages without a working route.
    args: browserArgs,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    const requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    page.on("request", request => requests.push(request.url()));

    await page.goto(DASHBOARD_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForSelector(".warehouse-card", { timeout: 60000 });

    const whiteoak = catalog.sites.find(site =>
      site.data_center_name === "WhiteOak01"
    );
    const latestDayRows = readGzipJson(path.join(
      DATA, "days", `${catalog.latest_date.replaceAll("-", "")}.json.gz`,
    )).warehouse_rows;
    const whiteoakActiveIds = new Set(
      latestDayRows
        .filter(row => row.data_center_id === whiteoak.data_center_id)
        .map(row => row.warehouse_id),
    );
    const larkSnapshotDate = catalog.lark_power.latest_snapshot_date;
    assert.equal(larkSnapshotDate, catalog.latest_date);
    assert.equal(await page.locator("#site").inputValue(),
      whiteoak.data_center_id);
    assert.equal(await page.locator("#brand-name").textContent(),
      "WhiteOak01");
    assert.equal(await page.locator("#date option").count(), 7);
    assert.equal(await page.locator(".warehouse-card").count(),
      whiteoakActiveIds.size);
    assert.equal(await page.locator("#metrics .overview-stat").count(), 3);
    assert.equal(await page.locator("#metrics .overview-support-item").count(), 2);
    assert.equal(await page.locator(".load-filters button").count(), 3);
    assert.deepEqual(await page.locator("#sort option").allTextContents(), [
      "实际功率（由高到低）",
      "矿箱实际余量（由高到低）",
      "矿箱号（由高到低）",
    ]);
    assert.equal(await page.locator("#sort").inputValue(), "power");
    assert.equal(await page.locator("#metrics .overview-margin").count(), 3);
    assert.equal(await page.locator(
      ".warehouse-card .card-title .status",
    ).evaluateAll(nodes => nodes.filter(node =>
      node.textContent.includes("%")
    ).length), 0);
    assert((await page.locator(
      ".warehouse-card .power-comparison-labels",
    ).first().textContent()).includes("已用"));
    assert.equal(await page.locator(
      "#metrics [data-metric='actual'], #metrics [data-metric='mounted'], " +
      "#metrics [data-metric='reserved']"
    ).count(), 3);
    const overviewText = await page.locator("#metrics").textContent();
    assert(overviewText.includes("上报矿箱"));
    assert(overviewText.includes("矿机"));
    assert(!overviewText.includes("超理论小时"));
    assert(!overviewText.includes("接近理论"));
    assert(!(await page.locator("body").textContent()).includes("接近理论"));
    assert.equal(await page.locator(".lark-power-panel.unmatched").count(), 0);
    const boxesWithData = await page.locator(
      ".warehouse-card:not(.missing-card)",
    ).count();
    assert.equal(await page.locator(".warehouse-card .lark-power-panel")
      .count(), boxesWithData);
    assert.equal(await page.locator(".warehouse-card .capacity-row").count(),
      boxesWithData * 2);
    assert.equal(await page.locator(
      ".warehouse-card .card-distributions .distribution-block",
    ).count(), boxesWithData * 2);
    assert.equal(await page.locator(
      ".warehouse-card .distribution-track",
    ).count(), boxesWithData * 2);
    const selectedHour = Number(await page.locator("#hour").inputValue());
    const selectedRows = new Map(
      latestDayRows
        .filter(row =>
          row.data_center_id === whiteoak.data_center_id
          && row.hour === selectedHour
        )
        .map(row => [row.warehouse_id, row]),
    );
    const cardIds = () => page.locator(
      ".warehouse-card:not(.missing-card)",
    ).evaluateAll(cards => cards.map(card => card.dataset.warehouseId));
    const sortedRows = (key) => [...selectedRows.values()]
      .filter(row => !row.missing)
      .sort((a, b) =>
        ((b[key] ?? -Infinity) - (a[key] ?? -Infinity))
        || a.warehouse_name.localeCompare(b.warehouse_name, undefined, {
          numeric: true,
        })
      )
      .map(row => row.warehouse_id);
    assert.deepEqual(await cardIds(), sortedRows("actual_power_kw"));
    await page.locator("#sort").selectOption("available");
    assert.deepEqual(await cardIds(), sortedRows("available_capacity_kw"));
    await page.locator("#sort").selectOption("name");
    assert.deepEqual(await cardIds(), [...selectedRows.values()]
      .filter(row => !row.missing)
      .sort((a, b) =>
        b.warehouse_name.localeCompare(a.warehouse_name, undefined, {
          numeric: true,
        })
      )
      .map(row => row.warehouse_id));
    await page.locator("#sort").selectOption("power");
    const cardDistributionTotals = await page.locator(
      ".warehouse-card:not(.missing-card)",
    ).evaluateAll(cards => cards.map(card => ({
      id: card.dataset.warehouseId,
      totals: Object.fromEntries(
        [...card.querySelectorAll(".distribution-block")].map(block => [
          block.dataset.distribution,
          Number(block.dataset.total || 0),
        ]),
      ),
    })));
    for (const card of cardDistributionTotals) {
      const source = selectedRows.get(card.id);
      assert(source, `selected hour row missing for ${card.id}`);
      assert.equal(
        card.totals.template_name,
        sum(source.templates || [], "machine_count"),
      );
      assert.equal(
        card.totals.work_mode,
        sum(source.work_modes || [], "machine_count"),
      );
    }
    assert.equal(await page.locator(".warehouse-card .card-glance").count(),
      boxesWithData);
    assert.equal(await page.locator(".warehouse-card .power-comparison").count(),
      await page.locator(".warehouse-card .power-reference").count());
    assert.equal(await page.locator(".warehouse-card .peak-summary").count(),
      boxesWithData);
    assert.equal(await page.locator(".peak-strip").count(), 0);
    assert((await page.locator("#metrics").textContent()).includes(
      "Lark 在架功率"
    ));
    assert.equal(await page.locator("#trend .chart-hit").count(), 7);
    assert.equal(await page.locator("#trend .chart-selection").count(), 1);
    await page.locator("[data-load-filter='below']").click();
    assert(await page.locator(".warehouse-card").count() > 0);
    assert.equal(await page.locator(".warehouse-card[data-load-class='below']")
      .count(), await page.locator(".warehouse-card").count());
    await page.locator("[data-load-filter='over']").click();
    assert.equal(await page.locator(".warehouse-card")
      .count(), await page.locator(".warehouse-card[data-load-class='over']")
        .count());
    await page.locator("[data-load-filter='all']").click();
    assert.equal(await page.locator(".warehouse-card").count(),
      whiteoakActiveIds.size);
    await page.locator("[data-trend-metric='power']").click();
    assert((await page.locator("#trend-title").textContent()).includes("功率趋势"));
    assert.equal(await page.locator("#trend .chart-line.actual").count(), 1);
    assert.equal(await page.locator("#trend .chart-line.theory").count(), 1);
    assert.equal(await page.locator("#trend .chart-line.mounted").count(), 0);
    assert.equal(await page.locator("#trend .chart-series-point.mounted").count(), 1);
    assert.equal(await page.locator("#trend-summary .trend-legend > span").count(), 3);
    assert((await page.locator("#trend-meta").textContent()).includes("日均小时功率"));
    await page.screenshot({
      path: path.join(ROOT, "outputs", "dashboard-check", "overview-power.png"),
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });
    await page.locator("[data-trend-metric='ratio']").click();
    assert(!requests.some(url => /\/data\/[0-9a-f]{32}_\d{10}_/.test(url)));
    const latestDaily = whiteoak.daily_summary.find(item =>
      item.date === catalog.latest_date
    );
    assert(latestDaily, "latest WhiteOak daily coverage missing");
    assert((await page.locator("#date option:checked").textContent()).includes(
      `运行 ${latestDaily.hours_with_data}/${latestDaily.expected_hours} 小时`
    ));
    assert((await page.locator("#date option:checked").textContent()).includes(
      `完整 ${latestDaily.complete_warehouse_count}/${latestDaily.warehouses_with_data} 箱`
    ));
    assert.equal(await page.locator("#coverage").getAttribute("data-complete"),
      String(latestDaily.is_fully_complete));
    assert((await page.locator("#coverage").textContent()).includes(
      `场地 ${latestDaily.hours_with_data}/${latestDaily.expected_hours} 小时有数据`
    ));
    assert((await page.locator("#coverage").textContent()).includes(
      `${latestDaily.complete_warehouse_count}/${latestDaily.warehouses_with_data} 个矿箱完整`
    ));
    const expectedCoverageWarnings = latestDaily.incomplete_warehouse_count;
    assert.equal(await page.locator(
      ".warehouse-hour-coverage.warn, .missing-coverage.warn"
    ).count(), expectedCoverageWarnings);

    await page.locator("[data-trend-mode='hourly']").click();
    assert.equal(await page.locator("#trend .chart-hit").count(), 24);
    assert.equal(
      await page.locator("#trend .chart-missing-band").count(),
      24 - latestDaily.hours_with_data,
    );
    assert((await page.locator("#trend-summary").textContent()).includes("当前小时"));
    assert((await page.locator("#trend-meta").textContent()).includes("灰色带"));
    await page.locator("[data-trend-mode='daily']").click();

    const chartDate = whiteoak.available_dates[2];
    await page.locator("#trend .chart-hit").nth(2).click();
    await page.waitForFunction(date =>
      document.querySelector("#meta")?.textContent.includes(`当前 ${date}`),
      chartDate);
    assert.equal(await page.locator("#date").inputValue(), chartDate);
    assert(await page.locator("#loading").isHidden());

    const firstDate = whiteoak.available_dates[0];
    await page.selectOption("#date", firstDate);
    await page.waitForFunction(date =>
      document.querySelector("#meta")?.textContent.includes(`当前 ${date}`),
      firstDate);
    assert.equal(await page.locator(".warehouse-card button:not([disabled])")
      .count(), 0);
    assert((await page.locator("#detail-note").textContent()).includes("历史日期"));
    assert.equal(await page.locator(".warehouse-card .capacity-row").count(), 0);
    assert.equal(await page.locator(".warehouse-card .lark-power-panel.snapshot-missing")
      .count(), await page.locator(".warehouse-card:not(.missing-card)").count());
    assert((await page.locator("#coverage").textContent()).includes(
      "没有 Lark 功率快照"
    ));

    const latestDate = whiteoak.available_dates.at(-1);
    await page.selectOption("#date", latestDate);
    await page.waitForFunction(date =>
      document.querySelector("#meta")?.textContent.includes(`当前 ${date}`),
      latestDate);
    const peakHourButton = page.locator(".peak-hour-action").first();
    const dailyMachineButton = page.locator(".peak-machine-action").first();
    assert(await peakHourButton.isEnabled());
    assert(await dailyMachineButton.isEnabled());
    assert.equal(await page.locator(".peak-hour-action").count(), boxesWithData);
    assert.equal(await page.locator(".peak-machine-action").count(), boxesWithData);
    const peakId = await peakHourButton.getAttribute("data-peak-hour-id");
    const stablePeakHourButton = page.locator(
      `.peak-hour-action[data-peak-hour-id="${peakId}"]`,
    );
    const stableDailyMachineButton = page.locator(
      `.peak-machine-action[data-daily-machine-id="${peakId}"]`,
    );
    const peakRows = latestDayRows.filter(row =>
      row.data_center_id === whiteoak.data_center_id
      && row.warehouse_id === peakId
      && Number.isFinite(row.actual_power_kw)
    );
    const peak = peakRows.reduce((best, row) =>
      !best || row.actual_power_kw > best.actual_power_kw ? row : best,
    null);
    assert(peak, "peak warehouse hour not found");
    const peakDetail = readGzipJson(path.join(
      DATA,
      "details",
      whiteoak.data_center_id,
      latestDate.replaceAll("-", ""),
      `${peakId}.json.gz`,
    ));
    const dayPeakMachine = Object.entries(peakDetail.hours).reduce(
      (best, [hour, data]) => {
        const machine = data.machine_rows.reduce((candidate, item) =>
          !candidate || item.avg_power_w > candidate.avg_power_w
            ? item : candidate,
        null);
        return machine && (!best
          || machine.avg_power_w > best.machine.avg_power_w)
          ? { hour: Number(hour), machine }
          : best;
      },
      null,
    );
    assert(dayPeakMachine, "daily peak machine not found");
    const nonPeakHour = [...new Set(latestDayRows
      .filter(row => row.data_center_id === whiteoak.data_center_id)
      .map(row => row.hour))].find(hour => hour !== peak.hour);
    assert.notEqual(nonPeakHour, undefined);
    await page.selectOption("#hour", String(nonPeakHour));
    const pageHourBeforePeak = await page.locator("#hour").inputValue();
    await stablePeakHourButton.click();
    await page.waitForSelector("#detail-content tbody tr");
    assert.equal(await page.locator("#hour").inputValue(), pageHourBeforePeak);
    assert(await page.locator("#detail").evaluate(dialog => dialog.open));
    assert((await page.locator("#detail-title").textContent()).includes(
      "当日峰值小时"
    ));
    assert.equal(
      await page.locator('[data-level="template_rows"]')
        .getAttribute("aria-selected"),
      "true",
    );
    assert((await page.locator("#detail-meta").textContent()).includes(
      `${String(peak.hour).slice(8)}:00`
    ));
    assert.equal(await page.locator(".peak-machine-callout").count(), 0);
    assert.equal(await page.locator("#detail-metrics .metric").count(), 8);
    const detailMetricsText = await page.locator("#detail-metrics").textContent();
    assert(detailMetricsText.includes("单机理论平均功率"));
    assert(detailMetricsText.includes("理论 − 实际"));
    assert(!(await page.locator("#detail-capacity .lark-panel-foot")
      .textContent()).includes("单机理论平均"));
    await page.locator("#close").click();

    await stableDailyMachineButton.click();
    await page.waitForSelector(".peak-machine-callout");
    assert.equal(await page.locator("#hour").inputValue(), pageHourBeforePeak);
    assert(await page.locator("#detail").evaluate(dialog => dialog.open));
    assert((await page.locator("#detail-title").textContent()).includes(
      "当日最大功率矿机"
    ));
    assert.equal(
      await page.locator('[data-level="machine_rows"]')
        .getAttribute("aria-selected"),
      "true",
    );
    assert((await page.locator("#detail-meta").textContent()).includes(
      `${String(dayPeakMachine.hour).slice(8)}:00`
    ));
    assert((await page.locator(".peak-machine-callout").textContent())
      .includes("当日最大功率矿机"));
    assert((await page.locator(".peak-machine-callout").textContent())
      .includes(dayPeakMachine.machine.model));
    assert((await page.locator(".peak-machine-callout").textContent())
      .includes(dayPeakMachine.machine.ip));
    assert.equal(await page.locator("#detail-content tbody tr").first()
      .getAttribute("class"), "peak-machine-row");
    assert((await page.locator("#detail-content tbody tr").first().textContent())
      .includes(dayPeakMachine.machine.ip));
    await page.screenshot({
      path: path.join(ROOT, "outputs", "dashboard-check", "peak-machine.png"),
      fullPage: true,
    });
    await page.locator("#close").click();

    const detailRequestsBefore = requests.length;
    await page.locator(
      `.warehouse-card .card-head button[data-detail-id]:not([data-detail-id="${peakId}"])`,
    ).first().click();
    await page.waitForSelector("#detail-content tbody tr");
    const detailRequest = requests.slice(detailRequestsBefore)
      .find(url => url.includes("/data/details/"));
    assert(detailRequest, "detail request not found");
    assert(/\.json\.gz(?:\?|$)/.test(detailRequest));
    assert((await page.locator("#detail-meta").textContent()).includes("WhiteOak01"));
    assert.equal(await page.locator("#detail-capacity .capacity-row").count(), 2);
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
    const partialSite = catalog.sites.find(site => {
      const daily = site.daily_summary.find(item =>
        item.date === catalog.latest_date
      );
      return daily && !daily.is_complete;
    });
    if (partialSite) {
      const partialDaily = partialSite.daily_summary.find(item =>
        item.date === catalog.latest_date
      );
      await page.selectOption("#site", partialSite.data_center_id);
      await page.waitForFunction(name =>
        document.querySelector("#brand-name")?.textContent === name,
      partialSite.data_center_name);
      assert((await page.locator("#meta").textContent()).includes(
        `运行 ${partialDaily.hours_with_data}/${partialDaily.expected_hours} 小时`
      ));
      assert.equal(await page.locator("#coverage").getAttribute("data-complete"),
        "false");
      assert((await page.locator("#coverage").textContent()).includes(
        `场地 ${partialDaily.hours_with_data}/${partialDaily.expected_hours} 小时有数据`
      ));
    }
    await page.selectOption("#site", nimrod.data_center_id);
    await page.waitForFunction(name =>
      document.querySelector("#brand-name")?.textContent === name, "Nimrod01");
    const nimrodActiveIds = new Set(
      latestDayRows
        .filter(row => row.data_center_id === nimrod.data_center_id)
        .map(row => row.warehouse_id),
    );
    assert.equal(await page.locator(".warehouse-card").count(),
      nimrodActiveIds.size);
    assert((await page.locator("#trend-title").textContent()).includes("Nimrod01"));
    const missingCapacity = catalog.warehouses.find(warehouse =>
      warehouse.data_center_name === "Nimrod01"
      && nimrodActiveIds.has(warehouse.warehouse_id)
      && warehouse.lark_power_by_date?.[larkSnapshotDate]
      && warehouse.lark_power_by_date[larkSnapshotDate].mounted_power_kw == null
    );
    assert(missingCapacity, "active missing-capacity warehouse not found");
    const missingCard = page.locator(
      `[data-warehouse-id="${missingCapacity.warehouse_id}"]`,
    );
    await missingCard.locator("[data-detail-id]").click();
    await page.waitForSelector("#detail-capacity .lark-power-panel");
    assert((await page.locator("#detail-capacity .lark-panel-head").textContent())
      .includes("字段缺失"));
    assert((await page.locator("#detail-capacity .lark-power-panel").textContent())
      .includes("容量字段缺失"));
    await page.locator("#close").click();

    const nimrod02 = catalog.sites.find(site =>
      site.data_center_name === "Nimrod02"
    );
    const nimrod02LatestRows = latestDayRows.filter(row =>
      row.data_center_id === nimrod02.data_center_id
    );
    const nimrod02ActiveIds = new Set(
      nimrod02LatestRows.map(row => row.warehouse_id),
    );
    const nimrod02Inactive = catalog.warehouses.filter(warehouse =>
      warehouse.data_center_name === "Nimrod02"
      && !nimrod02ActiveIds.has(warehouse.warehouse_id)
    );
    assert.equal(nimrod02Inactive.length, 2);
    await page.selectOption("#site", nimrod02.data_center_id);
    await page.waitForFunction(name =>
      document.querySelector("#brand-name")?.textContent === name, "Nimrod02");
    await page.selectOption("#date", catalog.latest_date);
    await page.waitForFunction(date =>
      document.querySelector("#meta")?.textContent.includes(`当前 ${date}`),
      catalog.latest_date);
    assert.equal(await page.locator(".warehouse-card").count(),
      nimrod02ActiveIds.size);
    assert((await page.locator("#count").textContent()).includes(
      `${nimrod02ActiveIds.size} 个矿箱`
    ));
    for (const warehouse of nimrod02Inactive) {
      assert.equal(await page.locator(
        `[data-warehouse-id="${warehouse.warehouse_id}"]`
      ).count(), 0);
    }
    assert.equal(await page.locator(".lark-power-panel.unmatched").count(), 0);

    const racePage = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const raceSite = catalog.sites.find(site =>
      site.data_center_name === "May01"
    ) || catalog.sites[0];
    const raceDate = catalog.available_dates.at(-2);
    const latestDayFile = catalog.latest_date.replaceAll("-", "");
    const raceDayFile = raceDate.replaceAll("-", "");
    await racePage.route("**/data/days/*.json*", async route => {
      const url = route.request().url();
      const isLatest = url.includes(`/${latestDayFile}.json`);
      const isRaceDay = url.includes(`/${raceDayFile}.json`);
      if (!isLatest && !isRaceDay) {
        await route.continue();
        return;
      }
      if (isLatest) await new Promise(resolve => setTimeout(resolve, 2500));
      await route.fulfill({
        path: path.join(DATA, "days", `${isLatest ? latestDayFile : raceDayFile}.json.gz`),
        contentType: "application/gzip",
      });
    });
    await racePage.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });
    await racePage.waitForFunction(() =>
      document.querySelectorAll("#date option").length === 7);
    await racePage.waitForSelector("#loading:not([hidden])");
    await racePage.selectOption("#site", raceSite.data_center_id);
    await racePage.selectOption("#date", raceDate);
    await racePage.selectOption("#hour", `${raceDate.replaceAll("-", "")}10`);
    await racePage.waitForFunction(date =>
      document.querySelector("#meta")?.textContent.includes(`当前 ${date}`),
      raceDate);
    await racePage.waitForTimeout(3500);
    const racePower = await racePage.locator(
      "#metrics [data-metric='actual'] .overview-value"
    )
      .textContent();
    assert(!racePower.trim().startsWith("0"),
      "a late day response overwrote the newly selected day");
    assert.equal(await racePage.locator("#date").inputValue(), raceDate);
    assert(await racePage.locator("#loading").isHidden());
    await racePage.close();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => scrollTo(0, 0));
    assert(await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth
    ));
    await page.screenshot({
      path: path.join(ROOT, "outputs", "dashboard-check", "overview-mobile.png"),
      clip: { x: 0, y: 0, width: 390, height: 1100 },
    });
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
    await page.locator(".peak-machine-action").first().click();
    await page.waitForSelector(".peak-machine-callout");
    assert(await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth
    ));
    await page.screenshot({
      path: path.join(ROOT, "outputs", "dashboard-check", "mobile-detail.png"),
      fullPage: true,
    });
    await page.locator("#close").click();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

(async () => {
  const { catalog, lark, catalogRows, machineHours } = verifyPublishedData();
  if (!DATA_ONLY) {
    await verifyBrowser(catalog);
  }
  console.log(
    `PASS: ${catalog.sites.length} sites, ${catalog.available_dates.length} days, ` +
    `${catalogRows} warehouse hours, ${machineHours} latest-day machine hours, ` +
    `${lark.record_count} Lark power records; ` +
    (DATA_ONLY
      ? "data and lazy gzip details"
      : "data, lazy gzip details, Lark matching, peak drill-down, charts, site/date switching and mobile layout"),
  );
})().catch(error => {
  console.error(error);
  process.exit(1);
});
