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
const EXPECTED_UNIT_POWER_LIMITS = {
  Blossom01: 4000,
  May01: 4000,
  Nimrod01: 3500,
  Nimrod02: 4000,
  WhiteOak01: 4000,
};
const EXPECTED_THEORETICAL_POWER_KW = {
  Blossom01: 10000,
  May01: 11760,
  Nimrod01: 11812,
  Nimrod02: 15680,
  WhiteOak01: 40000,
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

function readDetailBundle(centerId, detailDate, warehouseId) {
  const folder = path.join(
    DATA, "details", centerId, detailDate.replaceAll("-", ""),
  );
  const summaryFile = path.join(folder, `${warehouseId}.summary.json.gz`);
  const machineFile = path.join(folder, `${warehouseId}.machines.json.gz`);
  assert(fs.existsSync(summaryFile), `missing detail summary: ${summaryFile}`);
  assert(fs.existsSync(machineFile), `missing detail machines: ${machineFile}`);
  const summary = readGzipJson(summaryFile);
  const machines = readGzipJson(machineFile);
  for (const [bundle, kind] of [
    [summary, "summary"], [machines, "machines"],
  ]) {
    assert.equal(bundle.schema_version, "4.0");
    assert.equal(bundle.detail_kind, kind);
    assert.equal(bundle.data_center_id, centerId);
    assert.equal(bundle.date, detailDate);
    assert.equal(bundle.warehouse_id, warehouseId);
  }
  assert.deepEqual(
    Object.keys(summary.hours).sort(),
    Object.keys(machines.hours).sort(),
  );
  const hours = {};
  for (const hour of Object.keys(summary.hours)) {
    hours[hour] = {
      ...summary.hours[hour],
      ...machines.hours[hour],
    };
  }
  return { ...summary, hours };
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

function expectedHourlySummaries(rows) {
  const rowsByHour = new Map();
  for (const row of rows) {
    if (!rowsByHour.has(row.hour)) rowsByHour.set(row.hour, []);
    rowsByHour.get(row.hour).push(row);
  }
  return [...rowsByHour.entries()]
    .sort(([left], [right]) => left - right)
    .map(([hour, hourRows]) => {
      const machineRows = hourRows.filter(row =>
        row.actual_power_kw != null || Number(row.machine_count || 0) > 0
      );
      const validPower = sum(machineRows, "power_ratio_valid_power_sum_w");
      const validHashrate = sum(
        machineRows, "power_ratio_valid_hashrate_sum_ths",
      );
      return {
        hour,
        warehouse_count: new Set(
          machineRows.map(row => row.warehouse_id),
        ).size,
        machine_count: Math.trunc(sum(machineRows, "machine_count")),
        power_ratio_sample_count: Math.trunc(
          sum(machineRows, "power_ratio_sample_count"),
        ),
        actual_power_kw: machineRows.length
          ? sum(machineRows, "actual_power_kw")
          : null,
        power_ratio_valid_power_sum_w: validPower,
        power_ratio_valid_hashrate_sum_ths: validHashrate,
        power_ratio_overall_w_per_th: validHashrate > 0
          ? validPower / validHashrate
          : null,
      };
    });
}

function expectedWarehouseDailyPeaks(rows) {
  const rowsByWarehouse = new Map();
  for (const row of rows) {
    if (row.actual_power_kw == null) continue;
    if (!rowsByWarehouse.has(row.warehouse_id)) {
      rowsByWarehouse.set(row.warehouse_id, []);
    }
    rowsByWarehouse.get(row.warehouse_id).push(row);
  }
  return [...rowsByWarehouse.values()]
    .map(warehouseRows => warehouseRows.reduce((peak, row) =>
      !peak || row.actual_power_kw > peak.actual_power_kw ? row : peak,
    null))
    .sort((left, right) =>
      left.warehouse_name < right.warehouse_name ? -1
        : left.warehouse_name > right.warehouse_name ? 1 : 0
    );
}

function expectedMachinePowerStats(machineRows) {
  const samples = new Map();
  for (const row of machineRows) {
    const power = Number(row.avg_power_w);
    if (!Number.isFinite(power) || row.hour == null) continue;
    const key = `${row.warehouse_id}\u001f${row.hour}\u001f${row.ip || ""}`;
    const previous = samples.get(key);
    if (!previous || power > previous.power) {
      samples.set(key, { hour: Number(row.hour), ip: row.ip || "", power, row });
    }
  }

  const byWarehouse = new Map();
  for (const sample of samples.values()) {
    if (!byWarehouse.has(sample.row.warehouse_id)) {
      byWarehouse.set(sample.row.warehouse_id, []);
    }
    byWarehouse.get(sample.row.warehouse_id).push(sample);
  }

  const result = new Map();
  for (const [warehouseId, warehouseSamples] of byWarehouse) {
    const totalPower = sum(warehouseSamples, "power");
    const hourPeak = warehouseSamples.reduce((best, sample) =>
      !best || sample.power > best.power
        || (sample.power === best.power && sample.hour < best.hour)
        ? sample : best
    , null);
    const byIp = new Map();
    for (const sample of warehouseSamples) {
      if (!byIp.has(sample.ip)) byIp.set(sample.ip, []);
      byIp.get(sample.ip).push(sample);
    }
    const dailyIp = [...byIp.entries()].reduce((best, [ip, ipSamples]) => {
      const power = sum(ipSamples, "power");
      const average = power / ipSamples.length;
      return !best || average > best.average
        || (average === best.average && ip > best.ip)
        ? { ip, power, average, samples: ipSamples }
        : best;
    }, null);
    const dailyRepresentative = dailyIp.samples.reduce((best, sample) =>
      !best || sample.power > best.power
        || (sample.power === best.power && sample.hour < best.hour)
        ? sample : best
    , null);
    result.set(warehouseId, {
      machine_hour_peak_power_w: hourPeak.power,
      machine_hour_peak_hour: hourPeak.hour,
      machine_hour_peak_ip: hourPeak.ip,
      machine_hour_peak_model: hourPeak.row.model,
      machine_hour_peak_work_mode: hourPeak.row.work_mode,
      machine_hour_peak_hashrate_ths: Number(hourPeak.row.avg_hashrate_ths),
      machine_hour_peak_ratio_w_per_th: Number(
        hourPeak.row.power_ratio_w_per_th,
      ),
      machine_hour_peak_temperature_c: Number(hourPeak.row.temperature_c),
      machine_hour_peak_rejected_rate: Number(hourPeak.row.rejected_rate),
      machine_daily_avg_peak_power_w: dailyIp.average,
      machine_daily_avg_peak_ip: dailyIp.ip,
      machine_daily_avg_peak_model: dailyRepresentative.row.model,
      machine_daily_avg_peak_work_mode: dailyRepresentative.row.work_mode,
      machine_daily_avg_peak_valid_hours: dailyIp.samples.length,
      machine_daily_avg_peak_hour: dailyRepresentative.hour,
      machine_daily_avg_peak_hashrate_ths: Number(
        dailyRepresentative.row.avg_hashrate_ths,
      ),
      machine_daily_avg_peak_ratio_w_per_th: Number(
        dailyRepresentative.row.power_ratio_w_per_th,
      ),
      machine_daily_avg_peak_temperature_c: Number(
        dailyRepresentative.row.temperature_c,
      ),
      machine_daily_avg_peak_rejected_rate: Number(
        dailyRepresentative.row.rejected_rate,
      ),
      warehouse_machine_avg_power_w: totalPower / warehouseSamples.length,
      machine_hour_sample_count: warehouseSamples.length,
    });
  }
  return result;
}

function assertHourlySummaries(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    const actualRow = actual[index];
    const expectedRow = expected[index];
    assert.equal(actualRow.hour, expectedRow.hour);
    assert.equal(actualRow.warehouse_count, expectedRow.warehouse_count);
    assert.equal(actualRow.machine_count, expectedRow.machine_count);
    assert.equal(
      actualRow.power_ratio_sample_count,
      expectedRow.power_ratio_sample_count,
    );
    for (const key of [
      "actual_power_kw",
      "power_ratio_valid_power_sum_w",
      "power_ratio_valid_hashrate_sum_ths",
      "power_ratio_overall_w_per_th",
    ]) {
      assert(close(actualRow[key], expectedRow[key]),
        `${key} mismatch for hour ${expectedRow.hour}`);
    }
  }
}

function normalizeWarehouseNumber(value) {
  return Number(String(value).trim().replace(/^C/i, ""));
}

function expectedWarehouseTheoreticalPower(site, warehouseNumber) {
  if (site === "Blossom01" || site === "WhiteOak01") return 1000;
  if (site === "May01" || site === "Nimrod02") return 980;
  if (site === "Nimrod01") {
    if (warehouseNumber <= 12) return 657;
    if (warehouseNumber <= 16) return 492;
    return 980;
  }
  throw new Error(`unexpected site for theoretical power: ${site}`);
}

function larkKey(site, warehouseNumber) {
  return `${String(site).trim().toLocaleLowerCase()}/${Number(warehouseNumber)}`;
}

function verifyPublishedData() {
  const catalog = readJson(path.join(DATA, "catalog.json"));
  assert.equal(catalog.schema_version, "3.6");
  assert.equal(catalog.timezone, "UTC+0");
  assert.equal(catalog.date_range.days, 7);
  assert.equal(catalog.available_dates.length, 7);
  assert.deepEqual(catalog.available_dates, [...catalog.available_dates].sort());
  assert.deepEqual(
    catalog.sites.map(site => site.data_center_name).sort(),
    EXPECTED_SITES,
  );
  assert.deepEqual(
    catalog.detail_dates,
    [...catalog.detail_dates].sort(),
  );
  assert(catalog.detail_dates.length > 0, "missing detail dates");
  for (const date of catalog.detail_dates) {
    assert(catalog.available_dates.includes(date));
  }
  for (const site of catalog.sites) {
    assert.equal(
      site.unit_power_limit_w,
      EXPECTED_UNIT_POWER_LIMITS[site.data_center_name],
    );
  }
  for (const warehouse of catalog.warehouses) {
    assert.equal(
      warehouse.unit_power_limit_w,
      EXPECTED_UNIT_POWER_LIMITS[warehouse.data_center_name],
    );
  }

  const lark = readJson(path.join(DATA, "lark_power.json"));
  const larkHistoryDir = path.join(DATA, "lark_power_history");
  const larkHistoryFiles = fs.readdirSync(larkHistoryDir)
    .filter(name => /^\d{8}\.json$/.test(name))
    .sort();
  assert(larkHistoryFiles.length > 0, "missing dated Lark snapshots");
  const larkSnapshots = new Map();
  const larkRecordsByDate = new Map();
  const larkCatalogSnapshots = [];
  for (const fileName of larkHistoryFiles) {
    const file = path.join(larkHistoryDir, fileName);
    const snapshot = fileName ===
      `${lark.snapshot_date.replaceAll("-", "")}.json`
      ? lark
      : readJson(file);
    const expectedDate = `${fileName.slice(0, 4)}-${fileName.slice(4, 6)}-` +
      fileName.slice(6, 8);
    assert.equal(snapshot.schema_version, "1.0");
    assert.equal(snapshot.snapshot_date, expectedDate);
    assert.equal(snapshot.source, "lark_bitable");
    assert.equal(snapshot.base_token, "VuLLbn5bNaIWkoswngWlyEOygof");
    assert.equal(snapshot.table_id, "tblNq169SbT5aD2N");
    assert.equal(snapshot.view_id, "vewUWFcYgO");
    assert(Number.isFinite(Date.parse(snapshot.synced_at)));
    assert.equal(snapshot.record_count, 96);
    assert.equal(snapshot.records.length, snapshot.record_count);
    assert(!/SourceID|ip[_ -]?range|IP范围|app[_ -]?secret/i.test(
      JSON.stringify(snapshot),
    ));

    const larkCounts = Object.fromEntries(
      Object.keys(EXPECTED_LARK_COUNTS).map(site => [site, 0]),
    );
    const larkRecords = new Map();
    for (const record of snapshot.records) {
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
    larkSnapshots.set(expectedDate, snapshot);
    larkRecordsByDate.set(expectedDate, larkRecords);
    larkCatalogSnapshots.push({
      snapshot_date: snapshot.snapshot_date,
      schema_version: snapshot.schema_version,
      source: snapshot.source,
      synced_at: snapshot.synced_at,
      record_count: snapshot.record_count,
      matched_warehouses: snapshot.record_count,
      unmatched_records: [],
    });

    const larkMissing = { Nimrod01: 0, WhiteOak01: 0 };
    for (const record of snapshot.records) {
      if (!Number.isFinite(record.mounted_power_kw)) {
        assert(Object.hasOwn(larkMissing, record.site));
        larkMissing[record.site] += 1;
      }
    }
    assert.deepEqual(larkMissing, { Nimrod01: 3, WhiteOak01: 1 });
  }
  assert.deepEqual(
    [...larkSnapshots.keys()],
    [...larkSnapshots.keys()].sort(),
  );
  assert.equal(larkSnapshots.size, larkCatalogSnapshots.length);
  assert(larkSnapshots.has(lark.snapshot_date), "latest Lark snapshot missing");
  assert.equal([...larkSnapshots.keys()].at(-1), lark.snapshot_date);
  assert.deepEqual(readJson(path.join(
    larkHistoryDir,
    `${lark.snapshot_date.replaceAll("-", "")}.json`,
  )), lark);
  assert.deepEqual(catalog.lark_power, {
    latest_snapshot_date: lark.snapshot_date,
    snapshots: larkCatalogSnapshots,
  });

  assert.equal(catalog.warehouses.length, 96);
  const theoreticalPowerByWarehouseId = new Map();
  let matchedWarehouses = 0;
  for (const warehouse of catalog.warehouses) {
    const warehouseNumber = normalizeWarehouseNumber(
      warehouse.warehouse_name,
    );
    const expectedTheory = expectedWarehouseTheoreticalPower(
      warehouse.data_center_name, warehouseNumber,
    );
    assert.equal(warehouse.theoretical_power_kw, expectedTheory);
    theoreticalPowerByWarehouseId.set(
      warehouse.warehouse_id, expectedTheory,
    );
    const expectedLarkByDate = {};
    for (const [date, records] of larkRecordsByDate) {
      const key = larkKey(
        warehouse.data_center_name,
        normalizeWarehouseNumber(warehouse.warehouse_name),
      );
      const expectedLark = records.get(key);
      if (expectedLark) expectedLarkByDate[date] = expectedLark;
    }
    if (Object.keys(expectedLarkByDate).length) {
      assert.deepEqual(warehouse.lark_power_by_date, expectedLarkByDate);
      if (expectedLarkByDate[lark.snapshot_date]) matchedWarehouses += 1;
    } else {
      assert(!("lark_power_by_date" in warehouse));
    }
  }
  assert.equal(matchedWarehouses, 96);
  assert.equal(larkRecordsByDate.get(lark.snapshot_date).size, matchedWarehouses);

  for (const site of catalog.sites) {
    assert.equal(
      site.theoretical_power_kw,
      EXPECTED_THEORETICAL_POWER_KW[site.data_center_name],
    );
    assert.deepEqual(
      Object.keys(site.lark_power_by_date || {}).sort(),
      [...larkSnapshots.keys()],
    );
    for (const date of larkSnapshots.keys()) {
      const snapshot = site.lark_power_by_date?.[date];
      assert(snapshot, `missing site Lark snapshot: ${date} ${site.data_center_name}`);
      assert.equal(snapshot.matched_warehouses,
        EXPECTED_LARK_COUNTS[site.data_center_name]);
      assert.equal(snapshot.total_warehouses, site.warehouse_count);
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
    16,
  );

  const rowsByDate = new Map();
  const expectedHourFiles = new Set();
  let allRows = 0;
  for (const date of catalog.available_dates) {
    const file = path.join(DATA, "days", `${date.replaceAll("-", "")}.json.gz`);
    assert(fs.existsSync(file), `missing day file: ${file}`);
    const day = readGzipJson(file);
    assert.equal(day.schema_version, "3.0");
    assert.equal(day.date, date);
    assert.equal(day.timezone, "UTC+0");
    assert(Array.isArray(day.warehouse_rows) && day.warehouse_rows.length);
    const keys = new Set();
    for (const row of day.warehouse_rows) {
      const key = `${row.data_center_id}/${row.hour}/${row.warehouse_id}`;
      assert(!keys.has(key), `duplicate warehouse hour: ${key}`);
      keys.add(key);
      assert.equal(
        row.theoretical_power_kw,
        theoreticalPowerByWarehouseId.get(row.warehouse_id),
        `hourly theoretical power changed for ${row.warehouse_name}`,
      );
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

    for (const site of catalog.sites) {
      if (!site.available_dates.includes(date)) continue;
      const siteFile = path.join(
        DATA, "days", `${site.data_center_id}-${date.replaceAll("-", "")}.json.gz`,
      );
      assert(fs.existsSync(siteFile), `missing site day file: ${siteFile}`);
      const siteDay = readGzipJson(siteFile);
      assert.equal(siteDay.schema_version, "3.0");
      assert.equal(siteDay.date, date);
      assert(siteDay.warehouse_rows.every(
        row => row.data_center_id === site.data_center_id,
      ));
      assert.deepEqual(
        siteDay.warehouse_rows,
        day.warehouse_rows.filter(
          row => row.data_center_id === site.data_center_id,
        ),
      );

      const siteHours = [...new Set(
        siteDay.warehouse_rows.map(row => row.hour),
      )].sort((left, right) => left - right);
      const expectedSummaries = expectedHourlySummaries(
        siteDay.warehouse_rows,
      );
      const expectedPeaks = expectedWarehouseDailyPeaks(
        siteDay.warehouse_rows,
      );
      for (const hour of siteHours) {
        const hourName = `${site.data_center_id}-${date.replaceAll("-", "")}-` +
          `${String(hour).slice(-2)}.json.gz`;
        const hourFile = path.join(DATA, "hours", hourName);
        expectedHourFiles.add(hourName);
        assert(fs.existsSync(hourFile), `missing hour file: ${hourFile}`);
        const hourData = readGzipJson(hourFile);
        assert.equal(hourData.schema_version, "3.3");
        assert.equal(hourData.date, date);
        assert.equal(hourData.hour, hour);
        assert.deepEqual(
          hourData.warehouse_rows,
          siteDay.warehouse_rows
            .filter(row => row.hour === hour)
            .sort((left, right) =>
              left.warehouse_name < right.warehouse_name ? -1
                : left.warehouse_name > right.warehouse_name ? 1 : 0
            ),
        );
        assert.deepEqual(hourData.warehouse_peaks, expectedPeaks);
        assertHourlySummaries(hourData.hourly_summary, expectedSummaries);
      }
    }
  }
  assert.deepEqual(
    fs.readdirSync(path.join(DATA, "hours"))
      .filter(name => name.endsWith(".json.gz"))
      .sort(),
    [...expectedHourFiles].sort(),
  );

  const nimrod02Warehouses = catalog.warehouses.filter(warehouse =>
    warehouse.data_center_name === "Nimrod02"
  );
  assert.equal(nimrod02Warehouses.length, 16);
  assert.deepEqual(
    nimrod02Warehouses.map(warehouse => warehouse.warehouse_name).sort(),
    Array.from({ length: 16 }, (_, index) =>
      `C${String(index + 1).padStart(2, "0")}`),
  );
  const nimrod02LatestRows = rowsByDate.get(catalog.latest_date).filter(row =>
    row.data_center_id === nimrod02.data_center_id
  );
  const nimrod02LatestIds = new Set(
    nimrod02LatestRows.map(row => row.warehouse_id),
  );
  assert.equal(nimrod02LatestIds.size, 16);
  for (const warehouseName of ["C17", "C18"]) {
    assert.equal(nimrod02Warehouses.find(item =>
      item.warehouse_name === warehouseName
    ), undefined);
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
    const machineRows = rows.filter(row =>
      row.actual_power_kw != null || Number(row.machine_count || 0) > 0
    );
    const warehouseCounts = {};
    for (const row of machineRows) {
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
      new Set(rows.map(row => row.warehouse_id)).size);
    assert.equal(daily.machine_warehouses_with_data,
      Object.keys(warehouseCounts).length);
    assert.equal(daily.warehouses_without_data,
      daily.warehouse_count - Object.keys(warehouseCounts).length);
    assert.equal(daily.min_warehouse_hours,
      Object.keys(warehouseCounts).length
        ? Math.min(...Object.values(warehouseCounts))
        : null);
    assert.equal(sum(machineRows, "machine_count"), daily.machine_count);
    assert(close(
      machineRows.length ? sum(machineRows, "actual_power_kw") : null,
      daily.actual_power_kw,
    ));
    const meterRows = rows.filter(row =>
      row.meter_data_available && Number.isFinite(row.meter_power_kw)
    );
    const meterPowerByHour = new Map();
    for (const row of meterRows) {
      meterPowerByHour.set(
        row.hour,
        (meterPowerByHour.get(row.hour) || 0) + row.meter_power_kw,
      );
    }
    const expectedMeterPeak = meterPowerByHour.size
      ? [...meterPowerByHour.entries()]
        .sort((left, right) =>
          right[1] - left[1] || left[0] - right[0]
        )[0]
      : null;
    assert.equal(daily.meter_hour_count, meterPowerByHour.size);
    assert.equal(daily.meter_hours_with_data, meterPowerByHour.size);
    if (expectedMeterPeak) {
      assert(close(daily.meter_hour_peak_kw, expectedMeterPeak[1]));
      assert.equal(daily.meter_hour_peak_hour, expectedMeterPeak[0]);
    }
    else {
      assert.equal(daily.meter_hour_peak_kw, null);
      assert.equal(daily.meter_hour_peak_hour, null);
    }
    assert.equal(
      daily.theoretical_power_kw,
      EXPECTED_THEORETICAL_POWER_KW[daily.data_center_name],
    );
    assert.equal(
      daily.configured_theoretical_power_kw,
      EXPECTED_THEORETICAL_POWER_KW[daily.data_center_name],
    );
    assert(close(
      expectedOverallRatio(machineRows),
      daily.power_ratio_overall_w_per_th,
    ));
  }

  let machineHours = 0;
  for (const detailDate of catalog.detail_dates) {
    const grouped = new Map();
    const detailRows = rowsByDate.get(detailDate).filter(row =>
      row.machine_data_available
        || row.actual_power_kw != null
        || Number(row.machine_count || 0) > 0
    );
    for (const row of detailRows) {
      const key = `${row.data_center_id}/${row.warehouse_id}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }

    for (const [key, rows] of grouped) {
      const [centerId, warehouseId] = key.split("/");
      const bundle = readDetailBundle(centerId, detailDate, warehouseId);
      assert.equal(bundle.data_center_id, centerId);
      assert.equal(bundle.date, detailDate);
      assert.equal(bundle.timezone, "UTC+0");
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

      const allMachines = Object.values(bundle.hours)
        .flatMap(detail => detail.machine_rows || []);
      const expectedStats = expectedMachinePowerStats(allMachines);
      const expectedWarehouseStats = expectedStats.get(warehouseId);
      assert(expectedWarehouseStats,
        `missing expected machine power stats: ${key}/${detailDate}`);
      for (const row of rows) {
        for (const field of [
          "machine_hour_peak_power_w",
          "machine_daily_avg_peak_power_w",
          "warehouse_machine_avg_power_w",
        ]) {
          assert(close(row[field], expectedWarehouseStats[field]),
            `${field} mismatch for ${key}/${detailDate}`);
        }
        for (const field of [
          "machine_hour_peak_hour",
          "machine_hour_peak_ip",
          "machine_hour_peak_model",
          "machine_hour_peak_work_mode",
          "machine_daily_avg_peak_ip",
          "machine_daily_avg_peak_model",
          "machine_daily_avg_peak_work_mode",
          "machine_daily_avg_peak_valid_hours",
          "machine_daily_avg_peak_hour",
          "machine_hour_sample_count",
        ]) {
          assert.equal(row[field], expectedWarehouseStats[field],
            `${field} mismatch for ${key}/${detailDate}`);
        }
      }
    }
  }

  return {
    catalog,
    lark,
    catalogRows: allRows,
    machineHours,
    hourBundles: expectedHourFiles.size,
  };
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
    assert(requests.some(url => /\/data\/hours\/[^?]+\.json\.gz/.test(url)));
    assert(!requests.some(url => /\/data\/days\//.test(url)));

    const whiteoak = catalog.sites.find(site =>
      site.data_center_name === "WhiteOak01"
    );
    const latestDayRows = readGzipJson(path.join(
      DATA, "days", `${catalog.latest_date.replaceAll("-", "")}.json.gz`,
    )).warehouse_rows;
    const larkSnapshotDate = catalog.lark_power.latest_snapshot_date;
    const larkSnapshotDatesInRange = new Set(
      catalog.lark_power.snapshots
        .map(snapshot => snapshot.snapshot_date)
        .filter(date =>
          date >= catalog.date_range.start && date <= catalog.date_range.end
        ),
    );
    assert.equal(larkSnapshotDate, catalog.latest_date);
    assert.equal(await page.locator("#site").inputValue(),
      whiteoak.data_center_id);
    assert.equal(await page.locator("#brand-name").textContent(),
      "WhiteOak01");
    assert.equal(await page.locator("#date option").count(), 7);
    assert((await page.locator(".badge").textContent()).includes("UTC+0"));
    assert((await page.locator("#meta").textContent()).includes("UTC+0"));
    assert((await page.locator("#date option:checked").textContent())
      .includes("UTC+0"));
    assert((await page.locator("#hour option:checked").textContent())
      .includes("UTC+0"));
    assert((await page.locator("#notice").textContent()).includes("UTC+0"));
    assert((await page.locator("footer").textContent()).includes("UTC+0"));
    assert.equal(await page.locator(".warehouse-card").count(),
      whiteoak.warehouse_count);
    assert.equal(await page.locator(".machine-power-metric").count(),
      whiteoak.warehouse_count * 3);
    const machinePowerLabels = await page.locator(
      ".warehouse-card .machine-power-metric > span",
    ).allTextContents();
    assert.equal(
      machinePowerLabels.filter(label =>
        label.includes("矿箱内矿机当日平均功率峰值")
      ).length,
      whiteoak.warehouse_count,
      "每个矿箱都必须使用新的矿箱内矿机当日平均功率峰值名称",
    );
    assert(
      !machinePowerLabels.some(label =>
        label.includes("单机当日平均功率峰值")
      ),
      "不能重新出现旧的单机当日平均功率峰值名称",
    );
    await page.locator(".warehouse-card").first().screenshot({
      path: path.join(
        ROOT, "outputs", "dashboard-check", "machine-power-labels.png",
      ),
    });
    const populatedMachinePowerValues = await page.locator(
      ".warehouse-card:not(.missing-card):not(.meter-only-card) "
        + ".machine-power-metric strong",
    ).allTextContents();
    assert(populatedMachinePowerValues.length > 0);
    assert(populatedMachinePowerValues.every(value =>
      !value.includes("—") && /\d/.test(value)
    ), "populated warehouse cards must render machine power values");
    const machineMetricLayout = await page.evaluate(() =>
      [...document.querySelectorAll(".machine-power-metrics")].map(element => {
        const metrics = [...element.querySelectorAll(".machine-power-metric")]
          .map(metric => metric.getBoundingClientRect());
        const widths = metrics.map(box => box.width);
        const heights = metrics.map(box => box.height);
        return {
          columns: getComputedStyle(element).gridTemplateColumns
            .split(/\s+/).filter(Boolean).length,
          equalWidths: Math.max(...widths) - Math.min(...widths) < 1,
          equalHeights: Math.max(...heights) - Math.min(...heights) < 1,
          validCount: metrics.length === 3,
        };
      })
    );
    assert(machineMetricLayout.length > 0);
    assert(machineMetricLayout.every(item =>
      item.columns === 3 && item.equalWidths && item.equalHeights
      && item.validCount
    ));
    const selectedHour = Number(await page.locator("#hour").inputValue());
    const whiteoakActiveIds = new Set(
      latestDayRows
        .filter(row =>
          row.data_center_id === whiteoak.data_center_id
          && row.hour === selectedHour
        )
        .map(row => row.warehouse_id),
    );
    assert.equal(await page.locator(".warehouse-card.missing-card").count(),
      whiteoak.warehouse_count - whiteoakActiveIds.size);
    assert.equal(await page.locator("#metrics .overview-stat").count(), 4);
    assert.equal(await page.locator("#metrics .overview-support-item").count(), 2);
    assert.equal(await page.locator(".load-filters button").count(), 3);
    assert.deepEqual(await page.locator("#sort option").allTextContents(), [
      "矿箱小时实际功率",
      "矿箱电表小时实测功率",
      "矿箱实际余量",
      "矿箱号",
    ]);
    assert.equal(await page.locator("#sort").inputValue(), "power");
    assert.equal(await page.locator(
      'input[name="sort-order"]:checked',
    ).inputValue(), "asc");
    assert.equal(await page.locator("#metrics .overview-margin").count(), 4);
    assert.equal(await page.locator(
      ".warehouse-card .card-title .status",
    ).evaluateAll(nodes => nodes.filter(node =>
      node.textContent.includes("%")
    ).length), 0);
    assert((await page.locator(
      ".warehouse-card .power-comparison-labels",
    ).first().textContent()).includes("占矿箱理论功率"));
    assert.equal(await page.locator(
      "#metrics [data-metric='actual'], #metrics [data-metric='meter'], " +
      "#metrics [data-metric='mounted'], #metrics [data-metric='reserved']"
    ).count(), 4);
    const overviewText = await page.locator("#metrics").textContent();
    assert(overviewText.includes("矿机数据覆盖"));
    assert(overviewText.includes("上报矿机"));
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
      ".warehouse-card .distribution-trigger",
    ).count(), boxesWithData);
    assert.equal(await page.locator(".warehouse-card .card-coverage").count(),
      whiteoak.warehouse_count);
    const cardStates = await page.evaluate(() => {
      const source = currentRows.find(row =>
        !row.missing && row.inferred_outage !== true
      );
      const noCoverageWarehouse = warehouses.find(warehouse =>
        warehouse.data_center_id === currentSite()?.data_center_id
        && !(currentSite()?.warehouse_hours_by_date?.[selectedDate]?.[
          warehouse.warehouse_id
        ]?.length)
      );
      if (!source || !noCoverageWarehouse || typeof cardHTML !== "function") {
        return null;
      }
      return {
        missing: cardHTML({
          ...source,
          warehouse_id: noCoverageWarehouse.warehouse_id,
          warehouse_name: noCoverageWarehouse.warehouse_name,
          missing: true,
          inferred_outage: false,
          actual_power_kw: null,
        }),
        outage: cardHTML({
          ...source,
          missing: true,
          inferred_outage: true,
          actual_power_kw: null,
        }),
        zero: cardHTML({
          ...source,
          missing: false,
          actual_power_kw: 0,
          load_ratio: 0,
        }),
        unavailable: cardHTML({
          ...source,
          missing: false,
          inferred_outage: false,
          machine_data_available: true,
          machine_count: Math.max(1, Number(source.machine_count) || 1),
          actual_power_kw: null,
          load_ratio: null,
        }),
      };
    });
    assert(cardStates, "card state fixtures unavailable");
    assert(cardStates.missing.includes("暂无上报数据"));
    assert(cardStates.missing.includes("不代表矿箱实际功率为 0 kW"));
    assert(cardStates.outage.includes("停电推断"));
    assert(cardStates.outage.includes("实际功率按 0 kW 展示"));
    assert(cardStates.outage.includes("本小时无明细"));
    assert(!cardStates.outage.includes("暂无上报数据"));
    assert(cardStates.zero.includes("实际功率为 0 kW"));
    assert(!cardStates.zero.includes("暂无上报数据"));
    assert(!cardStates.zero.includes("矿箱小时实际功率缺失"));
    assert(cardStates.unavailable.includes(
      "本小时有矿机上报记录，但矿机小时汇总功率缺失"
    ));
    assert(!cardStates.unavailable.includes("暂无上报数据"));
    assert.equal(await page.locator(
      ".warehouse-card .card-distributions",
    ).count(), 0);
    assert(await page.locator(
      ".warehouse-card [data-distribution-id]:not([disabled])",
    ).count() > 0);
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
    const warehouseActualMargin = row => {
      const theory = Number(row.theoretical_power_kw);
      const actual = row.actual_power_kw == null
        ? null : Number(row.actual_power_kw);
      return Number.isFinite(theory) && Number.isFinite(actual)
        ? theory - actual : null;
    };
    const sortedRows = (key, direction = "asc") => [...selectedRows.values()]
      .filter(row => !row.missing)
      .sort((a, b) => {
        const valueOf = row =>
          typeof key === "function" ? key(row) : row[key];
        const aValue = valueOf(a);
        const bValue = valueOf(b);
        const aMissing = !Number.isFinite(aValue);
        const bMissing = !Number.isFinite(bValue);
        if (aMissing !== bMissing) return aMissing ? 1 : -1;
        if (aMissing) {
          return a.warehouse_name.localeCompare(b.warehouse_name, undefined, {
            numeric: true,
          });
        }
        const difference = Number(aValue) - Number(bValue);
        return ((direction === "asc" ? difference : -difference)
          || a.warehouse_name.localeCompare(b.warehouse_name, undefined, {
            numeric: true,
          }));
      })
      .map(row => row.warehouse_id);
    assert.deepEqual(await cardIds(), sortedRows("actual_power_kw"));
    await page.locator("#sort").selectOption("available");
    assert.deepEqual(await cardIds(), sortedRows(warehouseActualMargin));
    await page.locator('input[name="sort-order"][value="desc"]').check({
      force: true,
    });
    assert.equal(await page.locator(
      'input[name="sort-order"]:checked',
    ).inputValue(), "desc");
    assert.deepEqual(
      await cardIds(),
      sortedRows(warehouseActualMargin, "desc"),
    );
    await page.locator("#sort").selectOption("name");
    assert.deepEqual(await cardIds(), [...selectedRows.values()]
      .filter(row => !row.missing)
      .sort((a, b) =>
        b.warehouse_name.localeCompare(a.warehouse_name, undefined, {
          numeric: true,
        })
      )
      .map(row => row.warehouse_id));
    await page.locator('input[name="sort-order"][value="asc"]').check({
      force: true,
    });
    assert.deepEqual(await cardIds(), [...selectedRows.values()]
      .filter(row => !row.missing)
      .sort((a, b) =>
        a.warehouse_name.localeCompare(b.warehouse_name, undefined, {
          numeric: true,
        })
      )
      .map(row => row.warehouse_id));
    await page.locator("#sort").selectOption("power");
    const distributionButton = page.locator(
      ".warehouse-card [data-distribution-id]:not([disabled])",
    ).first();
    const distributionId = await distributionButton
      .getAttribute("data-distribution-id");
    const distributionSource = selectedRows.get(distributionId);
    assert(distributionSource, `distribution source missing for ${distributionId}`);
    await distributionButton.click();
    assert(await page.locator("#distribution").evaluate(dialog => dialog.open));
    assert((await page.locator("#distribution-title").textContent()).includes(
      distributionSource.warehouse_name
    ));
    assert((await page.locator("#distribution-meta").textContent()).includes(
      "WhiteOak01"
    ));
    assert.equal(await page.locator(
      "#distribution-summary > div",
    ).count(), 3);
    assert.equal(await page.locator(
      "#distribution-charts .distribution-chart",
    ).count(), 2);
    const distributionTotals = Object.fromEntries(
      await page.locator("#distribution-charts .distribution-chart").evaluateAll(
        charts => charts.map(chart => [
          chart.dataset.distribution,
          Number(chart.dataset.total || 0),
        ]),
      ),
    );
    assert.equal(
      distributionTotals.template_name,
      sum(distributionSource.templates || [], "machine_count"),
    );
    assert.equal(
      distributionTotals.work_mode,
      sum(distributionSource.work_modes || [], "machine_count"),
    );
    await page.locator("#distribution-close").click();
    assert(!(await page.locator("#distribution").evaluate(dialog => dialog.open)));
    await distributionButton.click();
    await page.locator("#distribution-detail").click();
    assert(!(await page.locator("#distribution").evaluate(dialog => dialog.open)));
    await page.waitForSelector("#detail-content tbody tr");
    assert(await page.locator("#detail").evaluate(dialog => dialog.open));
    await page.locator("#close").click();
    assert.equal(await page.locator(".warehouse-card .card-glance").count(),
      boxesWithData);
    assert.equal(await page.locator(".warehouse-card .power-comparison").count(),
      await page.locator(".warehouse-card .power-reference").count());
    assert.equal(await page.locator(".warehouse-card .machine-power-metrics")
      .count(), whiteoak.warehouse_count);
    assert.equal(await page.locator(".warehouse-card .machine-power-metric")
      .count(), whiteoak.warehouse_count * 3);
    assert(await page.locator(".warehouse-card .meter-power-scale").count() > 0);
    const meterTimeText = await page.locator(
      ".warehouse-card .meter-power-time",
    ).first().textContent();
    assert(meterTimeText.includes("UTC+0"));
    const meterPanelText = await page.locator(
      ".warehouse-card .meter-power-panel",
    ).first().textContent();
    assert(meterPanelText.includes("采样时间"));
    assert(!meterPanelText.includes("数据小时"));
    const machinePowerTimeText = await page.locator(
      ".warehouse-card .power-time",
    ).first().textContent();
    assert(machinePowerTimeText.includes("采样时间"));
    assert(machinePowerTimeText.includes("UTC+0"));
    assert(!machinePowerTimeText.includes("数据小时"));
    assert((await page.locator("[data-metric='meter'] .overview-label")
      .textContent()).includes("UTC+0"));
    const meterTrendButton = page.locator(".warehouse-card .meter-trend-button")
      .first();
    assert(await meterTrendButton.isVisible());
    const meterTrendWarehouseId = await meterTrendButton.getAttribute(
      "data-meter-trend-id",
    );
    const meterRequestsBefore = requests.length;
    await meterTrendButton.click();
    await page.waitForSelector("#meter-trend[open]");
    await page.waitForFunction(() => meterTrendState?.hours?.length > 0);
    const meterRequests = requests.slice(meterRequestsBefore);
    assert(meterRequests.some(url =>
      url.includes(
        `/data/days/${whiteoak.data_center_id}-${catalog.latest_date.replaceAll("-", "")}.json.gz`,
      )
    ), "电表趋势应读取所选场地和日期对应的日压缩包");
    assert(!meterRequests.some(url => url.includes("supabase_power.json")));
    assert.equal(
      await page.evaluate(() => meterTrendState.warehouseId),
      meterTrendWarehouseId,
    );
    assert.equal(
      await page.locator("#meter-trend .meter-trend-stat").count(),
      3,
    );
    assert((await page.locator("#meter-trend-meta").textContent())
      .includes("UTC+0"));
    assert((await page.locator("#meter-trend-summary").textContent())
      .includes("当日电表平均功率"));
    assert((await page.locator("#meter-trend-summary").textContent())
      .includes("当日电表最大功率"));
    assert(!(await page.locator("#meter-trend-summary").textContent())
      .includes("矿箱理论功率"));
    assert((await page.locator("#meter-trend-summary").textContent())
      .includes("矿箱小时实际功率"));
    assert(!(await page.locator("#meter-trend-summary").textContent())
      .includes("Lark-OM表在架功率"));
    assert(await page.locator("#meter-trend .meter-trend-line").count() > 0);
    assert(await page.locator("#meter-trend .meter-trend-line.actual")
      .count() > 0);
    assert.equal(
      await page.locator("#meter-trend .meter-trend-reference.theory").count(),
      0,
    );
    assert.equal(
      await page.locator("#meter-trend .meter-trend-selected-line").count(),
      0,
    );
    assert.equal(
      await page.locator("#meter-trend .meter-trend-selected-point").count(),
      0,
    );
    assert(await page.locator("#meter-trend-tooltip")
      .evaluate(element => element.hidden));
    const firstValidMeterHour = await page.locator(
      "#meter-trend .meter-trend-hit",
    ).evaluateAll(elements =>
      elements.find(element =>
        meterTrendState.hours[Number(element.dataset.meterTrendHour)]
      )?.dataset.meterTrendHour || null
    );
    assert(firstValidMeterHour != null);
    await page.locator(
      `#meter-trend [data-meter-trend-hour="${firstValidMeterHour}"]`,
    ).hover();
    assert.equal(
      await page.locator("#meter-trend .meter-trend-selected-line").count(),
      1,
    );
    assert.equal(
      await page.locator("#meter-trend .meter-trend-selected-point").count(),
      1,
    );
    assert(!(await page.locator("#meter-trend-tooltip")
      .evaluate(element => element.hidden)));
    assert(await page.evaluate(() => {
      const tooltip = document.querySelector("#meter-trend-tooltip")
        .getBoundingClientRect();
      const chart = document.querySelector(".meter-trend-chart-wrap")
        .getBoundingClientRect();
      return tooltip.left >= chart.left
        && tooltip.right <= chart.right + 1
        && tooltip.top >= chart.top
        && tooltip.bottom <= chart.bottom + 1;
    }), "电表趋势数值框必须完整显示在图表区域内");
    const initialMeterTooltip = await page.locator("#meter-trend-tooltip")
      .textContent();
    assert(initialMeterTooltip.includes("采样时间"));
    assert(initialMeterTooltip.includes("电表小时实测功率"));
    assert(initialMeterTooltip.includes("矿箱小时实际功率"));
    assert(!initialMeterTooltip.includes("Lark-OM表在架功率"));
    assert(!initialMeterTooltip.includes("矿箱理论功率"));
    const alternateMeterHour = await page.locator(
      "#meter-trend .meter-trend-hit",
    ).evaluateAll(elements => {
      const alternate = elements.find(element =>
        Number(element.dataset.meterTrendHour) !== meterTrendState.hoveredHourIndex
        && meterTrendState.hours[Number(element.dataset.meterTrendHour)]
      );
      return alternate?.dataset.meterTrendHour || null;
    });
    assert(alternateMeterHour != null);
    await page.locator(
      `#meter-trend [data-meter-trend-hour="${alternateMeterHour}"]`,
    ).click();
    assert.notEqual(
      await page.locator("#meter-trend-tooltip").textContent(),
      initialMeterTooltip,
    );
    assert.equal(
      await page.evaluate(() => meterTrendState.hoveredHourIndex),
      Number(alternateMeterHour),
    );
    await page.mouse.move(4, 4);
    assert(await page.locator("#meter-trend-tooltip")
      .evaluate(element => element.hidden));
    assert.equal(
      await page.locator("#meter-trend .meter-trend-selected-line").count(),
      0,
    );
    await page.screenshot({
      path: path.join(
        ROOT, "outputs", "dashboard-check", "meter-trend-dialog.png",
      ),
      fullPage: false,
    });
    await page.locator("#meter-trend-close").click();
    assert(!(await page.locator("#meter-trend").evaluate(dialog => dialog.open)));
    const meterScaleText = await page.locator(
      ".warehouse-card .meter-power-scale",
    ).first().textContent();
    assert(meterScaleText.includes("% 理论功率"));
    assert(meterScaleText.includes("100%"));
    assert(meterScaleText.includes("kW"));
    const meterScaleRatios = await page.locator(
      ".warehouse-card .meter-power-scale",
    ).evaluateAll(scales => scales.map(scale => {
      const track = scale.querySelector(".meter-power-track");
      const ratio = Number(track?.dataset.meterLoadRatio);
      const fillPercent = Number(
        track?.querySelector("i")?.style.width.replace("%", ""),
      );
      const labelRatio = Number(
        scale.querySelector(".meter-power-scale-labels > strong")
          ?.textContent.match(/([\d,.]+)%/)?.[1].replaceAll(",", ""),
      );
      return { ratio, fillPercent, labelRatio };
    }));
    assert(meterScaleRatios.some(item => item.ratio > 100));
    assert(meterScaleRatios.every(item =>
      Number.isFinite(item.ratio)
      && Number.isFinite(item.labelRatio)
      && Math.abs(item.ratio - item.labelRatio) < 0.1
    ), "电表刻度必须显示实测功率/理论功率，不能封顶为 100%");
    assert(meterScaleRatios.every(item =>
      Number.isFinite(item.fillPercent)
      && Math.abs(item.fillPercent - Math.min(item.ratio, 100)) < 0.1
    ), "电表刻度条在达到或超过理论功率时必须填满");
    assert(meterScaleRatios.some(item =>
      item.ratio > 100 && item.fillPercent === 100
    ), "超过矿箱理论功率时，电表刻度条必须填满并保留真实超限比例");
    assert.equal(await page.locator(".peak-strip").count(), 0);
    assert((await page.locator("#metrics").textContent()).includes(
      "Lark-OM表在架功率"
    ));
    assert.equal(await page.locator("#trend .chart-hit").count(), 7);
    assert.equal(await page.locator("#trend .chart-selection").count(), 1);
    const latestRatio = Number(
      whiteoak.daily_summary.find(item => item.date === catalog.latest_date)
        ?.power_ratio_overall_w_per_th
    );
    assert(Number.isFinite(latestRatio));
    const ratioSummary = await page.locator(
      "#trend-summary .trend-stat .trend-stat-value"
    ).first().textContent();
    assert.equal(ratioSummary.trim(), latestRatio.toFixed(2));
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
      whiteoak.warehouse_count);
    await page.locator("[data-trend-metric='power']").click();
    assert((await page.locator("#trend-title").textContent()).includes(
      "矿箱功率 · 近 7 天日均"
    ));
    assert((await page.locator("#chart-note").textContent()).includes(
      "当日有效小时平均"
    ));
    assert(!(await page.locator("#trend-title").textContent()).includes(
      "占理论功率比例"
    ));
    assert.equal(await page.locator("#trend .chart-line.actual").count(), 1);
    assert.equal(await page.locator("#trend .chart-line.meter").count(), 1);
    assert.equal(await page.locator("#trend .chart-line.peak").count(), 1);
    assert.equal(await page.locator("#trend .chart-current").count(), 3);
    assert.equal(await page.locator("#trend title").count(), 0);
    assert.equal(await page.locator("#trend .chart-line.theory").count(), 0);
    assert.equal(await page.locator("#trend .chart-line.mounted").count(), 0);
    assert.equal(await page.evaluate(() =>
      trendState.definitions.some(item => item.key === "actual")
    ), true);
    assert.equal(await page.evaluate(() =>
      trendState.definitions.some(item => item.key === "mounted")
    ), false);
    assert.equal(await page.locator("#trend-summary .trend-stat").count(), 3);
    assert.equal(await page.locator("#trend-summary .trend-legend").count(), 0);
    const latestPowerDaily = whiteoak.daily_summary.find(item =>
      item.date === catalog.latest_date
    );
    assert(
      (await page.locator("#trend-summary").textContent())
        .includes("当日电表平均功率")
    );
    assert(
      (await page.locator("#trend-summary").textContent())
        .includes("当日电表最大功率")
    );
    assert.equal(
      (await page.locator(
        "#trend-summary .trend-stat .trend-stat-value"
      ).first().textContent()).trim(),
      (latestPowerDaily.meter_hour_sum_kw
        / latestPowerDaily.meter_hours_with_data)
        .toLocaleString("zh-CN", { maximumFractionDigits: 1 }),
    );
    assert.equal(
      (await page.locator(
        "#trend-summary .trend-stat .trend-stat-value"
      ).nth(1).textContent()).trim(),
      latestPowerDaily.meter_hour_peak_kw
        .toLocaleString("zh-CN", { maximumFractionDigits: 1 }),
    );
    assert.equal(
      (await page.locator(
        "#trend-summary .trend-stat .trend-stat-value"
      ).nth(2).textContent()).trim(),
      (latestPowerDaily.actual_power_kw
        / latestPowerDaily.hours_with_data)
        .toLocaleString("zh-CN", { maximumFractionDigits: 1 }),
    );
    assert(
      (await page.locator("#trend-summary").textContent())
        .includes("当日矿箱平均功率")
    );
    assert(
      !(await page.locator("#trend-summary").textContent())
        .includes("Lark-OM表在架功率")
    );
    assert((await page.locator("#chart-note").textContent()).includes("kW"));
    assert(!(await page.locator("#chart-note").textContent()).includes("%"));
    assert(await page.evaluate(() => trendState.minValue > 0));
    const powerAxisLabels = await page.locator("#trend .chart-axis")
      .allTextContents();
    assert(powerAxisLabels.length > 0);
    assert(powerAxisLabels.every(label => label.includes("kW")));
    assert(powerAxisLabels.every(label => !label.includes("%")));
    const powerChartValues = await page.evaluate(() => {
      const meter = trendState.definitions.find(item => item.key === "meter");
      return trendState.series
        .map(item => chartNumber(meter, item))
        .filter(value => value != null);
    });
    assert(powerChartValues.length > 0);
    assert(powerChartValues.every(value =>
      value > 1000 && value < 100000
    ));
    await page.locator("#trend .chart-hit").last().hover();
    assert.equal(
      await page.locator("#chart-tooltip").evaluate(element => element.hidden),
      false,
    );
    const hoveredMarkerClasses = await page.locator(
      "#trend .chart-hit-group",
    ).last().locator(".chart-point").evaluateAll(points => points
      .map(point => ["meter", "actual", "peak"]
        .find(name => point.classList.contains(name)))
      .sort());
    assert.deepEqual(hoveredMarkerClasses, ["actual", "meter", "peak"]);
    assert((await page.locator("#trend .chart-hit-group").last()
      .locator(".chart-point").evaluateAll(points => points.map(
        point => getComputedStyle(point).opacity
      ))).every(opacity => opacity === "1"));
    const powerTooltipText = await page.locator("#chart-tooltip").textContent();
    assert(powerTooltipText.includes("kW"));
    assert(powerTooltipText.includes("当日电表平均功率"));
    assert(powerTooltipText.includes("当日矿箱平均功率"));
    const meterLineAppearance = await page.locator(".chart-line.meter").first().evaluate(line => {
      const style = getComputedStyle(line);
      return {
        stroke: style.stroke,
        strokeWidth: Number.parseFloat(style.strokeWidth),
      };
    });
    const actualLineAppearance = await page.locator(".chart-line.actual").first().evaluate(line => {
      const style = getComputedStyle(line);
      return {
        stroke: style.stroke,
        strokeWidth: Number.parseFloat(style.strokeWidth),
      };
    });
    assert.notStrictEqual(meterLineAppearance.stroke, "none");
    assert(meterLineAppearance.strokeWidth > 0);
    assert.notStrictEqual(
      meterLineAppearance.stroke,
      actualLineAppearance.stroke,
      "电表平均功率与矿箱平均功率必须使用不同颜色",
    );
    assert(!powerTooltipText.includes("矿箱理论功率"));
    assert(!powerTooltipText.includes("Lark-OM表在架功率"));
    assert(powerTooltipText.includes("当日电表最大功率"));
    assert(powerTooltipText.includes("峰值小时"));
    assert.equal(
      await page.locator("#chart-tooltip > strong").count(),
      0,
    );
    assert.equal(
      await page.locator("#chart-tooltip .tooltip-series > span").count(),
      3,
    );
    const powerTooltipStyles = await page.locator(
      "#chart-tooltip .tooltip-series b",
    ).evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element);
      return `${style.fontSize}/${style.fontWeight}/${style.color}`;
    }));
    assert.equal(
      new Set(powerTooltipStyles).size,
      1,
      "三个功率值必须使用相同字号、字重和颜色",
    );
    assert(!powerTooltipText.includes("%"));
    assert(!powerTooltipText.includes("实际功率"));
    assert(!powerTooltipText.includes("Lark-OM表在架数据使用"));
    await page.mouse.move(2, 2);
    assert.equal(
      await page.locator("#chart-tooltip").evaluate(element => element.hidden),
      true,
    );
    const dailyTheoryPowers = await page.evaluate(() =>
      dailySeries().map(item => item.theoreticalPower)
    );
    assert(dailyTheoryPowers.every(Number.isFinite));
    assert.equal(new Set(dailyTheoryPowers).size, 1);
    assert(Number.isInteger(dailyTheoryPowers[0]));
    const hourlyTheoryPowers = await page.evaluate(() =>
      hourlySeries().map(item => item.theoreticalPower).filter(Number.isFinite)
    );
    assert.equal(new Set(hourlyTheoryPowers).size, 1);
    assert.equal(hourlyTheoryPowers[0], dailyTheoryPowers[0]);
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
      `完整 ${latestDaily.complete_warehouse_count}/${latestDaily.warehouse_count} 箱`
    ));
    assert.equal(await page.locator("#coverage").getAttribute("data-complete"),
      String(latestDaily.is_fully_complete));
    assert((await page.locator("#coverage").textContent()).includes(
      `场地 ${latestDaily.hours_with_data}/${latestDaily.expected_hours} 小时有数据`
    ));
    assert.equal(
      (await page.locator(".coverage-ratio").innerText())
        .replace(/\s+/g, " ").trim(),
      `完整矿箱 ${latestDaily.complete_warehouse_count}/${latestDaily.warehouse_count}`,
    );
    const expectedCoverageWarnings = latestDaily.incomplete_warehouse_count
      + latestDaily.warehouses_without_data;
    assert.equal(await page.locator(".card-coverage.incomplete").count(),
      expectedCoverageWarnings);
    await page.locator("[data-open-coverage]").click();
    const coverageDialog = page.locator("#coverage-dialog");
    assert(await coverageDialog.isVisible());
    assert((await page.locator("#coverage-dialog-meta").textContent()).includes(
      `完整矿箱 ${latestDaily.complete_warehouse_count}/${latestDaily.warehouse_count}`
    ));
    assert.equal(
      await coverageDialog.locator(
        ".coverage-warehouse-item[data-state='partial']",
      ).count(),
      latestDaily.incomplete_warehouse_count,
    );
    assert.equal(
      await coverageDialog.locator(
        ".coverage-warehouse-item[data-state='empty']",
      ).count(),
      latestDaily.warehouses_without_data,
    );
    if (latestDaily.warehouses_without_data) {
      const emptyWarehouse = coverageDialog.locator(
        ".coverage-warehouse-item[data-state='empty']",
      ).first();
      assert((await emptyWarehouse.textContent()).includes(
        `0/${latestDaily.expected_hours} 小时`
      ));
      assert((await emptyWarehouse.textContent()).includes("当日无数据"));
      assert.equal(
        await emptyWarehouse.locator(".coverage-missing-range").count(),
        1,
      );
    }
    await page.screenshot({
      path: path.join(
        ROOT, "outputs", "dashboard-check", "coverage-dialog.png",
      ),
      clip: { x: 0, y: 0, width: 1440, height: 1000 },
    });
    await page.locator("#coverage-dialog-close").click();
    assert(!(await coverageDialog.isVisible()));

    await page.locator("[data-trend-mode='hourly']").click();
    assert((await page.locator("#trend-title").textContent()).includes(
      "当日逐小时"
    ));
    assert.equal(await page.locator("#trend .chart-hit").count(), 24);
    assert.equal(
      await page.locator("#trend .chart-missing-band").count(),
      24 - latestDaily.hours_with_data,
    );
    assert((await page.locator("#trend-summary").textContent()).includes("当前小时"));
    assert((await page.locator("#chart-note").textContent()).includes("灰色带"));
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
    const firstDateHasDetail = catalog.detail_dates.includes(firstDate);
    assert.equal(await page.locator(
      ".warehouse-card .card-head button:not([disabled])",
    ).count(), firstDateHasDetail
      ? await page.locator(
        ".warehouse-card .card-head button[data-detail-id]",
      ).count()
      : 0);
    assert(await page.locator(
      ".warehouse-card [data-distribution-id]:not([disabled])",
    ).count() > 0);
    await page.locator(
      ".warehouse-card [data-distribution-id]:not([disabled])",
    ).first().click();
    assert.equal(
      await page.locator("#distribution-detail").isDisabled(),
      !firstDateHasDetail,
    );
    await page.locator("#distribution-close").click();
    if (firstDateHasDetail) {
      assert((await page.locator("#detail-note").textContent())
        .includes("当前日期支持下钻"));
      await page.locator(".warehouse-card [data-detail-id]").first().click();
      await page.waitForSelector("#detail-content tbody tr");
      assert(await page.locator("#detail").evaluate(dialog => dialog.open));
      await page.locator("#close").click();
    } else {
      assert((await page.locator("#detail-note").textContent())
        .includes("单机明细需当日导出"));
    }
    const firstDateHasLark = larkSnapshotDatesInRange.has(firstDate);
    if (firstDateHasLark) {
      assert(await page.locator(".warehouse-card .capacity-row").count() > 0);
      assert.equal(await page.locator(
        ".warehouse-card .lark-power-panel.snapshot-missing"
      ).count(), 0);
    }
    else {
      assert.equal(await page.locator(
        ".warehouse-card .capacity-row"
      ).count(), 0);
      assert.equal(await page.locator(
        ".warehouse-card .lark-power-panel.snapshot-missing"
      ).count(), await page.locator(
        ".warehouse-card:not(.missing-card)"
      ).count());
    }

    const noSnapshotDate = whiteoak.available_dates.find(date =>
      !larkSnapshotDatesInRange.has(date)
    );
    assert(noSnapshotDate, "expected at least one date without a Lark snapshot");
    await page.selectOption("#date", noSnapshotDate);
    await page.waitForFunction(date =>
      document.querySelector("#meta")?.textContent.includes(`当前 ${date}`),
      noSnapshotDate);
    assert.equal(await page.locator(".warehouse-card .capacity-row").count(), 0);
    assert.equal(await page.locator(
      ".warehouse-card .lark-power-panel.snapshot-missing"
    ).count(), await page.locator(".warehouse-card:not(.missing-card)").count());
    assert((await page.locator("#coverage").textContent()).includes(
      "没有 Lark-OM表功率快照"
    ));

    const latestDate = whiteoak.available_dates.at(-1);
    await page.selectOption("#date", latestDate);
    await page.waitForFunction(date =>
      document.querySelector("#meta")?.textContent.includes(`当前 ${date}`),
      latestDate);
    await page.waitForSelector(".warehouse-card [data-detail-id]");
    const primaryDetailButton = page.locator(
      ".warehouse-card [data-detail-id]",
    ).first();
    assert(await primaryDetailButton.isEnabled());
    const primaryDetailId = await primaryDetailButton.getAttribute(
      "data-detail-id",
    );
    const primaryDetail = readDetailBundle(
      whiteoak.data_center_id, latestDate, primaryDetailId,
    );
    const expectedMachineStats = expectedMachinePowerStats(
      Object.values(primaryDetail.hours)
        .flatMap(detail => detail.machine_rows || []),
    ).get(primaryDetailId);
    assert(expectedMachineStats,
      "missing expected machine power stats for detail test");
    assert.equal(await page.locator(".peak-actions").count(), 0);
    assert.equal(await page.locator(".peak-hour-action").count(), 0);
    assert.equal(await page.locator(".peak-machine-action").count(), 0);
    assert.equal(await page.locator(".peak-machine-callout").count(), 0);
    await primaryDetailButton.click();
    await page.waitForSelector("#detail-content tbody tr");
    assert(await page.locator("#detail").evaluate(dialog => dialog.open));
    assert((await page.locator("#detail-title").textContent()).includes(
      "矿箱详情"
    ));
    assert.equal(
      await page.locator('[data-level="template_rows"]')
        .getAttribute("aria-selected"),
      "true",
    );
    const detailMetaText = await page.locator("#detail-meta").textContent();
    assert(detailMetaText.includes("WhiteOak01"));
    assert(detailMetaText.includes("UTC+0"));
    assert.equal(
      await page.locator(
        '.detail-metric-group[data-detail-group="warehouse"] .metric',
      ).count(),
      7,
    );
    assert.equal(
      await page.locator(
        '.detail-metric-group[data-detail-group="machine"] .metric',
      ).count(),
      4,
    );
    assert.equal(await page.locator("#detail-metrics .metric").count(), 11);
    const detailMetricsText = await page.locator("#detail-metrics").textContent();
    assert(detailMetricsText.includes("矿箱层面指标"));
    assert(detailMetricsText.includes("矿机层面指标"));
    assert(detailMetricsText.includes("单机理论平均功率"));
    assert(detailMetricsText.includes("矿箱理论功率 1,000 kW"));
    assert(detailMetricsText.includes("矿箱小时实际功率"));
    const capacityNotes = await page.locator(
      "#detail-capacity .capacity-row .capacity-note",
    ).allTextContents();
    assert.equal(capacityNotes.length, 2);
    assert(capacityNotes[0].includes("在架"));
    assert(capacityNotes[1].includes("占位"));
    assert(!capacityNotes.join(" ").includes("单机理论平均"));
    await page.locator("#close").click();

    await primaryDetailButton.click();
    await page.waitForSelector("#detail-content tbody tr");
    assert(await page.locator("#detail").evaluate(dialog => dialog.open));
    await Promise.all([
      page.waitForResponse(response =>
        response.url().includes(".machines.json.gz") && response.ok()
      ),
      page.locator('[data-level="machine_rows"]').click(),
    ]);
    await page.waitForSelector(".machine-peak-card");
    assert.equal(await page.locator(".machine-peak-card").count(), 2);
    const hourPeakCardText = await page.locator(
      '.machine-peak-card[data-machine-peak-card="hour-peak"]',
    ).textContent();
    const dailyPeakCardText = await page.locator(
      '.machine-peak-card[data-machine-peak-card="daily-average-peak"]',
    ).textContent();
    assert(hourPeakCardText.includes("当日单机小时峰值功率矿机"));
    assert(hourPeakCardText.includes(expectedMachineStats.machine_hour_peak_ip));
    assert(dailyPeakCardText.includes("矿箱内矿机当日平均功率峰值矿机"));
    assert(dailyPeakCardText.includes(
      expectedMachineStats.machine_daily_avg_peak_ip,
    ));
    assert(dailyPeakCardText.includes("最高功率小时"));
    assert(dailyPeakCardText.includes(
      `按有效 ${expectedMachineStats.machine_daily_avg_peak_valid_hours} 小时平均`,
    ));
    await page.screenshot({
      path: path.join(ROOT, "outputs", "dashboard-check", "peak-machine.png"),
      fullPage: true,
    });
    await page.locator("#close").click();

    const detailRequestsBefore = requests.length;
    const detailButton = page.locator(
      `.warehouse-card .card-head button[data-detail-id]:not([data-detail-id="${primaryDetailId}"])`,
    ).first();
    const openedDetailId = await detailButton.getAttribute("data-detail-id");
    await detailButton.click();
    await page.waitForSelector("#detail-content tbody tr");
    const detailRequest = requests.slice(detailRequestsBefore)
      .find(url => url.includes("/data/details/"));
    assert(detailRequest, "detail request not found");
    assert(detailRequest.includes(".summary.json.gz"));
    assert(!detailRequest.includes(".machines.json.gz"));
    assert(!requests.slice(detailRequestsBefore)
      .some(url => url.includes(".machines.json.gz")));
    assert((await page.locator("#detail-meta").textContent()).includes("WhiteOak01"));
    assert.equal(await page.locator("#detail-capacity .capacity-row").count(), 2);
    const openedHour = Number(await page.locator("#hour").inputValue());
    const openedDetail = readDetailBundle(
      whiteoak.data_center_id, latestDate, openedDetailId,
    );
    const openedHourDetail = openedDetail.hours[String(openedHour)];
    await page.locator('[data-level="model_rows"]').click();
    const modelHeaders = await page.locator("#detail-content th").allTextContents();
    assert.deepEqual(modelHeaders, [
      "型号", "矿机数",
      "本型号单机小时平均算力 TH/s", "本型号单机小时平均功耗 W",
      "本型号矿机样本整体功耗比 W/TH",
      "本型号单机小时平均拒绝率", "本型号单机小时平均温度 °C",
    ]);
    assert(!modelHeaders.includes("算力组"));
    assert.equal(
      await page.locator("#detail-content tbody tr").count(),
      new Set(openedHourDetail.model_rows.map(row => row.model)).size,
    );
    await page.locator('[data-level="work_mode_rows"]').click();
    const workModeHeaders = await page.locator("#detail-content th").allTextContents();
    assert.deepEqual(workModeHeaders, [
      "型号", "档位", "矿机数",
      "本档位单机小时平均算力 TH/s", "本档位单机小时平均功耗 W",
      "本档位矿机样本整体功耗比 W/TH",
      "本档位单机小时平均拒绝率", "本档位单机小时平均温度 °C",
    ]);
    assert(!workModeHeaders.includes("算力组"));
    assert.equal(
      await page.locator("#detail-content tbody tr").count(),
      new Set(openedHourDetail.work_mode_rows.map(row =>
        `${row.model}\u001f${row.work_mode}`
      )).size,
    );
    const machineRequestsBefore = requests.length;
    await Promise.all([
      page.waitForResponse(response =>
        response.url().includes(".machines.json.gz") && response.ok()
      ),
      page.locator('[data-level="machine_rows"]').click(),
    ]);
    await page.waitForSelector("#detail-content tbody tr");
    assert(requests.slice(machineRequestsBefore)
      .some(url => url.includes(".machines.json.gz")));
    const openedMachines = openedHourDetail.machine_rows;
    const unitLimit = EXPECTED_UNIT_POWER_LIMITS.WhiteOak01;
    const expectedPowerCounts = {
      all: openedMachines.length,
      over100: openedMachines.filter(machine =>
        Number(machine.avg_power_w) > unitLimit
      ).length,
      range95to100: openedMachines.filter(machine =>
        Number(machine.avg_power_w) >= unitLimit * 0.95
        && Number(machine.avg_power_w) <= unitLimit
      ).length,
      below95: openedMachines.filter(machine =>
        Number.isFinite(Number(machine.avg_power_w))
        && Number(machine.avg_power_w) < unitLimit * 0.95
      ).length,
    };
    assert((await page.locator(".power-limit-heading").textContent())
      .replaceAll(",", "").includes(`${unitLimit}`));
    const powerFilterCount = async key => Number(
      (await page.locator(
        `[data-power-limit="${key}"] strong`,
      ).textContent()).replace(/[^\d]/g, "")
    );
    for (const [key, expected] of Object.entries(expectedPowerCounts)) {
      assert.equal(await powerFilterCount(key), expected);
    }
    assert.equal(
      expectedPowerCounts.over100
        + expectedPowerCounts.range95to100
        + expectedPowerCounts.below95,
      openedMachines.filter(machine =>
        Number.isFinite(Number(machine.avg_power_w))
      ).length,
      "power-limit groups must be mutually exclusive and exhaustive",
    );
    assert.deepEqual(
      await page.locator("#detail-content th").allTextContents(),
      [
        "型号", "档位", "IP",
        "单机小时平均算力 TH/s", "单机小时平均功耗 W",
        "单机功耗上限 W", "占单机功耗上限", "超单机功耗上限 W",
        "单机功耗比 W/TH", "单机拒绝率", "单机温度 °C",
      ],
    );
    const ratioLabels = await page.locator(
      "#detail-content tbody tr td:nth-child(7)",
    ).allTextContents();
    assert(
      ratioLabels.every(value =>
        value.trim() === "—" || /^\d[\d,]*\.\d{2}%$/.test(value.trim())),
      "power limit ratios should show two decimals",
    );
    for (const key of ["over100", "range95to100", "below95"]) {
      await page.locator(`[data-power-limit="${key}"]`).click();
      assert.equal(
        await page.locator("#detail-content tbody tr").count(),
        expectedPowerCounts[key],
      );
    }
    await page.locator('[data-power-limit="all"]').click();
    assert.equal(
      await page.locator("#detail-content tbody tr").count(),
      expectedPowerCounts.all,
    );
    await page.locator("#close").click();
    await page.screenshot({
      path: path.join(ROOT, "outputs", "dashboard-check", "desktop.png"),
      fullPage: true,
    });

    const outageDate = catalog.latest_date;
    const outageHour = Number(`${outageDate.replaceAll("-", "")}00`);
    await page.selectOption("#date", outageDate);
    await page.waitForFunction(date =>
      document.querySelector("#meta")?.textContent.includes(`当前 ${date}`),
    outageDate);
    await page.selectOption("#hour", String(outageHour));
    await page.waitForFunction(hour =>
      document.querySelector("#metrics")?.textContent.includes(
        `当前小时 ${String(hour).slice(-2)}:00`,
      ),
    outageHour);
    assert.equal(
      await page.locator(".warehouse-card.inferred-outage-card").count(),
      0,
    );
    await page.screenshot({
      path: path.join(
        ROOT, "outputs", "dashboard-check", "outage-inference-desktop.png",
      ),
      fullPage: true,
    });
    const meterOnlyNames = await page.locator(
      ".warehouse-card.meter-only-card .card-title strong",
    ).allTextContents();
    assert.deepEqual(meterOnlyNames.sort(), ["C12"]);
    for (const warehouseName of ["C12"]) {
      const card = page.locator(".warehouse-card.meter-only-card").filter({
        hasText: warehouseName,
      });
      const text = await card.textContent();
      assert(text.includes("矿机小时数据缺失"));
      assert(text.includes("0/24 小时"));
      assert(!text.includes("停电推断"));
    }

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
    const nimrodWarehouses = catalog.warehouses.filter(warehouse =>
      warehouse.data_center_name === "Nimrod01"
    );
    const nimrodMissingWarehouses = nimrodWarehouses.filter(warehouse =>
      !nimrodActiveIds.has(warehouse.warehouse_id)
    );
    assert.equal(nimrodWarehouses.length, 18);
    assert.deepEqual(
      nimrodMissingWarehouses.map(warehouse => warehouse.warehouse_name).sort(),
      ["C03", "C15"],
    );
    assert.equal(await page.locator(".warehouse-card").count(),
      nimrod.warehouse_count);
    assert.equal(await page.locator(".warehouse-card.missing-card").count(), 2);
    for (const warehouse of nimrodMissingWarehouses) {
      const card = page.locator(
        `[data-warehouse-id="${warehouse.warehouse_id}"]`,
      );
      assert.equal(await card.count(), 1);
      assert((await card.textContent()).includes("本小时矿箱数据缺失"));
      assert((await card.textContent()).includes("不代表矿箱实际功率为 0 kW"));
      assert.equal(await card.locator(".card-coverage").count(), 1);
      assert((await card.locator(".card-coverage").textContent()).includes(
        "0/24 小时"
      ));
    }
    const nimrodDaily = nimrod.daily_summary.find(item =>
      item.date === catalog.latest_date
    );
    assert((await page.locator("#date option:checked").textContent()).includes(
      `完整 ${nimrodDaily.complete_warehouse_count}/18 箱`
    ));
    assert((await page.locator("#coverage").textContent()).includes(
      `${nimrodDaily.warehouses_without_data} 个矿箱当日无数据`
    ));
    assert((await page.locator("#count").textContent()).includes("18 个矿箱"));
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
    assert.equal(nimrod02Inactive.length, 0);
    await page.selectOption("#site", nimrod02.data_center_id);
    await page.waitForFunction(name =>
      document.querySelector("#brand-name")?.textContent === name, "Nimrod02");
    await page.selectOption("#date", catalog.latest_date);
    await page.waitForFunction(date =>
      document.querySelector("#meta")?.textContent.includes(`当前 ${date}`),
      catalog.latest_date);
    assert.equal(await page.locator(".warehouse-card").count(),
      nimrod02.warehouse_count);
    assert((await page.locator("#count").textContent()).includes(
      `${nimrod02.warehouse_count} 个矿箱`
    ));
    const nimrod02WarehouseNames = await page.locator(
      ".warehouse-card .card-title strong",
    ).allTextContents();
    for (const warehouseName of ["C17", "C18"]) {
      assert(!nimrod02WarehouseNames.includes(warehouseName));
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
    await racePage.route("**/data/hours/*.json*", async route => {
      const url = route.request().url();
      const isLatest = url.includes(`-${latestDayFile}-`);
      if (isLatest) await new Promise(resolve => setTimeout(resolve, 2500));
      await route.continue();
    });
    await racePage.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });
    await racePage.waitForFunction(() =>
      document.querySelectorAll("#date option").length === 7);
    await racePage.waitForSelector("#loading:not([hidden])");
    const raceHours = raceSite.hours_by_date[raceDate];
    assert(raceHours?.length, `no hourly data for ${raceSite.data_center_name}/${raceDate}`);
    const raceHour = raceHours.at(-1);
    await racePage.selectOption("#site", raceSite.data_center_id);
    await racePage.selectOption("#date", raceDate);
    await racePage.waitForFunction(hour =>
      document.querySelector(`#hour option[value="${hour}"]`) != null,
    String(raceHour));
    await racePage.selectOption("#hour", String(raceHour));
    await racePage.waitForFunction(date =>
      document.querySelector("#meta")?.textContent.includes(`当前 ${date}`),
      raceDate);
    await racePage.waitForTimeout(3500);
    const racePower = await racePage.locator(
      "#metrics [data-metric='actual'] .overview-value"
    )
      .textContent();
    assert(!racePower.trim().startsWith("0"),
      "a late hour response overwrote the newly selected hour");
    assert.equal(await racePage.locator("#date").inputValue(), raceDate);
    assert.equal(
      await racePage.locator("#hour").inputValue(), String(raceHour),
    );
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
    await page.locator(".warehouse-card .meter-trend-button").first().click();
    await page.waitForSelector("#meter-trend[open]");
    await page.waitForFunction(
      () => document.querySelectorAll(
        "#meter-trend .meter-trend-stat",
      ).length === 3,
      undefined,
      { timeout: 60000 },
    );
    assert.equal(
      await page.locator("#meter-trend .meter-trend-stat").count(),
      3,
    );
    assert(await page.evaluate(() => {
      const dialog = document.querySelector("#meter-trend");
      const box = dialog.getBoundingClientRect();
      return box.left >= 0
        && box.right <= innerWidth + 1
        && dialog.scrollWidth <= dialog.clientWidth + 1;
    }), "移动端电表趋势弹窗不能横向溢出");
    assert(await page.locator("#meter-trend-tooltip")
      .evaluate(element => element.hidden));
    const mobileMeterHour = await page.locator(
      "#meter-trend .meter-trend-hit",
    ).evaluateAll(elements =>
      elements.find(element =>
        meterTrendState.hours[Number(element.dataset.meterTrendHour)]
      )?.dataset.meterTrendHour || null
    );
    assert(mobileMeterHour != null);
    await page.locator(
      `#meter-trend [data-meter-trend-hour="${mobileMeterHour}"]`,
    ).click();
    assert(!(await page.locator("#meter-trend-tooltip")
      .evaluate(element => element.hidden)));
    assert(await page.evaluate(() => {
      const tooltip = document.querySelector("#meter-trend-tooltip")
        .getBoundingClientRect();
      const chart = document.querySelector(".meter-trend-chart-wrap")
        .getBoundingClientRect();
      return tooltip.left >= chart.left
        && tooltip.right <= chart.right + 1
        && tooltip.top >= chart.top
        && tooltip.bottom <= chart.bottom + 1;
    }), "移动端电表趋势数值框必须完整显示");
    assert(await page.evaluate(() =>
      [...document.querySelectorAll(
        "#meter-trend .meter-trend-stat > span, "
        + "#meter-trend .meter-trend-stat > strong, "
        + "#meter-trend .meter-trend-stat > em",
      )].every(element => element.scrollWidth <= element.clientWidth + 1)
    ), "移动端电表趋势弹窗文字不能溢出容器");
    await page.screenshot({
      path: path.join(
        ROOT, "outputs", "dashboard-check", "meter-trend-mobile.png",
      ),
      fullPage: false,
    });
    await page.locator("#meter-trend-close").click();
    assert(!(await page.locator("#meter-trend").evaluate(dialog => dialog.open)));
    await page.locator(
      ".warehouse-card [data-distribution-id]:not([disabled])",
    ).first().click();
    assert(await page.locator("#distribution").evaluate(dialog => dialog.open));
    assert.equal(await page.locator(
      "#distribution-summary > div",
    ).count(), 3);
    assert.equal(await page.locator(
      "#distribution-charts .distribution-chart",
    ).count(), 2);
    assert(await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth
    ));
    await page.screenshot({
      path: path.join(ROOT, "outputs", "dashboard-check", "mobile-distribution.png"),
      fullPage: true,
    });
    await page.locator("#distribution-close").click();
    await page.locator(".warehouse-card [data-detail-id]").first().click();
    await page.waitForSelector("#detail-content tbody tr");
    await page.locator('[data-level="machine_rows"]').click();
    await page.waitForSelector(".machine-peak-card");
    assert.equal(await page.locator(".machine-peak-card").count(), 2);
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
  const {
    catalog, lark, catalogRows, machineHours, hourBundles,
  } = verifyPublishedData();
  if (!DATA_ONLY) {
    await verifyBrowser(catalog);
  }
  console.log(
    `PASS: ${catalog.sites.length} sites, ${catalog.available_dates.length} days, ` +
    `${catalogRows} warehouse hours, ${machineHours} latest-day machine hours, ` +
    `${hourBundles} hourly bundles, ${lark.record_count} Lark power records; ` +
    (DATA_ONLY
      ? "data, hourly bundles and lazy gzip details"
      : "data, hourly bundles, lazy gzip details, Lark matching, distribution dialogs, meter trend dialog, peak drill-down, charts, site/date/hour switching and mobile layout"),
  );
})().catch(error => {
  console.error(error);
  process.exit(1);
});
