const $ = id => document.getElementById(id);
const fmt = (n, digits = 1) => n == null || !Number.isFinite(n)
  ? "—" : n.toLocaleString("zh-CN", { maximumFractionDigits: digits });
const fmtRatio = n => n == null || !Number.isFinite(Number(n))
  ? "—" : Number(n).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));
const percent = n => n == null || !Number.isFinite(n) ? "—" : `${fmt(n * 100)}%`;
const percent2 = n => n == null || !Number.isFinite(n)
  ? "—" : `${n.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
const compactDate = date => String(date).replaceAll("-", "");
const shortDate = date => String(date).slice(5);
const DATA_TIMEZONE = "UTC+0";
const DATA_TIME_ZONE = "UTC";
const hourLabel = hour => `${String(hour).slice(0, 4)}-${String(hour).slice(4, 6)}-${String(hour).slice(6, 8)} ${String(hour).slice(8, 10)}:00 ${DATA_TIMEZONE}`;
const hourOnlyLabel = hour => `${String(hour).slice(8, 10)}:00 ${DATA_TIMEZONE}`;
const expectedHoursPerDay = 24;
const MACHINE_POWER_FIELDS = [
  "machine_hour_peak_power_w",
  "machine_hour_peak_hour",
  "machine_hour_peak_ip",
  "machine_hour_peak_model",
  "machine_hour_peak_work_mode",
  "machine_hour_peak_hashrate_ths",
  "machine_hour_peak_ratio_w_per_th",
  "machine_hour_peak_temperature_c",
  "machine_hour_peak_rejected_rate",
  "machine_daily_avg_peak_power_w",
  "machine_daily_avg_peak_ip",
  "machine_daily_avg_peak_model",
  "machine_daily_avg_peak_work_mode",
  "machine_daily_avg_peak_valid_hours",
  "machine_daily_avg_peak_hour",
  "machine_daily_avg_peak_hashrate_ths",
  "machine_daily_avg_peak_ratio_w_per_th",
  "machine_daily_avg_peak_temperature_c",
  "machine_daily_avg_peak_rejected_rate",
  "warehouse_machine_avg_power_w",
  "machine_hour_sample_count",
];
const palette = ["#3f8273", "#557fa4", "#bd9147", "#937190", "#b56e55", "#72906d", "#80795f", "#5f8790"];
let catalog, sites = [], warehouses = [], dates = [], hours = [], currentRows = [];
let selectedDate, dayData, detailData, detailContext, detailSummaryRow;
let level = "template_rows";
let requestVersion = 0, dayRequestVersion = 0, trendMode = "daily";
let trendMetric = "ratio", trendState = null, loadFilter = "all";
let distributionWarehouseId = null;
let powerLimitFilter = "all", detailPowerLimitW = null;
let meterTrendState = null;
let meterTrendRequestVersion = 0;
const hourCache = new Map();
const dayTrendCache = new Map();
const detailSummaryCache = new Map();
const detailMachineCache = new Map();

function iconize() {
  if (window.lucide) window.lucide.createIcons();
}

function metric(label, value, unit, note = "") {
  return `<div class="metric"><div class="metric-label">${esc(label)}</div><div class="metric-value">${esc(value)}<span class="unit">${esc(unit)}</span></div><div class="metric-note">${esc(note)}</div></div>`;
}

function overviewMetric(label, value, unit, comparison, options = {}) {
  return `<div class="overview-stat" data-metric="${esc(options.key || "")}">
    <div class="overview-label"><span>${esc(label)}</span>${
      options.scope ? `<em>${esc(options.scope)}</em>` : ""
    }</div>
    <div class="overview-primary">
      <div class="overview-value">${esc(value)}<small>${esc(unit)}</small></div>
      ${comparison}
    </div>
    ${options.meta ? `<div class="overview-stat-meta">${options.meta}</div>` : ""}
  </div>`;
}

function overviewSupportMetric(label, value, unit, note, key) {
  return `<div class="overview-support-item" data-metric="${esc(key)}">
    <span>${esc(label)}</span>
    <strong>${esc(value)}<small>${esc(unit)}</small></strong>
    <em>${esc(note)}</em>
  </div>`;
}

function powerMarginHTML(value, theory, subject = "矿箱理论功率") {
  if (!finite(value) || !finite(theory) || Number(theory) <= 0) {
    return `<div class="overview-margin unavailable">
      <span>${esc(subject)}余量</span>
      <strong>—</strong>
      <em>暂无可对照的${esc(subject)}</em>
    </div>`;
  }
  const delta = Number(theory) - Number(value);
  const over = delta < 0;
  return `<div class="overview-margin${over ? " over" : ""}">
    <span>${over ? `超出${esc(subject)}` : `${esc(subject)}余量`}</span>
    <strong>${delta < 0 ? "−" : "+"}${fmt(Math.abs(delta))}<small>kW</small></strong>
    <em>对照${esc(subject)} ${fmt(theory)} kW</em>
  </div>`;
}

function ratio(rows) {
  const hashrate = sum(rows, "power_ratio_valid_hashrate_sum_ths");
  return hashrate > 0 ? sum(rows, "power_ratio_valid_power_sum_w") / hashrate : null;
}

function finiteSum(rows, key) {
  const values = rows
    .map(row => Number(row[key]))
    .filter(Number.isFinite);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function finiteCount(rows, key) {
  return rows.filter(row => finite(row[key])).length;
}

function weightedSampleMean(rows, field) {
  let count = 0;
  let sum = 0;
  for (const row of rows) {
    const sample = row.metric_samples?.[field];
    if (!sample || !finite(sample.count) || !finite(sample.sum)
      || Number(sample.count) <= 0) continue;
    count += Number(sample.count);
    sum += Number(sample.sum);
  }
  return count > 0 ? sum / count : null;
}

function mergeDetailRows(sourceRows, groupKeys) {
  const groups = new Map();
  for (const row of sourceRows) {
    const key = groupKeys.map(field => String(row[field] ?? "未记录")).join("\u001f");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(rows => {
    const merged = { ...rows[0] };
    merged.machine_count = rows.reduce(
      (total, row) => total + (Number(row.machine_count) || 0), 0,
    );
    merged.power_ratio_sample_count = rows.reduce(
      (total, row) => total + (Number(row.power_ratio_sample_count) || 0), 0,
    );
    merged.power_ratio_valid_power_sum_w = rows.reduce(
      (total, row) => total + (Number(row.power_ratio_valid_power_sum_w) || 0), 0,
    );
    merged.power_ratio_valid_hashrate_sum_ths = rows.reduce(
      (total, row) => total + (Number(row.power_ratio_valid_hashrate_sum_ths) || 0), 0,
    );
    merged.avg_hashrate_ths = weightedSampleMean(rows, "hashrate_ths");
    merged.avg_power_w = weightedSampleMean(rows, "power_w");
    merged.power_ratio_avg_w_per_th = weightedSampleMean(
      rows, "power_ratio_w_per_th",
    );
    merged.rejected_rate_avg = weightedSampleMean(rows, "rejected_rate");
    merged.temperature_avg_c = weightedSampleMean(rows, "temperature_c");
    merged.power_ratio_overall_w_per_th =
      merged.power_ratio_valid_hashrate_sum_ths > 0
        ? merged.power_ratio_valid_power_sum_w
          / merged.power_ratio_valid_hashrate_sum_ths
        : null;
    for (const field of [
      "rejected_rate_max", "rejected_rate_min",
      "temperature_max_c", "temperature_min_c",
      "power_ratio_max_w_per_th", "power_ratio_min_w_per_th",
    ]) {
      const values = rows.map(row => Number(row[field])).filter(Number.isFinite);
      if (!values.length) {
        merged[field] = null;
      } else if (field.includes("_max")) {
        merged[field] = Math.max(...values);
      } else {
        merged[field] = Math.min(...values);
      }
    }
    return merged;
  });
}

function ratioCoverage(row) {
  return row.machine_count ? row.power_ratio_sample_count / row.machine_count : null;
}

function finite(value) {
  return value != null && Number.isFinite(Number(value));
}

function powerGap(row) {
  const actual = Number(row.actual_power_kw);
  const theory = Number(row.theoretical_power_kw);
  if (!Number.isFinite(actual) || !Number.isFinite(theory)) return null;
  return {
    value: theory - actual,
    over: theory < actual,
  };
}

function warehouseActualMargin(row) {
  const theory = warehouseTheoreticalPower(row);
  const actual = finite(row?.actual_power_kw)
    ? Number(row.actual_power_kw)
    : outageInference(row) ? 0 : null;
  return Number.isFinite(theory) && Number.isFinite(actual)
    ? theory - actual : null;
}

function configuredPowerLimit(warehouse) {
  const configured = Number(warehouse?.unit_power_limit_w);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return String(warehouse?.data_center_name ?? "").trim().toLowerCase()
    === "nimrod01" ? 3500 : 4000;
}

function machinePowerState(machine, limit = detailPowerLimitW) {
  const power = Number(machine?.avg_power_w);
  const ceiling = Number(limit);
  if (!Number.isFinite(power) || !Number.isFinite(ceiling) || ceiling <= 0) {
    return null;
  }
  return {
    power,
    limit: ceiling,
    ratio: power / ceiling,
    over: power > ceiling,
  };
}

function matchesPowerLimitFilter(machine) {
  if (powerLimitFilter === "all") return true;
  const state = machinePowerState(machine);
  if (!state) return false;
  if (powerLimitFilter === "over100") return state.ratio > 1;
  if (powerLimitFilter === "range95to100") {
    return state.ratio >= 0.95 && state.ratio <= 1;
  }
  if (powerLimitFilter === "below95") return state.ratio < 0.95;
  return false;
}

function syncTimeLabel(value) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hour12: false, timeZone: DATA_TIME_ZONE,
  }) + ` ${DATA_TIMEZONE}`;
}

function timestampLabel(value, includeSeconds = false) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const iso = date.toISOString();
  const seconds = includeSeconds ? `:${iso.slice(17, 19)}` : "";
  return `${iso.slice(0, 16).replace("T", " ")}${seconds} ${DATA_TIMEZONE}`;
}

function machineSampleLabel(row) {
  return row?.machine_recorded_at
    ? timestampLabel(row.machine_recorded_at, true)
    : "未记录";
}

function machinePowerStatsFromRow(row) {
  return Object.fromEntries(
    MACHINE_POWER_FIELDS
      .filter(key => row?.[key] != null)
      .map(key => [key, row[key]]),
  );
}

function machineDayPowerStats(payload) {
  const byIp = new Map();
  let hourPeak = null;
  let sampleCount = 0;
  let warehousePowerSum = 0;
  for (const [hourKey, data] of Object.entries(payload?.hours || {})) {
    const hour = Number(hourKey);
    const hourlyByIp = new Map();
    for (const machine of data.machine_rows || []) {
      const power = Number(machine.avg_power_w);
      if (!finite(power)) continue;
      const ip = String(machine.ip || "IP 未记录");
      const previous = hourlyByIp.get(ip);
      if (!previous || power > Number(previous.avg_power_w)) {
        hourlyByIp.set(ip, machine);
      }
    }
    for (const [ip, machine] of hourlyByIp) {
      const power = Number(machine.avg_power_w);
      sampleCount += 1;
      warehousePowerSum += power;
      if (!hourPeak || power > Number(hourPeak.machine.avg_power_w)) {
        hourPeak = { hour, ip, machine };
      }
      if (!byIp.has(ip)) {
        byIp.set(ip, {
          ip,
          powerSum: 0,
          validHours: new Set(),
          representative: machine,
          peakHour: hour,
          peakPower: power,
        });
      }
      const machineDay = byIp.get(ip);
      machineDay.powerSum += power;
      machineDay.validHours.add(hour);
      if (power > machineDay.peakPower) {
        machineDay.representative = machine;
        machineDay.peakHour = hour;
        machineDay.peakPower = power;
      }
    }
  }
  const dailyAveragePeak = [...byIp.values()].reduce((best, machine) => {
    const averagePowerW = machine.powerSum / machine.validHours.size;
    const candidate = { ...machine, averagePowerW };
    return !best || averagePowerW > best.averagePowerW ? candidate : best;
  }, null);
  return {
    hourPeak,
    dailyAveragePeak,
    warehouseAverageW: sampleCount ? warehousePowerSum / sampleCount : null,
    sampleCount,
  };
}

function currentSite() {
  return sites.find(site => site.data_center_id === $("site").value);
}

function larkRecordFor(warehouse, date = selectedDate) {
  return warehouse?.lark_power_by_date?.[date] || null;
}

function warehouseTheoreticalPower(row) {
  for (const value of [
    row?.theoretical_power_kw,
    row?.lark_power?.power_limit_kw,
  ]) {
    const power = Number(value);
    if (Number.isFinite(power) && power > 0) return power;
  }
  return null;
}

function dailyFor(date, site = currentSite()) {
  return (site?.daily_summary || []).find(item => item.date === date);
}

function siteTheoreticalPower(item = dailyFor(selectedDate)) {
  const configured = Number(item?.configured_theoretical_power_kw);
  if (Number.isFinite(configured)) return configured;
  const observed = item?.hours_with_data ?? item?.hours?.length;
  const legacyTotal = Number(item?.theoretical_power_kw);
  return Number.isFinite(legacyTotal) && observed
    ? legacyTotal / observed : null;
}

function warehouseHours(warehouseId, date = selectedDate, site = currentSite()) {
  const coverage = site?.warehouse_hours_by_date?.[date];
  if (coverage) {
    const recorded = coverage[warehouseId];
    return Array.isArray(recorded) ? recorded.length : 0;
  }
  const dailyCount = dailyFor(date, site)?.warehouse_hour_counts?.[warehouseId];
  if (Number.isFinite(Number(dailyCount))) return Number(dailyCount);
  return new Set(
    (dayData?.warehouse_rows || [])
      .filter(row => row.data_center_id === site?.data_center_id
        && row.warehouse_id === warehouseId
        && String(row.hour).startsWith(compactDate(date)))
      .map(row => row.hour),
  ).size;
}

function outageInference(row) {
  if (!row?.missing) return null;
  const expected = Number(
    dailyFor(selectedDate, currentSite())?.expected_hours
      ?? expectedHoursPerDay,
  ) || expectedHoursPerDay;
  const observed = warehouseHours(row.warehouse_id);
  if (row.inferred_outage === true || (
    row.inferred_outage !== false && observed > 0 && observed < expected
  )) {
    return {
      observed,
      expected,
      missingHours: Math.max(0, expected - observed),
    };
  }
  return null;
}

function warehousesWithDataOnDate(site = currentSite(), date = selectedDate) {
  const coverage = site?.warehouse_hours_by_date?.[date];
  if (!coverage) return null;
  return new Set(
    Object.entries(coverage)
      .filter(([, recordedHours]) =>
        Array.isArray(recordedHours) && recordedHours.length
      )
      .map(([warehouseId]) => warehouseId),
  );
}

function larkPowerSnapshot(site = currentSite(), date = selectedDate) {
  const rows = warehouses
    .filter(warehouse =>
      warehouse.data_center_id === site?.data_center_id
    )
    .map(warehouse => larkRecordFor(warehouse, date))
    .filter(Boolean);
  const siteSnapshot = site?.lark_power_by_date?.[date];
  const available = Boolean(siteSnapshot?.available && rows.length);
  return {
    available,
    snapshotDate: available ? date : null,
    syncedAt: available ? siteSnapshot?.synced_at : null,
    matched: rows.length,
    mountedPower: available ? finiteSum(rows, "mounted_power_kw") : null,
    mountedPowerCount: available ? finiteCount(rows, "mounted_power_kw") : 0,
    reservedPower: available ? finiteSum(rows, "reserved_power_kw") : null,
    reservedPowerCount: available ? finiteCount(rows, "reserved_power_kw") : 0,
    mountedMachines: available ? finiteSum(rows, "mounted_machine_count") : null,
    mountedMachineCount: available
      ? finiteCount(rows, "mounted_machine_count") : 0,
    occupiedSlots: available ? sum(rows, "occupied_slots") : null,
  };
}

function hasMachineData(row) {
  return Boolean(
    row?.machine_data_available === true
    || finite(row?.actual_power_kw)
    || Number(row?.machine_count) > 0
  );
}

function hasMeterData(row) {
  return finite(row?.meter_power_kw);
}

function meterLoadRatio(row) {
  const meterPower = Number(row?.meter_power_kw);
  const theoryPower = Number(row?.theoretical_power_kw);
  if (!Number.isFinite(meterPower) || !Number.isFinite(theoryPower)
    || theoryPower <= 0) return null;
  return meterPower / theoryPower;
}

function loadClass(row) {
  if (!row) return "no_hour";
  if (outageInference(row)) return "below";
  if (row.missing) return "no_hour";
  const machineLoad = Number(row.load_ratio);
  const load = finite(machineLoad) ? machineLoad : meterLoadRatio(row);
  if (!finite(load)) return "unclassified";
  if (load > 1) return "over";
  return "below";
}

function loadClassLabel(classification, row) {
  if (outageInference(row)) return "本小时停电推断";
  const meterOnly = hasMeterData(row) && !hasMachineData(row);
  const load = meterOnly ? meterLoadRatio(row) : Number(row?.load_ratio);
  const prefix = meterOnly ? "电表" : "";
  return {
    over: `${prefix}高于矿箱理论功率`,
    below: load === 1
      ? `${prefix}达到矿箱理论功率`
      : `${prefix}低于矿箱理论功率`,
    no_hour: "本小时矿箱数据缺失",
    unclassified: "矿箱理论功率缺失",
  }[classification] || "未分类";
}

function coverageLabel(observed, expected = expectedHoursPerDay) {
  return `${observed ?? "—"}/${expected ?? expectedHoursPerDay} 小时`;
}

function coverageParts(daily, site = currentSite()) {
  const observed = daily?.hours_with_data ?? daily?.hours?.length;
  const expected = daily?.expected_hours ?? expectedHoursPerDay;
  const totalWarehouses = daily?.warehouse_count
    ?? site?.warehouse_count
    ?? daily?.warehouses_with_data
    ?? site?.warehouses_with_data;
  const completeWarehouses = daily?.complete_warehouse_count
    ?? Object.values(daily?.warehouse_hour_counts || {})
      .filter(count => count >= expected).length;
  return { observed, expected, completeWarehouses, totalWarehouses };
}

function siteCoverageLabel(daily, site = currentSite()) {
  const { observed, expected, completeWarehouses, totalWarehouses } =
    coverageParts(daily, site);
  return `运行 ${coverageLabel(observed, expected)} · 完整 ${completeWarehouses ?? "—"}/${totalWarehouses ?? "—"} 箱`;
}

function populateSiteSelector() {
  $("site").innerHTML = sites.map(site =>
    `<option value="${esc(site.data_center_id)}">${esc(site.data_center_name)}</option>`
  ).join("");
  const preferred = sites.find(site => site.data_center_name === "WhiteOak01");
  $("site").value = (preferred || sites[0]).data_center_id;
}

function populateDates(preferredDate) {
  dates = [...(currentSite()?.available_dates || [])];
  $("date").innerHTML = dates.map(date => {
    const daily = dailyFor(date);
    const { observed, expected, completeWarehouses, totalWarehouses } =
      coverageParts(daily);
    return `<option value="${esc(date)}">${esc(date)} · ${DATA_TIMEZONE} · 运行 ${esc(coverageLabel(observed, expected))} · 完整 ${esc(completeWarehouses ?? "—")}/${esc(totalWarehouses ?? "—")} 箱</option>`;
  }).join("");
  if (!dates.length) return;
  $("date").value = preferredDate && dates.includes(preferredDate)
    ? preferredDate : dates[dates.length - 1];
  selectedDate = $("date").value;
}

function populateHours() {
  const site = currentSite();
  hours = [...(site?.hours_by_date?.[selectedDate] || [])].sort();
  $("hour").innerHTML = hours.map(hour =>
    `<option value="${hour}">${hourLabel(hour)}</option>`
  ).join("");
  if (hours.length) $("hour").value = hours[hours.length - 1];
}

function loadHour(siteId, date, hour) {
  const cacheKey = `${siteId}/${date}/${hour}`;
  if (hourCache.has(cacheKey)) return hourCache.get(cacheKey);
  const version = encodeURIComponent(
    catalog.data_version || catalog.exported_at || catalog.latest_date,
  );
  const promise = fetchGzipJson(
    `data/hours/${siteId}-${compactDate(date)}-${String(hour).slice(-2)}.json.gz?v=${version}`
  );
  hourCache.set(cacheKey, promise);
  promise.catch(() => hourCache.delete(cacheKey));
  return promise;
}

function setLoading(active, text = "") {
  const loading = $("loading");
  loading.hidden = !active;
  if (text) $("loading-text").textContent = text;
  $("cards").setAttribute("aria-busy", active ? "true" : "false");
  document.querySelector("main").classList.toggle("is-loading", active);
}

function groupDistribution(items, nameKey, emptyLabel) {
  const grouped = new Map();
  for (const item of items || []) {
    const count = Number(item.machine_count || 0);
    if (!(count > 0)) continue;
    let label = item[nameKey];
    let missing = false;
    if (nameKey === "template_name" && !item.template_id) {
      label = "算力组数据缺失";
      missing = true;
    } else if (nameKey === "template_name") {
      label ||= "算力组名称未匹配";
    } else {
      label ||= "档位数据缺失";
      missing = !item.work_mode;
    }
    const key = `${missing ? "missing" : "value"}\u001f${label}`;
    const existing = grouped.get(key);
    if (existing) existing.count += count;
    else grouped.set(key, { label, count, missing });
  }
  const categories = [...grouped.values()]
    .map((item, index) => ({
      ...item,
      color: palette[index % palette.length],
    }))
    .sort((a, b) => b.count - a.count)
    .map((item, index) => ({
      ...item,
      color: palette[index % palette.length],
    }));
  const total = categories.reduce((value, item) => value + item.count, 0);
  const validCategoryCount = categories.filter(item => !item.missing).length;
  return { categories, total, emptyLabel, validCategoryCount };
}

function donutGradient(distribution) {
  let offset = 0;
  return distribution.categories.map(item => {
    const start = offset;
    offset += item.count / distribution.total * 100;
    return `${item.color} ${start.toFixed(4)}% ${offset.toFixed(4)}%`;
  }).join(", ");
}

function distributionChartHTML(title, distribution, kind) {
  const sectionStart = `<section class="distribution-chart" data-distribution="${kind}" data-total="${distribution.total}">`;
  if (!distribution.total) {
    return `${sectionStart}
      <h4>${title}</h4>
      <div class="distribution-chart-empty">${esc(distribution.emptyLabel)}</div>
    </section>`;
  }
  if (distribution.categories.length === 1 && distribution.categories[0].missing) {
    const item = distribution.categories[0];
    return `${sectionStart}
      <h4>${title}</h4>
      <div class="distribution-chart-empty is-missing">
        <strong>${esc(item.label)}</strong>
        <span>${fmt(item.count, 0)} 台矿机未提供算力组 ID</span>
      </div>
    </section>`;
  }
  if (distribution.categories.length === 1) {
    const item = distribution.categories[0];
    return `${sectionStart}
      <h4>${title}</h4>
      <div class="distribution-single" style="--segment-color:${item.color}">
        <span><i></i><b>${esc(item.label)}</b></span>
        <strong>${fmt(item.count, 0)}<small>台</small></strong>
        <em>占本箱 ${fmt(item.count / distribution.total * 100)}%</em>
      </div>
    </section>`;
  }
  return `${sectionStart}
    <h4>${title}</h4>
    <div class="distribution-donut-wrap">
      <div class="distribution-donut"
        style="--distribution-segments:conic-gradient(${donutGradient(distribution)})"
        role="img"
        aria-label="${title}，${distribution.categories.length} 类，共 ${distribution.total} 台矿机">
        <div class="distribution-donut-center">
          <strong>${fmt(distribution.total, 0)}</strong>
          <span>台矿机</span>
        </div>
      </div>
    </div>
    <div class="distribution-chart-legend">
      ${distribution.categories.map(item => `<div title="${esc(item.label)}：${fmt(item.count, 0)} 台，${fmt(item.count / distribution.total * 100)}%">
        <i style="--segment-color:${item.color}"></i>
        <span>${esc(item.label)}</span>
        <strong>${fmt(item.count, 0)}</strong>
        <em>${fmt(item.count / distribution.total * 100)}%</em>
      </div>`).join("")}
    </div>
  </section>`;
}

function distributionTriggerHTML(row) {
  const templates = groupDistribution(
    row.templates, "template_name", "当前小时未记录算力组",
  );
  const workModes = groupDistribution(
    row.work_modes, "work_mode", "当前小时未记录档位",
  );
  const hasDistribution = templates.total > 0 || workModes.total > 0;
  const machineHoursAvailable = hasMachineData(row);
  return `<div class="distribution-trigger">
    <div class="distribution-trigger-copy">
      <span>箱内配置分布</span>
      <strong>${machineHoursAvailable
        ? `${templates.validCategoryCount} 个算力组 · ${workModes.validCategoryCount} 个档位 · ${fmt(row.machine_count, 0)} 台矿机`
        : "矿机小时数据未采集"}</strong>
    </div>
    <button type="button" data-distribution-id="${esc(row.warehouse_id)}"${hasDistribution ? "" : " disabled"} title="${hasDistribution ? "查看算力组和档位分布" : "当前小时没有分布数据"}">
      <i data-lucide="chart-pie"></i>${hasDistribution ? "查看分布" : "暂无分布"}
    </button>
  </div>`;
}

function openDistribution(id) {
  const warehouse = warehouses.find(item =>
    item.data_center_id === currentSite()?.data_center_id
    && item.warehouse_id === id
  );
  const row = currentRows.find(item => item.warehouse_id === id);
  if (!warehouse || !row || row.missing) return;
  const templates = groupDistribution(
    row.templates, "template_name", "当前小时未记录算力组",
  );
  const workModes = groupDistribution(
    row.work_modes, "work_mode", "当前小时未记录档位",
  );
  distributionWarehouseId = id;
  $("distribution-title").textContent = `${warehouse.warehouse_name} · 箱内配置分布`;
  $("distribution-meta").textContent =
    `${warehouse.data_center_name} · ${hourLabel(row.hour)} · 当前小时汇总`;
  $("distribution-summary").innerHTML = `
    <div><span>矿机总数</span><strong>${fmt(row.machine_count, 0)}</strong></div>
    <div><span>算力组</span><strong>${templates.validCategoryCount}</strong></div>
    <div><span>档位</span><strong>${workModes.validCategoryCount}</strong></div>`;
  $("distribution-charts").innerHTML =
    distributionChartHTML("算力组分布", templates, "template_name")
    + distributionChartHTML("档位分布", workModes, "work_mode");
  $("distribution-detail").disabled = !detailAvailable();
  $("distribution-detail").title = detailAvailable()
    ? "打开该矿箱的算力组、型号、档位和单机明细"
    : "历史日期只保留矿箱汇总";
  $("distribution").showModal();
  iconize();
}

function detailAvailable() {
  return (catalog.detail_dates || []).includes(selectedDate);
}

function renderCoverage(daily, site, lark) {
  const expected = daily?.expected_hours ?? expectedHoursPerDay;
  const observed = daily?.hours_with_data ?? daily?.hours?.length ?? hours.length;
  const { completeWarehouses, totalWarehouses } = coverageParts(daily, site);
  const partialWarehouses = daily?.incomplete_warehouse_count || 0;
  const warehousesWithoutData = daily?.warehouses_without_data || 0;
  const minimumHours = daily?.min_warehouse_hours;
  const complete = daily?.is_fully_complete
    ?? (observed === expected && partialWarehouses === 0);
  const details = [
    `${selectedDate} 场地 ${coverageLabel(observed, expected)}有数据，${completeWarehouses}/${totalWarehouses} 个矿箱完整。`,
  ];
  if (partialWarehouses) {
    details.push(
      `${partialWarehouses} 个有数据矿箱未满 ${expected} 小时${
        minimumHours == null ? "" : `，最少 ${minimumHours} 小时`
      }。`,
    );
  }
  if (warehousesWithoutData) {
    details.push(`${warehousesWithoutData} 个矿箱当日无数据。`);
  }
  if (finite(daily?.meter_covered_warehouses)) {
    details.push(
      `电表实测覆盖 ${daily.meter_covered_warehouses}/${daily.meter_total_warehouses ?? totalWarehouses} 个矿箱。`,
    );
  }
  details.push(lark.available
    ? `Lark-OM表使用 ${selectedDate} 当日快照。`
    : `${selectedDate} 没有 Lark-OM表功率快照，不沿用其他日期。`);
  const element = $("coverage");
  element.className = `coverage-note ${
    complete ? "complete" : "incomplete"
  }`;
  element.dataset.complete = complete ? "true" : "false";
  element.innerHTML = `<strong>${
    complete ? "数据完整" : "数据不完整"
  }</strong><span>${esc(site.data_center_name)} · 数据时区 ${DATA_TIMEZONE} · ${esc(details.join(" "))}</span>`;
}

function larkPanelHTML(row) {
  const lark = row.lark_power;
  if (!lark) {
    return `<div class="lark-power-panel unmatched snapshot-missing">
      <div class="lark-panel-head">
        <span>容量与负荷</span>
        <b>当日无快照</b>
      </div>
      <div class="lark-unmatched">${esc(selectedDate)} 没有 Lark-OM表容量记录，未使用其他日期替代。</div>
    </div>`;
  }
  const capacityFields = [
    lark.mounted_power_kw,
    lark.reserved_power_kw,
    lark.unit_theoretical_power_kw,
  ];
  const presentFields = capacityFields.filter(finite).length;
  const status = presentFields === capacityFields.length
    ? "已匹配" : presentFields ? "部分缺失" : "字段缺失";
  const theory = row.theoretical_power_kw;
  const usageLabel = capacity => {
    const actual = Number(row.actual_power_kw);
    const denominator = Number(capacity);
    return Number.isFinite(actual) && Number.isFinite(denominator)
      && denominator > 0
      ? `${fmt(actual / denominator * 100)}%`
      : "不可计算";
  };
  const capacityRow = (label, value, note) => {
    const noteHTML = note
      ? `<div class="capacity-note">${esc(note)}</div>`
      : "";
    if (!finite(value)) {
      return `<div class="capacity-row missing">
        <span>${label}</span><strong>容量字段缺失</strong>
        ${noteHTML}
      </div>`;
    }
    if (!finite(theory) || Number(theory) <= 0) {
      return `<div class="capacity-row">
        <span>${label}</span><strong>${fmt(value)}<small>kW</small></strong>
        <em>缺少矿箱理论功率</em>
        ${noteHTML}
      </div>`;
    }
    const width = Math.max(0, Math.min(100, Number(value) / Number(theory) * 100));
    const margin = Number(theory) - Number(value);
    const over = margin < 0;
    return `<div class="capacity-row${over ? " over" : ""}">
      <div class="capacity-copy">
        <span>${label}</span>
        <strong>${fmt(value)}<small>kW</small></strong>
        <em>${over
          ? `超出矿箱理论功率 ${fmt(Math.abs(margin))}`
          : `矿箱理论功率余量 ${fmt(margin)}`} kW</em>
      </div>
      <div class="capacity-track" title="${label} ${fmt(value)} kW，矿箱理论功率 ${fmt(theory)} kW">
        <i style="width:${width}%"></i>
      </div>
      ${noteHTML}
    </div>`;
  };
  return `<div class="lark-power-panel">
    <div class="lark-panel-head">
      <span>矿箱容量刻度 · 矿箱理论功率 ${finite(theory) ? `${fmt(theory)} kW` : "未配置"}</span>
      <b>${status}</b>
    </div>
    <div class="capacity-grid">
      ${capacityRow(
        `Lark-OM表在架功率（${usageLabel(lark.mounted_power_kw)}）`,
        lark.mounted_power_kw,
        `在架 ${lark.mounted_machine_count ?? "—"} 台`,
      )}
      ${capacityRow(
        `Lark-OM表占位功率（${usageLabel(lark.reserved_power_kw)}）`,
        lark.reserved_power_kw,
        `占位 ${lark.occupied_slots ?? "—"}/${lark.total_slots ?? "—"} 个槽位`,
      )}
    </div>
  </div>`;
}

function machinePowerHTML(row) {
  const metrics = [
    {
      key: "hour-peak",
      label: "单机小时峰值功率",
      value: row.machine_hour_peak_power_w,
      note: finite(row.machine_hour_peak_power_w)
        ? `全天最高 · ${hourOnlyLabel(row.machine_hour_peak_hour)} · ${row.machine_hour_peak_ip || "IP 未记录"}`
        : "当日无有效矿机小时样本",
    },
    {
      key: "daily-average-peak",
      label: "矿箱内矿机当日平均功率峰值",
      value: row.machine_daily_avg_peak_power_w,
      note: finite(row.machine_daily_avg_peak_power_w)
        ? `按有效 ${row.machine_daily_avg_peak_valid_hours ?? "—"} 小时平均 · 最高功率小时 ${hourOnlyLabel(row.machine_daily_avg_peak_hour)}`
        : "当日暂无有效矿机小时样本",
    },
    {
      key: "warehouse-machine-average",
      label: "矿箱内矿机平均功率",
      value: row.warehouse_machine_avg_power_w,
      note: finite(row.machine_hour_sample_count)
        ? `按 ${fmt(row.machine_hour_sample_count, 0)} 个矿机小时样本平均`
        : "当日无矿机小时样本",
    },
  ];
  return `<div class="machine-power-metrics" aria-label="矿机功率指标">
    ${metrics.map(item => `<div class="machine-power-metric" data-machine-power="${item.key}">
      <span>${esc(item.label)}</span>
      <strong>${fmt(item.value)}<small>W</small></strong>
      <em title="${esc(item.note)}">${esc(item.note)}</em>
    </div>`).join("")}
  </div>`;
}

function meterPowerHTML(row) {
  const trendButton = `<button type="button" class="meter-trend-button"
    data-meter-trend-id="${esc(row.warehouse_id)}"
    data-meter-trend-name="${esc(row.warehouse_name)}">
    <i data-lucide="chart-line"></i>查看当日电表功率趋势
  </button>`;
  if (!hasMeterData(row)) {
    return `<div class="meter-power-panel unavailable">
      <div class="meter-power-copy">
        <span>矿箱电表小时实测功率</span>
        <time class="meter-power-time">采样时间未记录</time>
        <strong>未采集</strong>
      </div>
      <div class="meter-power-context">
        <span>本小时没有对应电表记录</span>
      </div>
      ${trendButton}
    </div>`;
  }

  const meterPower = Number(row.meter_power_kw);
  const theoryPower = Number(row.theoretical_power_kw);
  const theoryAvailable = Number.isFinite(theoryPower) && theoryPower > 0;
  const loadRatio = theoryAvailable ? meterPower / theoryPower * 100 : null;
  const loadWidth = finite(loadRatio)
    ? Math.max(0, Math.min(100, loadRatio))
    : 0;
  const zeroText = meterPower === 0 ? "电表已采集，实测为 0 kW" : "";
  const sampleTime = row.meter_recorded_at
    ? timestampLabel(row.meter_recorded_at, true)
    : "采样时间未记录";

  return `<div class="meter-power-panel" data-meter-power="${esc(meterPower)}">
    <div class="meter-power-copy">
      <span>矿箱电表小时实测功率 <em>电表实测</em></span>
      <time class="meter-power-time">采样时间 ${esc(sampleTime)}</time>
      <strong>${fmt(meterPower)}<small>kW</small></strong>
    </div>
    <div class="meter-power-context">
      ${zeroText ? `<em class="meter-zero">${esc(zeroText)}</em>` : ""}
      ${trendButton}
    </div>
    ${theoryAvailable ? `<div class="meter-power-scale${loadRatio > 100 ? " over-theory" : ""}">
      <div class="meter-power-track" data-meter-load-ratio="${loadRatio.toFixed(2)}" title="电表实测 ${fmt(meterPower)} kW；矿箱理论功率 ${fmt(theoryPower)} kW；占矿箱理论功率 ${fmt(loadRatio)}%">
        <i style="width:${fmt(loadWidth, 2)}%"></i>
        <b aria-hidden="true"></b>
      </div>
      <div class="meter-power-scale-labels">
        <span>0 kW</span>
        <strong>${fmt(loadRatio)}% 理论功率</strong>
        <em>100% · ${fmt(theoryPower)} kW</em>
      </div>
    </div>` : ""}
  </div>`;
}

function cardCoverageHTML(observed, expected = expectedHoursPerDay) {
  const expectedHours = Number(expected) || expectedHoursPerDay;
  const observedHours = Number(observed) || 0;
  const complete = observedHours >= expectedHours;
  const width = Math.max(0, Math.min(100, observedHours / expectedHours * 100));
  return `<div class="card-coverage ${complete ? "complete" : "incomplete"}">
    <span>矿箱当日小时覆盖</span>
    <div class="card-coverage-track" title="当日覆盖 ${esc(coverageLabel(observedHours, expectedHours))}">
      <i style="width:${width}%"></i>
    </div>
    <strong>${esc(coverageLabel(observedHours, expectedHours))}</strong>
  </div>`;
}

function cardHTML(row) {
  const observedHours = warehouseHours(row.warehouse_id);
  const outage = outageInference(row);
  const theoreticalPower = warehouseTheoreticalPower(row);
  const machineSample = machineSampleLabel(row);
  if (theoreticalPower != null) {
    row = { ...row, theoretical_power_kw: theoreticalPower };
  }
  if (outage) {
    const theory = warehouseTheoreticalPower(row);
    row = {
      ...row,
      inferred_outage: true,
      actual_power_kw: 0,
      load_ratio: Number.isFinite(theory) && theory > 0 ? 0 : null,
      machine_count: 0,
      power_ratio_overall_w_per_th: null,
      power_ratio_sample_count: 0,
      models: [],
      templates: [],
      work_modes: [],
    };
  }
  const classification = loadClass(row);
  if (row.missing && !outage) {
    return `<article class="warehouse-card missing-card" data-warehouse-id="${esc(row.warehouse_id)}" data-load-class="no_hour">
      <div class="card-head"><div class="card-title"><strong>${esc(row.warehouse_name)}</strong><span class="status status-no_hour">本小时矿箱数据缺失</span></div></div>
      ${cardCoverageHTML(observedHours)}
      <div class="missing-state">
        <strong>暂无上报数据</strong>
        <span>本小时没有矿箱数据，不代表矿箱实际功率为 0 kW。</span>
      </div>
      ${meterPowerHTML(row)}
      ${machinePowerHTML(row)}
    </article>`;
  }
  const hasTheory = finite(row.theoretical_power_kw) && finite(row.load_ratio);
  const overload = hasTheory && row.load_ratio > 1;
  const gap = powerGap(row);
  const actualPowerAvailable = finite(row.actual_power_kw);
  const machineDataAvailable = hasMachineData(row);
  const meterDataAvailable = hasMeterData(row);
  const meterOnly = meterDataAvailable && !machineDataAvailable;
  const zeroPower = actualPowerAvailable && Number(row.actual_power_kw) === 0;
  const powerMissing = machineDataAvailable && !actualPowerAvailable;
  const loadPercent = hasTheory
    ? Math.max(0, Math.min(100, Number(row.load_ratio) * 100)) : null;
  const installedMachines = row.lark_power?.mounted_machine_count;
  const reportingIncomplete = !outage && finite(installedMachines)
    && Number(installedMachines) > Number(row.machine_count);
  const statusText = meterOnly
    ? "矿机小时数据缺失"
    : loadClassLabel(classification, row);
  const details = outage
    ? `<button type="button" disabled title="本小时为停电推断，没有单机明细">本小时无明细</button>`
    : meterOnly
    ? `<button type="button" disabled title="本小时只有电表数据，没有矿机明细">仅电表数据</button>`
    : detailAvailable()
    ? `<button type="button" data-detail-id="${esc(row.warehouse_id)}" aria-label="查看 ${esc(row.warehouse_name)} 详情">详情<i data-lucide="arrow-up-right"></i></button>`
    : `<button type="button" disabled title="历史日期仅保留矿箱汇总，明细保留最新一天">仅汇总</button>`;
  const cardClasses = [
    "warehouse-card",
    outage ? "inferred-outage-card" : "",
    overload ? "overload" : "",
    classification === "below" ? "below-theory" : "",
    meterOnly ? "meter-only-card" : "",
    hasTheory ? "" : "actual-only",
  ].filter(Boolean).join(" ");
  return `<article class="${cardClasses}" data-warehouse-id="${esc(row.warehouse_id)}" data-load-class="${esc(classification)}">
    <div class="card-head">
      <div class="card-title"><strong>${esc(row.warehouse_name)}</strong><span class="status status-${outage ? "outage" : esc(classification)}">${esc(statusText)}</span></div>
      ${details}
    </div>
    ${cardCoverageHTML(observedHours)}
    <div class="power-block">
      <div class="power-label">矿箱小时实际功率<time class="power-time">采样时间 ${esc(machineSample)}</time>${outage
        ? `<span class="inferred-outage-badge">停电推断</span>`
        : !machineDataAvailable
          ? `<span class="reporting meter-only">矿机数据未采集</span>`
        : reportingIncomplete
          ? `<span class="reporting warn">上报 ${row.machine_count}/${installedMachines} 台</span>`
          : ""}</div>
      <div class="power-line">
        <span class="actual-power${machineDataAvailable ? "" : " unavailable"}">${machineDataAvailable ? fmt(row.actual_power_kw) : "—"}${machineDataAvailable ? "<small>kW</small>" : ""}</span>
        ${!machineDataAvailable
          ? `<span class="power-unavailable">本小时仅展示电表实测</span>`
          : hasTheory
            ? `<span class="power-reference">矿箱理论功率 ${fmt(row.theoretical_power_kw)} kW</span>`
            : ""}
      </div>
      ${outage ? `<div class="inferred-outage-note">本小时没有矿箱小时记录；该矿箱当日有 ${esc(coverageLabel(outage.observed, outage.expected))}，按部分小时缺失规则推断为停电，实际功率按 0 kW 展示。</div>` : ""}
      ${!outage && zeroPower ? `<div class="zero-power-note">本小时有上报数据，实际功率为 0 kW</div>` : ""}
      ${powerMissing ? `<div class="power-missing-note">本小时有矿机上报记录，但矿机小时汇总功率缺失</div>` : ""}
      ${hasTheory ? `<div class="power-comparison${gap?.over ? " over" : ""}">
        <div class="power-comparison-track"
          title="矿箱小时实际功率 ${fmt(row.actual_power_kw)} kW，矿箱理论功率 ${fmt(row.theoretical_power_kw)} kW，占矿箱理论功率 ${fmt(row.load_ratio * 100)}%">
          <i style="width:${fmt(loadPercent, 2)}%"></i>
        </div>
        <div class="power-comparison-labels">
          <span>占矿箱理论功率 ${fmt(row.load_ratio * 100)}%</span>
          <strong>${gap
            ? gap.value === 0
              ? "达到矿箱理论功率"
              : gap.over
                ? `超出矿箱理论功率 ${fmt(Math.abs(gap.value))} kW`
                : `矿箱理论功率余量 ${fmt(gap.value)} kW`
            : "差值不可用"}</strong>
        </div>
      </div>` : ""}
      ${meterPowerHTML(row)}
    </div>
    ${larkPanelHTML(row)}
    <div class="card-glance">
      <div class="glance-item">
        <span>矿箱小时整体功耗比</span>
        <strong>${fmtRatio(row.power_ratio_overall_w_per_th)}<small>W/TH</small></strong>
      </div>
      <div class="glance-item">
        <span>本小时运行矿机数量</span>
        <strong>${machineDataAvailable
          ? `${row.machine_count}<small>台</small>`
          : `<span class="unavailable-value">未采集</span>`}</strong>
      </div>
    </div>
    ${distributionTriggerHTML(row)}
    ${machinePowerHTML(row)}
  </article>`;
}

function render() {
  if (!dayData || dayData.date !== selectedDate) return;
  const centerId = $("site").value;
  const site = currentSite();
  const hour = Number($("hour").value);
  const siteWarehouses = warehouses.filter(warehouse =>
    warehouse.data_center_id === centerId
  );
  const configuredIds = new Set(
    siteWarehouses.map(warehouse => warehouse.warehouse_id),
  );
  currentRows = dayData.warehouse_rows.filter(row =>
    row.data_center_id === centerId
    && row.hour === hour
    && configuredIds.has(row.warehouse_id)
  );
  const machineRows = currentRows.filter(hasMachineData);
  const meterRows = currentRows.filter(hasMeterData);
  const activeWarehouseCount = siteWarehouses.length;
  const machineCount = sum(machineRows, "machine_count");
  const actualPower = finiteSum(machineRows, "actual_power_kw");
  const meterPower = finiteSum(meterRows, "meter_power_kw");
  const theoryPower = siteTheoreticalPower(dailyFor(selectedDate, site))
    ?? sum(currentRows, "theoretical_power_kw");
  const validSamples = sum(machineRows, "power_ratio_sample_count");
  const lark = larkPowerSnapshot(site, selectedDate);
  const machineReportedBoxes = new Set(
    machineRows.map(row => row.warehouse_id),
  ).size;
  const meterCoveredBoxes = new Set(
    meterRows.map(row => row.warehouse_id),
  ).size;
  const larkMatched = lark.matched;
  const larkMounted = lark.mountedPower;
  const larkReserved = lark.reservedPower;
  const daily = dailyFor(selectedDate, site);
  const observedHours = daily?.hours_with_data ?? daily?.hours?.length ?? hours.length;
  const expectedHours = daily?.expected_hours ?? expectedHoursPerDay;
  const currentHourLabel = hourLabel(hour);
  $("brand-mark").textContent = site.data_center_name.charAt(0).toUpperCase();
  $("brand-name").textContent = site.data_center_name;
  const trendLabel = trendMetric === "ratio"
    ? "矿箱整体功耗比趋势"
    : "矿箱功率趋势";
  $("trend-title").textContent = `${site.data_center_name} ${trendLabel}`;
  $("trend").setAttribute("aria-label", `${site.data_center_name} ${trendLabel}`);
  const warehouseCoverage = `${activeWarehouseCount} 个矿箱`;
  $("meta").textContent = `${catalog.date_range.start} 至 ${catalog.date_range.end} · 数据时区 ${DATA_TIMEZONE} · 当前 ${selectedDate} · ${siteCoverageLabel(daily, site)} · ${warehouseCoverage}`;
  document.title = `${site.data_center_name} · 矿箱负荷 · ${DATA_TIMEZONE}`;
  renderCoverage(daily, site, lark);
  $("notice").textContent = lark.available
    ? `矿箱小时实际功率由矿机小时平均功耗汇总；矿箱电表小时实测功率取该 UTC 小时最接近整点的一条电表读数，单独展示且不覆盖矿机汇总。Lark-OM表使用 ${selectedDate} 当日快照，同步于 ${syncTimeLabel(lark.syncedAt)}。`
    : `矿箱小时实际功率由矿机小时平均功耗汇总；矿箱电表小时实测功率取该 UTC 小时最接近整点的一条电表读数，单独展示且不覆盖矿机汇总。${selectedDate} 没有 Lark-OM表容量快照，因此不沿用其他日期容量。`;
  $("metrics").innerHTML = `<div class="overview-power-grid">
      ${overviewMetric(
        "矿箱小时实际功率", fmt(actualPower), "kW",
        powerMarginHTML(actualPower, theoryPower),
        {
          key: "actual",
          scope: currentHourLabel,
          meta: `矿机数据覆盖 <b>${machineReportedBoxes}/${activeWarehouseCount}</b> 箱 · 上报矿机 <b>${fmt(machineCount, 0)}${lark.available && finite(lark.mountedMachines) ? `/${fmt(lark.mountedMachines, 0)}` : ""}</b> 台`,
        },
      )}
      ${overviewMetric(
        "矿箱电表小时实测功率", fmt(meterPower), "kW",
        powerMarginHTML(meterPower, theoryPower),
        {
          key: "meter",
          scope: currentHourLabel,
          meta: `电表数据覆盖 <b>${meterCoveredBoxes}/${activeWarehouseCount}</b> 箱`,
        },
      )}
      ${overviewMetric(
        "Lark-OM表在架功率", fmt(larkMounted), "kW",
        powerMarginHTML(larkMounted, theoryPower),
        {
          key: "mounted",
          scope: lark.available ? "当日快照" : "无快照",
          meta: lark.available
            ? `快照覆盖 ${lark.mountedPowerCount}/${larkMatched} 箱`
            : "Lark-OM表快照缺失",
        },
      )}
      ${overviewMetric(
        "Lark-OM表占位功率", fmt(larkReserved), "kW",
        powerMarginHTML(larkReserved, theoryPower),
        {
          key: "reserved",
          scope: lark.available ? "当日快照" : "无快照",
          meta: lark.available
            ? `快照覆盖 ${lark.reservedPowerCount}/${larkMatched} 箱`
            : "Lark-OM表快照缺失",
        },
      )}
    </div>
    <div class="overview-support">
      ${overviewSupportMetric(
        "场地当日小时覆盖", `${observedHours ?? "—"}/${expectedHours}`, "小时",
        `当前小时 ${String(hour).slice(-2)}:00`, "hour-coverage",
      )}
      ${overviewSupportMetric(
        "场地小时整体功耗比", fmtRatio(ratio(currentRows)), "W/TH",
        `${fmt(machineCount, 0)} 台 · 有效样本 ${validSamples}`, "ratio",
      )}
    </div>`;

  const search = $("search").value.trim().toLowerCase();
  let rows = siteWarehouses.map(warehouse => {
    const measured = currentRows.find(
      row => row.warehouse_id === warehouse.warehouse_id,
    );
    const larkPower = larkRecordFor(warehouse, selectedDate);
    return measured
      ? { ...warehouse, ...measured, lark_power: larkPower }
      : (() => {
        const dayMachineRow = dayData.warehouse_rows.find(row =>
          row.data_center_id === warehouse.data_center_id
          && row.warehouse_id === warehouse.warehouse_id
        );
        const missingRow = {
          ...warehouse,
          ...machinePowerStatsFromRow(dayMachineRow),
          lark_power: larkPower,
          hour,
          missing: true,
          theoretical_power_kw: warehouseTheoreticalPower(warehouse),
        };
        missingRow.inferred_outage = Boolean(outageInference(missingRow));
        return missingRow;
      })();
  });
  rows = rows.filter(row => JSON.stringify([
    row.warehouse_name, row.models, row.work_modes, row.templates,
    row.lark_power,
  ]).toLowerCase().includes(search));
  if (loadFilter !== "all") {
    rows = rows.filter(row => loadClass(row) === loadFilter);
  }
  const sort = $("sort").value;
  const sortKey = {
    power: "actual_power_kw",
    meter: "meter_power_kw",
  }[sort];
  const sortDirection = document.querySelector(
    'input[name="sort-order"]:checked',
  )?.value === "desc" ? "desc" : "asc";
  const byNameAsc = (a, b) => a.warehouse_name.localeCompare(
    b.warehouse_name, undefined, { numeric: true },
  );
  rows.sort((a, b) => {
    if (sort === "name") {
      const aUnavailable = a.missing && !outageInference(a);
      const bUnavailable = b.missing && !outageInference(b);
      if (aUnavailable !== bUnavailable) return aUnavailable ? 1 : -1;
      const direction = sortDirection === "asc" ? 1 : -1;
      return byNameAsc(a, b) * direction;
    }
    const aOutage = Boolean(outageInference(a));
    const bOutage = Boolean(outageInference(b));
    const aValue = sort === "available"
      ? warehouseActualMargin(a)
      : aOutage && sort === "power" ? 0 : a[sortKey];
    const bValue = sort === "available"
      ? warehouseActualMargin(b)
      : bOutage && sort === "power" ? 0 : b[sortKey];
    const aMissing = (a.missing && !aOutage) || !finite(aValue);
    const bMissing = (b.missing && !bOutage) || !finite(bValue);
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    if (aMissing) return byNameAsc(a, b);
    const difference = Number(aValue) - Number(bValue);
    return (sortDirection === "asc" ? difference : -difference)
      || byNameAsc(a, b);
  });

  $("count").textContent = `${site.data_center_name} · ${rows.length} 个矿箱`;
  $("detail-note").textContent = detailAvailable()
    ? "当前日期支持下钻到算力组、型号、档位和单机（含功耗上限）"
    : "该日期只保留矿箱汇总；单机明细需当日导出";
  $("empty").hidden = rows.length > 0;
  $("cards").innerHTML = rows.map(cardHTML).join("");
  iconize();
  renderTrend();
}

function dailySeries() {
  const site = currentSite();
  return site.daily_summary.map(item => {
    const observed = item.hours_with_data ?? item.hours?.length;
    const expected = item.expected_hours ?? expectedHoursPerDay;
    const meterHours = item.meter_hours_with_data
      ?? item.meter_hour_count
      ?? observed;
    const complete = item.is_fully_complete ?? (
      item.is_complete ?? observed === expected
    );
    return {
      key: item.date,
      label: `${shortDate(item.date)}${complete ? "" : "*"}`,
      periodLabel: `${item.date} · 当日有效小时平均`,
      ratio: item.power_ratio_overall_w_per_th,
      actualPower: finite(item.actual_power_kw) && observed
        ? item.actual_power_kw / observed : null,
      meterPower: finite(item.meter_hour_sum_kw) && meterHours
        ? item.meter_hour_sum_kw / meterHours : null,
      meterPeakPower: finite(item.meter_hour_peak_kw)
        ? Number(item.meter_hour_peak_kw) : null,
      meterPeakHour: finite(item.meter_hour_peak_hour)
        ? Number(item.meter_hour_peak_hour) : null,
      theoreticalPower: siteTheoreticalPower(item),
      mountedPower: larkPowerSnapshot(site, item.date).mountedPower,
      detail: item,
      complete,
      missing: false,
    };
  });
}

function hourlySeries() {
  const site = currentSite();
  const daily = dailyFor(selectedDate);
  const lark = larkPowerSnapshot(site, selectedDate);
  const theoryPower = siteTheoreticalPower();
  const recordedHours = new Set(hours.map(Number));
  const summaries = new Map(
    (dayData.hourly_summary || []).map(item => [Number(item.hour), item]),
  );
  const meterPeakPower = finite(daily?.meter_hour_peak_kw)
    ? Number(daily.meter_hour_peak_kw) : null;
  const meterPeakHour = finite(daily?.meter_hour_peak_hour)
    ? Number(daily.meter_hour_peak_hour) : null;
  return Array.from({ length: expectedHoursPerDay }, (_, index) => {
    const hour = Number(`${compactDate(selectedDate)}${String(index).padStart(2, "0")}`);
    const summary = summaries.get(hour);
    const hasData = recordedHours.has(hour);
    return {
      key: String(hour),
      label: `${String(hour).slice(-2)}:00`,
      periodLabel: hourLabel(hour),
      ratio: summary?.power_ratio_overall_w_per_th ?? null,
      actualPower: hasData ? summary?.actual_power_kw ?? null : null,
      meterPower: summary?.meter_hour_sum_kw ?? null,
      meterPeakPower,
      meterPeakHour,
      theoreticalPower: theoryPower,
      mountedPower: lark.available ? lark.mountedPower : null,
      detail: {
        machine_count: summary?.machine_count ?? null,
        power_ratio_sample_count: summary?.power_ratio_sample_count ?? null,
      },
      missing: !hasData,
    };
  });
}

function trendNumber(definition, item) {
  const value = definition.value(item);
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function chartNumber(definition, item) {
  const value = definition.chartValue
    ? definition.chartValue(item)
    : definition.value(item);
  return value == null || !Number.isFinite(Number(value))
    ? null : Number(value);
}

function chartSegments(points) {
  const segments = [];
  let current = [];
  for (const point of points) {
    if (point) {
      current.push(point);
    }
    else if (current.length) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

function chartPath(points) {
  return points.map((point, index) =>
    `${index ? "L" : "M"}${point[0].toFixed(1)},${point[1].toFixed(1)}`
  ).join(" ");
}

function renderTrend() {
  if (!dayData || dayData.date !== selectedDate) return;
  const series = trendMode === "daily" ? dailySeries() : hourlySeries();
  const dailyMode = trendMode === "daily";
  const definitions = trendMetric === "ratio"
    ? [{
        key: "ratio",
        label: "矿箱整体功耗比",
        className: "ratio",
        unit: "W/TH",
        value: item => item.ratio,
        chartValue: item => item.ratio,
        primary: true,
        area: true,
      }]
    : [
        {
          key: "meter",
          label: dailyMode
            ? "当日电表平均功率"
            : "电表小时实测功率",
          className: "meter",
          unit: "kW",
          value: item => item.meterPower,
          chartValue: item => item.meterPower,
          anchor: true,
        },
        {
          key: "peak",
          label: dailyMode
            ? "当日电表最大功率"
            : "当日电表最大功率（整日峰值）",
          className: "peak",
          unit: "kW",
          value: item => item.meterPeakPower,
          chartValue: item => item.meterPeakPower,
        },
        {
          key: "actual",
          label: dailyMode
            ? "当日矿箱平均功率"
            : "矿箱小时实际功率",
          className: "actual",
          unit: "kW",
          value: item => item.actualPower,
          chartValue: item => item.actualPower,
        },
      ];
  const primary = definitions.find(definition => definition.anchor)
    || definitions[0];
  const scopeLabel = dailyMode ? "近 7 天日均" : "当日逐小时";
  const titleLabel = trendMetric === "ratio"
    ? `矿箱整体功耗比 · ${scopeLabel}`
    : `矿箱功率 · ${scopeLabel}`;
  $("trend-title").textContent = `${currentSite().data_center_name} ${titleLabel}`;
  $("trend").setAttribute(
    "aria-label",
    `${currentSite().data_center_name} ${titleLabel}`,
  );
  const incompleteDays = series.filter(item =>
    trendMode === "daily" && !item.complete
  ).length;
  if (trendMetric === "ratio") {
    $("chart-note").textContent = dailyMode
      ? `近 7 天 · 每天 1 个点 · 当天全部有效小时样本功耗加权 · W/TH · 数据时区 ${DATA_TIMEZONE}${incompleteDays ? " · * 存在小时或矿箱缺口" : ""}`
      : `${selectedDate} 当日逐小时 · 每个点为该 UTC 小时的整体功耗比 · W/TH · 数据时区 ${DATA_TIMEZONE} · 当日覆盖 ${coverageLabel(hours.length)} · 灰色带为数据缺失小时`;
  }
  else {
    $("chart-note").textContent = dailyMode
      ? `近 7 天 · 每天 1 个点 · 矿箱和电表均为当日有效小时平均，最大功率为当日电表小时峰值 · kW · 数据时区 ${DATA_TIMEZONE}${incompleteDays ? " · * 存在小时或矿箱缺口" : ""}`
      : `${selectedDate} 当日逐小时 · 矿箱实际功率为矿机小时平均功耗汇总，电表为每个 UTC 小时实测值，当日电表最大功率为整日参考 · kW · 数据时区 ${DATA_TIMEZONE} · 当日覆盖 ${coverageLabel(hours.length)} · 灰色带为数据缺失小时`;
  }
  const selectedKey = trendMode === "daily" ? selectedDate : String($("hour").value);
  const allValues = definitions.flatMap(definition =>
    series.map(item => chartNumber(definition, item))
      .filter(value => value != null)
  );
  if (!allValues.length) {
    $("trend-summary").textContent = trendMetric === "ratio"
      ? "当前范围没有可计算的整体功耗比样本"
      : "当前范围没有可用的功率数据";
    $("trend").innerHTML = "";
    trendState = null;
    return;
  }
  const svg = $("trend");
  const width = Math.max(300, svg.parentElement.clientWidth);
  const height = 218;
  const pad = { left: 43, right: 14, top: 20, bottom: 27 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const ratioMode = trendMetric === "ratio";
  const scaleValues = ratioMode
    ? allValues
    : allValues.filter(value => value > 0);
  const valuesInScale = scaleValues.length ? scaleValues : allValues;
  const low = Math.min(...valuesInScale);
  const high = Math.max(...valuesInScale);
  const span = Math.max(
    high - low,
    ratioMode ? 0.5 : Math.max(Math.abs(high) * 0.01, 6),
  );
  const paddingRatio = ratioMode ? 0.28 : 0.18;
  const minValue = Math.max(0, low - span * paddingRatio);
  const maxValue = high + span * paddingRatio;
  const x = index => pad.left + (series.length === 1
    ? plotW / 2 : plotW * index / (series.length - 1));
  const y = value => pad.top + plotH * (1 - (value - minValue) / (maxValue - minValue));
  const selected = series.find(item => item.key === selectedKey);
  const currentLabel = dailyMode ? "当前日期" : "当前小时";
  const selectedCoverage = trendMode === "daily"
    && selected?.detail?.expected_hours
    ? ` · ${siteCoverageLabel(selected.detail)}`
    : "";
  const primaryValues = series.map(item => trendNumber(primary, item))
    .filter(value => value != null);
  const average = primaryValues.length
    ? primaryValues.reduce((total, value) => total + value, 0)
      / primaryValues.length
    : null;
  if (ratioMode) {
    const averageLabel = trendMode === "daily"
      ? `近 7 天逐日功耗比均值${incompleteDays ? "（含不完整日）" : ""}`
      : "当日矿箱整体功耗比均值";
    const averageContext = trendMode === "daily"
      ? "按有效日期等权平均"
      : "按当日有效小时样本汇总";
    $("trend-summary").innerHTML = `
      <div class="trend-stat">
        <span class="trend-stat-label">${currentLabel}矿箱整体功耗比</span>
        <span class="trend-stat-reading">
          <span class="trend-stat-value">${fmtRatio(selected?.ratio)}</span>
          <span class="trend-stat-unit">W/TH</span>
        </span>
        <span class="trend-stat-context">${esc(selected?.label || "")}${esc(selectedCoverage)}</span>
      </div>
      <div class="trend-stat">
        <span class="trend-stat-label">${averageLabel}</span>
        <span class="trend-stat-reading">
          <span class="trend-stat-value">${fmtRatio(average)}</span>
          <span class="trend-stat-unit">W/TH</span>
        </span>
        <span class="trend-stat-context">${averageContext}</span>
      </div>`;
  }
  else {
    const meterLabel = dailyMode ? "当日电表平均功率" : "当前小时电表功率";
    const actualLabel = dailyMode ? "当日矿箱平均功率" : "当前小时矿箱实际功率";
    const peakLabel = dailyMode ? "当日电表最大功率" : "当日电表最大功率";
    const periodText = dailyMode
      ? `${selected?.label || ""} · 当日有效小时平均`
      : hourLabel(Number(selected?.key));
    const actualContext = dailyMode ? "当日有效小时平均" : "矿机小时平均功耗汇总";
    const peakHourText = finite(selected?.meterPeakHour)
      ? `峰值 ${hourOnlyLabel(Number(selected.meterPeakHour))}`
      : "峰值小时未记录";
    $("trend-summary").innerHTML = `
      <div class="trend-stat">
        <span class="trend-stat-label">${meterLabel}</span>
        <span class="trend-stat-reading">
          <span class="trend-stat-value">${fmt(selected?.meterPower)}</span>
          <span class="trend-stat-unit">kW</span>
        </span>
        <span class="trend-stat-context">${esc(periodText)}</span>
      </div>
      <div class="trend-stat">
        <span class="trend-stat-label">${peakLabel}</span>
        <span class="trend-stat-reading">
          <span class="trend-stat-value">${fmt(selected?.meterPeakPower)}</span>
          <span class="trend-stat-unit">kW</span>
        </span>
        <span class="trend-stat-context">${esc(peakHourText)}</span>
      </div>
      <div class="trend-stat">
        <span class="trend-stat-label">${actualLabel}</span>
        <span class="trend-stat-reading">
          <span class="trend-stat-value">${fmt(selected?.actualPower)}</span>
          <span class="trend-stat-unit">kW</span>
        </span>
        <span class="trend-stat-context">${esc(actualContext)}</span>
      </div>`;
  }
  const grid = [0, 1, 2, 3].map(index => {
    const value = maxValue - (maxValue - minValue) * index / 3;
    const yPos = pad.top + plotH * index / 3;
    return `<line class="chart-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${yPos}" y2="${yPos}"/>
      <text class="chart-axis" x="0" y="${yPos + 3}">${ratioMode ? fmtRatio(value) : `${fmt(value)} kW`}</text>`;
  }).join("");
  const meanY = ratioMode && finite(average) ? y(average) : null;
  const labelEvery = series.length > 12 ? 4 : 1;
  const labels = series.map((item, index) => index % labelEvery === 0
    ? `<text class="chart-hour" x="${x(index)}" y="${height - 7}" text-anchor="middle" data-chart-key="${esc(item.key)}">${esc(item.label)}</text>` : "").join("");
  const hitWidth = plotW / Math.max(series.length, 1);
  const missingBands = trendMode === "hourly" ? series.map((item, index) => {
    if (!item.missing) return "";
    const left = Math.max(pad.left, x(index) - hitWidth / 2);
    const right = Math.min(width - pad.right, x(index) + hitWidth / 2);
    return `<rect class="chart-missing-band" x="${left}" y="${pad.top}" width="${Math.max(1, right - left)}" height="${plotH}"/>`;
  }).join("") : "";
  const pointsByDefinition = new Map(definitions.map(definition => [
    definition.key,
    series.map((item, index) => {
      const value = chartNumber(definition, item);
      return value == null ? null : [x(index), y(value)];
    }),
  ]));
  const hits = series.map((item, index) => {
    const detail = item.detail || {};
    const dateText = dailyMode
      ? item.key
      : hourLabel(Number(item.key));
    const coverage = trendMode === "daily" && detail.expected_hours
      ? ` · ${siteCoverageLabel(detail)}`
      : "";
    const valueText = ratioMode
      ? `矿箱整体功耗比 ${fmtRatio(item.ratio)} W/TH`
      : dailyMode
        ? `当日电表平均功率 ${fmt(item.meterPower)} kW，当日矿箱平均功率 ${fmt(item.actualPower)} kW，当日电表最大功率 ${fmt(item.meterPeakPower)} kW${finite(item.meterPeakHour) ? `（${hourOnlyLabel(Number(item.meterPeakHour))}）` : ""}`
        : `电表小时实测功率 ${fmt(item.meterPower)} kW，矿箱小时实际功率 ${fmt(item.actualPower)} kW，当日电表最大功率 ${fmt(item.meterPeakPower)} kW${finite(item.meterPeakHour) ? `（${hourOnlyLabel(Number(item.meterPeakHour))}）` : ""}`;
    const missingText = item.missing ? "，矿箱数据缺失" : "";
    const markers = definitions.map(definition => {
      const point = pointsByDefinition.get(definition.key)?.[index];
      return point
        ? `<circle class="chart-point ${definition.className}" cx="${point[0]}" cy="${point[1]}" r="3.4"/>`
        : "";
    }).join("");
    return `<g class="chart-hit-group">
      <rect class="chart-hit" x="${x(index) - hitWidth / 2}" y="${pad.top}" width="${hitWidth}" height="${plotH}" tabindex="0" role="button" data-chart-key="${esc(item.key)}" aria-label="${esc(dateText)}，${esc(valueText)}${esc(coverage)}${esc(missingText)}，点击查看"></rect>
      ${markers}
    </g>`;
  }).join("");
  const currentIndex = series.findIndex(item => item.key === selectedKey);
  const currentPoints = currentIndex < 0 ? "" : definitions.map(definition => {
    const point = pointsByDefinition.get(definition.key)?.[currentIndex];
    return point
      ? `<circle class="chart-current ${definition.className}" cx="${point[0]}" cy="${point[1]}" r="4"/>`
      : "";
  }).join("");
  const selection = currentIndex < 0 ? ""
    : `<line class="chart-selection" x1="${x(currentIndex)}" x2="${x(currentIndex)}" y1="${pad.top}" y2="${pad.top + plotH}"/>`;
  const linePaths = definitions.slice().sort((a, b) =>
    Number(Boolean(a.anchor)) - Number(Boolean(b.anchor))
  ).map(definition => {
    const points = pointsByDefinition.get(definition.key);
    const segments = chartSegments(points);
    const paths = segments.map(segment =>
      segment.length > 1
        ? `<path class="chart-line ${definition.className}" d="${chartPath(segment)}"/>`
        : ""
    ).join("");
    const singletonPoints = segments
      .filter(segment => segment.length === 1)
      .map(([point]) =>
        `<circle class="chart-series-point ${definition.className}" cx="${point[0]}" cy="${point[1]}" r="3.2"/>`
      )
      .join("");
    return `${paths}${singletonPoints}`;
  }).join("");
  trendState = {
    series, definitions, primary, width, height, pad, minValue, maxValue,
    plotW, plotH, metric: trendMetric, mode: trendMode,
  };
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.innerHTML = `<defs>
      <linearGradient id="ratioFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#147960" stop-opacity=".16"/><stop offset="1" stop-color="#147960" stop-opacity="0"/></linearGradient>
    </defs>
    ${missingBands}${grid}${meanY == null ? "" : `<line class="chart-mean" x1="${pad.left}" x2="${width - pad.right}" y1="${meanY}" y2="${meanY}"/>`}
    ${selection}
    ${linePaths}
    ${hits}${currentPoints}${labels}`;
}

function showTooltip(event) {
  if (!trendState) return;
  const svg = $("trend");
  const tooltip = $("chart-tooltip");
  const rect = svg.getBoundingClientRect();
  const scale = trendState.width / rect.width;
  const relativeX = (event.clientX - rect.left) * scale;
  const {
    series, primary, pad, plotW, plotH, minValue, maxValue,
  } = trendState;
  const index = Math.round((relativeX - pad.left) / Math.max(1, plotW) * (series.length - 1));
  if (index < 0 || index >= series.length) { tooltip.hidden = true; return; }
  const item = series[index];
  const detail = item.detail || {};
  const dateText = trendState.mode === "daily"
    ? item.key
    : hourLabel(Number(item.key));
  const coverage = trendMode === "daily" && detail.expected_hours
    ? ` · ${siteCoverageLabel(detail)}`
    : "";
  if (item.missing) {
    tooltip.innerHTML = `<strong>矿箱数据缺失</strong><span>${esc(dateText)}<br>该小时没有被矿机小时汇总覆盖，不代表功率为 0 kW</span>`;
  }
  else if (trendState.metric === "ratio") {
    tooltip.innerHTML = `<strong>${fmtRatio(item.ratio)} W/TH</strong><span>${esc(dateText)}${esc(coverage)}<br>矿箱整体功耗比样本 ${detail.power_ratio_sample_count ?? "—"} / ${detail.machine_count ?? "—"}</span>`;
  }
  else {
    const meterLabel = trendState.mode === "daily"
      ? "当日电表平均功率" : "该 UTC 小时电表实测功率";
    const actualLabel = trendState.mode === "daily"
      ? "当日矿箱平均功率" : "该 UTC 小时矿箱实际功率";
    const peakHourText = finite(item.meterPeakHour)
      ? ` · 峰值小时 ${hourOnlyLabel(Number(item.meterPeakHour))}`
      : "";
    tooltip.innerHTML = `<span>${esc(dateText)}${esc(coverage)}</span>
      <div class="tooltip-series">
        <span><i style="color:#176b58"></i>${esc(meterLabel)}</span><b>${fmt(item.meterPower)} kW</b>
        <span><i style="color:#477b9d"></i>${esc(actualLabel)}</span><b>${fmt(item.actualPower)} kW</b>
        <span><i style="color:#d95836"></i>当日电表最大功率</span><b>${fmt(item.meterPeakPower)} kW${peakHourText}</b>
      </div>`;
  }
  const x = pad.left + (series.length === 1 ? plotW / 2 : plotW * index / (series.length - 1));
  const primaryValue = chartNumber(primary, item)
    ?? trendState.definitions
      .map(definition => chartNumber(definition, item))
      .find(value => value != null);
  const yPos = primaryValue == null ? pad.top
    : pad.top + plotH * (1 - (primaryValue - minValue) / (maxValue - minValue));
  tooltip.style.left = `${Math.max(75, Math.min(rect.width - 75, x / scale))}px`;
  tooltip.style.top = `${yPos / scale - 8}px`;
  tooltip.hidden = false;
}

async function selectDate(date, preferredHour) {
  const token = ++dayRequestVersion;
  const siteId = currentSite()?.data_center_id;
  const previousDate = selectedDate;
  const previousHour = $("hour").value;
  selectedDate = date;
  $("date").value = date;
  populateHours();
  if (preferredHour != null) {
    const candidate = [...hours].reverse().find(hour => hour <= preferredHour);
    if (candidate) $("hour").value = candidate;
  }
  const daily = dailyFor(date);
  $("meta").textContent = `${catalog.date_range.start} 至 ${catalog.date_range.end} · 数据时区 ${DATA_TIMEZONE} · 正在读取 ${date} · ${siteCoverageLabel(daily)} · ${currentSite().warehouses_with_data} 个矿箱`;
  const hour = Number($("hour").value);
  setLoading(true, `正在加载 ${hourLabel(hour)} 的数据，请稍候…`);
  try {
    const payload = await loadHour(siteId, date, hour);
    if (token !== dayRequestVersion) return;
    dayData = payload;
    setLoading(false);
    render();
  } catch (error) {
    if (token !== dayRequestVersion) return;
    if (previousDate) {
      selectedDate = previousDate;
      $("date").value = previousDate;
      populateHours();
      if (previousHour && hours.includes(Number(previousHour))) {
        $("hour").value = previousHour;
      }
    }
    setLoading(false);
    $("meta").textContent = "当日数据读取失败";
    $("notice").textContent = "日期数据加载超时或暂时无法读取，请检查网络后重新选择该日期。";
    console.error(error);
  }
}

async function selectHour(hour) {
  const token = ++dayRequestVersion;
  const siteId = currentSite()?.data_center_id;
  const previousHour = Number($("hour").value);
  $("hour").value = hour;
  setLoading(true, `正在加载 ${hourLabel(hour)} 的数据，请稍候…`);
  try {
    const payload = await loadHour(siteId, selectedDate, hour);
    if (token !== dayRequestVersion) return;
    dayData = payload;
    setLoading(false);
    render();
  } catch (error) {
    if (token !== dayRequestVersion) return;
    $("hour").value = previousHour;
    setLoading(false);
    $("notice").textContent = "该小时数据加载超时或暂时无法读取，请检查网络后重试。";
    console.error(error);
  }
}

function bindChart() {
  const svg = $("trend");
  svg.addEventListener("pointermove", showTooltip);
  svg.addEventListener("pointerleave", () => { $("chart-tooltip").hidden = true; });
  svg.addEventListener("click", async event => {
    const target = event.target.closest("[data-chart-key]");
    if (!target) return;
    $("chart-tooltip").hidden = true;
    if (trendMode === "daily") {
      await selectDate(target.dataset.chartKey, Number($("hour").value));
    } else {
      await selectHour(Number(target.dataset.chartKey));
    }
  });
  svg.addEventListener("keydown", async event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target.closest("[data-chart-key]");
    if (!target) return;
    event.preventDefault();
    if (trendMode === "daily") {
      await selectDate(target.dataset.chartKey, Number($("hour").value));
    } else {
      await selectHour(Number(target.dataset.chartKey));
    }
  });
}

async function fetchGzipJson(url, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw Error("数据读取失败");
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    if (typeof DecompressionStream === "undefined") {
      throw Error("浏览器不支持压缩数据读取");
    }
    const stream = new Blob([buffer]).stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).json();
  } catch (error) {
    if (error.name === "AbortError") {
      throw Error("数据加载超时，请重试");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function loadDayTrend(siteId, date) {
  const cacheKey = `${siteId}/${date}`;
  if (dayTrendCache.has(cacheKey)) return dayTrendCache.get(cacheKey);
  const version = encodeURIComponent(
    catalog?.data_version || catalog?.exported_at || catalog?.latest_date,
  );
  const promise = fetchGzipJson(
    `data/days/${siteId}-${compactDate(date)}.json.gz?v=${version}`,
  );
  dayTrendCache.set(cacheKey, promise);
  promise.catch(() => dayTrendCache.delete(cacheKey));
  return promise;
}

function meterTrendHours(dayPayload, warehouseId, date) {
  const expectedDate = compactDate(date);
  const slots = Array.from({ length: expectedHoursPerDay }, () => null);
  const [year, month, day] = date.split("-").map(Number);
  for (const row of dayPayload?.warehouse_rows || []) {
    const hourText = String(row.hour ?? "");
    if (row.warehouse_id !== warehouseId
      || !hourText.startsWith(expectedDate)) {
      continue;
    }
    const hourIndex = Number(hourText.slice(-2));
    const meterPower = finite(row.meter_power_kw)
      ? Number(row.meter_power_kw) : null;
    const actualPower = finite(row.actual_power_kw)
      ? Number(row.actual_power_kw) : null;
    if (hourIndex < 0 || hourIndex >= expectedHoursPerDay
      || (meterPower == null && actualPower == null)) continue;
    const exactHourMs = Date.UTC(year, month - 1, day, hourIndex);
    const recordedAtMs = Date.parse(row.meter_recorded_at);
    const distance = Number.isFinite(recordedAtMs)
      ? Math.abs(recordedAtMs - exactHourMs) : Number.POSITIVE_INFINITY;
    const previous = slots[hourIndex];
    if (previous && previous.distance <= distance) continue;
    slots[hourIndex] = {
      hour: Number(row.hour),
      hourIndex,
      meterPower,
      recordedAt: row.meter_recorded_at || null,
      sampleLabel: row.meter_recorded_at
        ? timestampLabel(row.meter_recorded_at, true) : null,
      actualPower,
      distance,
    };
  }
  return slots;
}

function renderMeterTrendLoading(message) {
  $("meter-trend-summary").innerHTML =
    `<p class="meter-trend-state">${esc(message)}</p>`;
  $("meter-trend-note").textContent = "";
  $("meter-trend-tooltip").hidden = true;
  const svg = $("meter-trend-chart");
  svg.innerHTML = `<text class="meter-trend-empty" x="50%" y="48%" text-anchor="middle">${esc(message)}</text>`;
}

function renderMeterTrendSummary(state) {
  const averageNote = state.sampleCount
    ? `有效 ${state.sampleCount}/${expectedHoursPerDay} 小时`
    : "当日无有效电表小时";
  const peakNote = state.peakPoint
    ? `峰值 ${hourOnlyLabel(state.peakPoint.hour)}`
    : "峰值小时未记录";
  const actualNote = state.actualSampleCount
    ? `有效 ${state.actualSampleCount}/${expectedHoursPerDay} 小时均值`
    : "当日无有效实际功率小时";
  $("meter-trend-summary").innerHTML = `
    <div class="meter-trend-stat" data-meter-trend-stat="average">
      <span><i class="meter-trend-swatch average"></i>当日电表平均功率</span>
      <strong>${fmt(state.averagePower)}<small>kW</small></strong>
      <em>${esc(averageNote)}</em>
    </div>
    <div class="meter-trend-stat" data-meter-trend-stat="peak">
      <span><i class="meter-trend-swatch peak"></i>当日电表最大功率</span>
      <strong>${fmt(state.peakPower)}<small>kW</small></strong>
      <em>${esc(peakNote)}</em>
    </div>
    <div class="meter-trend-stat" data-meter-trend-stat="actual">
      <span><i class="meter-trend-swatch actual"></i>矿箱小时实际功率</span>
      <strong>${fmt(state.averageActualPower)}<small>kW</small></strong>
      <em>${esc(actualNote)}</em>
    </div>`;
}

function renderMeterTrendChart(state) {
  const svg = $("meter-trend-chart");
  const tooltip = $("meter-trend-tooltip");
  const meterValues = state.hours
    .filter(Boolean)
    .map(point => point.meterPower)
    .filter(value => Number.isFinite(Number(value)));
  const actualValues = state.hours
    .filter(Boolean)
    .map(point => point.actualPower)
    .filter(value => Number.isFinite(Number(value)));
  if (!meterValues.length && !actualValues.length) {
    tooltip.hidden = true;
    svg.innerHTML = `<text class="meter-trend-empty" x="50%" y="48%" text-anchor="middle">当日没有可绘制的功率小时数据</text>`;
    return;
  }
  const width = Math.max(320, svg.parentElement.clientWidth);
  const height = 286;
  const pad = { left: 56, right: 18, top: 20, bottom: 34 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const scaleValues = [
    ...meterValues,
    ...actualValues,
    state.peakPower,
  ].map(Number).filter(Number.isFinite);
  const rawLow = Math.min(...scaleValues);
  const rawHigh = Math.max(...scaleValues);
  const scaleSpan = rawHigh - rawLow || Math.max(rawHigh * 0.05, 1);
  const minValue = rawLow === 0 ? 0 : Math.max(0, rawLow - scaleSpan * 0.1);
  const maxValue = rawHigh + scaleSpan * 0.1;
  const x = index => pad.left + plotW * index / (expectedHoursPerDay - 1);
  const y = value => pad.top
    + plotH * (1 - (Number(value) - minValue) / (maxValue - minValue));
  const grid = [0, 1, 2, 3].map(index => {
    const value = maxValue - (maxValue - minValue) * index / 3;
    const yPos = pad.top + plotH * index / 3;
    return `<line class="meter-trend-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${yPos}" y2="${yPos}"/>
      <text class="meter-trend-axis" x="0" y="${yPos + 3}">${fmt(value)} kW</text>`;
  }).join("");
  const missingBands = state.hours.map((point, index) => {
    if (point) return "";
    const half = plotW / (expectedHoursPerDay - 1) / 2;
    return `<rect class="meter-trend-missing" x="${Math.max(pad.left, x(index) - half)}"
      y="${pad.top}" width="${Math.max(1, half * 2)}" height="${plotH}"/>`;
  }).join("");
  const references = finite(state.peakPower)
    ? `<line class="meter-trend-reference peak" x1="${pad.left}" x2="${width - pad.right}"
      y1="${y(state.peakPower)}" y2="${y(state.peakPower)}">
      <title>当日电表最大功率 ${fmt(state.peakPower)} kW</title></line>`
    : "";
  const meterPoints = state.hours.map((point, index) =>
    point && finite(point.meterPower) ? [x(index), y(point.meterPower)] : null
  );
  const actualPoints = state.hours.map((point, index) =>
    point && finite(point.actualPower) ? [x(index), y(point.actualPower)] : null
  );
  const meterPaths = chartSegments(meterPoints).map(segment =>
    segment.length > 1
      ? `<path class="meter-trend-line meter" d="${chartPath(segment)}"/>`
      : ""
  ).join("");
  const actualPaths = chartSegments(actualPoints).map(segment =>
    segment.length > 1
      ? `<path class="meter-trend-line actual" d="${chartPath(segment)}"/>`
      : ""
  ).join("");
  const pointMarks = state.hours.map((point, index) => point
    ? `${finite(point.meterPower)
      ? `<circle class="meter-trend-point meter" cx="${x(index)}" cy="${y(point.meterPower)}" r="3">
          <title>${fmt(point.meterPower)} kW · 采样时间 ${point.sampleLabel}</title>
        </circle>`
      : ""}${finite(point.actualPower)
      ? `<circle class="meter-trend-point actual" cx="${x(index)}" cy="${y(point.actualPower)}" r="2.6">
          <title>矿箱小时实际功率 ${fmt(point.actualPower)} kW</title>
        </circle>`
      : ""}`
    : "").join("");
  const hitWidth = plotW / Math.max(expectedHoursPerDay - 1, 1);
  const hits = state.hours.map((point, index) => {
    const left = Math.max(pad.left, x(index) - hitWidth / 2);
    const right = Math.min(width - pad.right, x(index) + hitWidth / 2);
    const description = point
      ? [
          finite(point.meterPower)
            ? `电表小时实测功率 ${fmt(point.meterPower)} kW，采样时间 ${point.sampleLabel}`
            : "",
          finite(point.actualPower)
            ? `矿箱小时实际功率 ${fmt(point.actualPower)} kW`
            : "",
        ].filter(Boolean).join("，")
      : "该小时无电表和矿机小时功率数据";
    return `<rect class="meter-trend-hit" data-meter-trend-hour="${index}"
      x="${left}" y="${pad.top}" width="${Math.max(1, right - left)}"
      height="${plotH}" tabindex="0" role="button"
      aria-label="${esc(`${String(index).padStart(2, "0")}:00 UTC+0，${description}`)}"></rect>`;
  }).join("");
  const selectedIndex = Number.isInteger(state.hoveredHourIndex)
    ? state.hoveredHourIndex : null;
  const selectedPoint = selectedIndex == null
    ? null : state.hours[selectedIndex];
  const selectedLine = selectedIndex == null ? ""
    : `<line class="meter-trend-selected-line" x1="${x(selectedIndex)}"
      x2="${x(selectedIndex)}" y1="${pad.top}" y2="${pad.top + plotH}"/>`;
  const selectedPower = finite(selectedPoint?.meterPower)
    ? selectedPoint.meterPower : selectedPoint?.actualPower;
  const selectedMarks = selectedPoint && finite(selectedPower)
    ? `<circle class="meter-trend-selected-halo"
        cx="${x(selectedIndex)}" cy="${y(selectedPower)}" r="8"/>
      <circle class="meter-trend-selected-point"
        cx="${x(selectedIndex)}" cy="${y(selectedPower)}" r="4.2"/>`
    : "";
  const tickHours = [0, 6, 12, 18, 23];
  const labels = tickHours.map(index =>
    `<text class="meter-trend-hour" x="${x(index)}" y="${height - 8}"
      text-anchor="${index === 0 ? "start" : index === 23 ? "end" : "middle"}">${String(index).padStart(2, "0")}:00</text>`
  ).join("");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.innerHTML = `${missingBands}${grid}${references}${actualPaths}${meterPaths}${pointMarks}
    ${selectedLine}${selectedMarks}${labels}${hits}`;

  if (selectedIndex == null) {
    tooltip.hidden = true;
    return;
  }
  tooltip.innerHTML = selectedPoint
    ? `<div class="meter-trend-tooltip-head">${finite(selectedPoint.meterPower) ? "采样时间" : "小时"}</div>
      <div class="meter-trend-tooltip-time">${esc(
        finite(selectedPoint.meterPower)
          ? selectedPoint.sampleLabel
          : `${String(selectedIndex).padStart(2, "0")}:00 UTC+0`,
      )}</div>
      <div class="meter-trend-tooltip-grid">
        <span>电表小时实测功率</span><b>${finite(selectedPoint.meterPower) ? `${fmt(selectedPoint.meterPower)} kW` : "未采集"}</b>
        <span>矿箱小时实际功率</span><b>${finite(selectedPoint.actualPower) ? `${fmt(selectedPoint.actualPower)} kW` : "未采集"}</b>
      </div>`
    : `<div class="meter-trend-tooltip-head">该小时无功率数据</div>
      <div class="meter-trend-tooltip-time">${String(selectedIndex).padStart(2, "0")}:00 UTC+0</div>`;
  tooltip.hidden = false;
  tooltip.style.left = "0px";
  tooltip.style.top = "0px";
  const displayedWidth = svg.getBoundingClientRect().width || width;
  const displayedHeight = svg.getBoundingClientRect().height || height;
  const tooltipWidth = tooltip.offsetWidth;
  const tooltipHeight = tooltip.offsetHeight;
  const anchorX = x(selectedIndex) * displayedWidth / width;
  const anchorY = (finite(selectedPower)
    ? y(selectedPower)
    : pad.top + plotH / 2) * displayedHeight / height;
  const preferredLeft = anchorX + tooltipWidth + 28 < displayedWidth
    ? anchorX + 12 : anchorX - tooltipWidth - 12;
  tooltip.style.left = `${Math.max(
    10, Math.min(displayedWidth - tooltipWidth - 10, preferredLeft),
  )}px`;
  tooltip.style.top = `${Math.max(
    10,
    Math.min(
      displayedHeight - tooltipHeight - 10,
      anchorY - tooltipHeight / 2,
    ),
  )}px`;
}

function renderMeterTrend(state) {
  $("meter-trend-title").textContent =
    `${state.warehouseName} · 当日电表功率趋势`;
  $("meter-trend-meta").textContent =
    `${state.siteName} · ${state.date} · 数据时区 ${DATA_TIMEZONE} · 小时按整点归属，采样时间标在数据点中`;
  $("meter-trend-chart").setAttribute(
    "aria-label",
    `${state.siteName} ${state.warehouseName} ${state.date} 当日电表功率趋势`,
  );
  renderMeterTrendSummary(state);
  renderMeterTrendChart(state);
  $("meter-trend-note").textContent =
    `当日电表平均功率按有效小时算术平均；矿箱小时实际功率为矿机小时平均功耗按矿箱汇总；缺失小时不补 0，折线在该小时断开。`;
}

function openMeterTrend(warehouseId, warehouseName) {
  const site = currentSite();
  if (!site || !warehouseId) return;
  const warehouse = warehouses.find(item =>
    item.data_center_id === site.data_center_id
    && item.warehouse_id === warehouseId
  );
  const requestVersion = ++meterTrendRequestVersion;
  meterTrendState = {
    siteName: site.data_center_name,
    date: selectedDate,
    warehouseId,
    warehouseName: warehouse?.warehouse_name || warehouseName,
  };
  $("meter-trend-title").textContent =
    `${meterTrendState.warehouseName} · 当日电表功率趋势`;
  $("meter-trend-meta").textContent =
    `${site.data_center_name} · ${selectedDate} · 数据时区 ${DATA_TIMEZONE}`;
  renderMeterTrendLoading("正在读取当日电表数据…");
  if (!$("meter-trend").open) $("meter-trend").showModal();
  iconize();
  loadDayTrend(site.data_center_id, selectedDate)
    .then(dayPayload => {
      if (requestVersion !== meterTrendRequestVersion || !$("meter-trend").open) {
        return;
      }
      const hours = meterTrendHours(
        dayPayload,
        meterTrendState.warehouseId,
        meterTrendState.date,
      );
      const meterPoints = hours.filter(point => finite(point?.meterPower));
      const actualPoints = hours.filter(point => finite(point?.actualPower));
      const peakPoint = meterPoints.reduce((best, point) =>
        !best || point.meterPower > best.meterPower ? point : best
      , null);
      meterTrendState = {
        ...meterTrendState,
        hours,
        hoveredHourIndex: null,
        sampleCount: meterPoints.length,
        averagePower: meterPoints.length
          ? meterPoints.reduce((total, point) => total + point.meterPower, 0)
            / meterPoints.length
          : null,
        actualSampleCount: actualPoints.length,
        averageActualPower: actualPoints.length
          ? actualPoints.reduce((total, point) => total + point.actualPower, 0)
            / actualPoints.length
          : null,
        peakPoint,
        peakPower: peakPoint?.meterPower ?? null,
      };
      renderMeterTrend(meterTrendState);
    })
    .catch(error => {
      if (requestVersion !== meterTrendRequestVersion || !$("meter-trend").open) {
        return;
      }
      renderMeterTrendLoading("电表数据读取失败，请关闭后重试");
      $("meter-trend-note").textContent =
        "电表小时数据未加载，当前不会用 0 kW 代替缺失数据。";
      console.error(error);
    });
}

function closeMeterTrend() {
  meterTrendRequestVersion++;
  $("meter-trend-tooltip").hidden = true;
  if ($("meter-trend").open) $("meter-trend").close();
}

function detailContextKey(context) {
  return `${context.dataCenterId}/${compactDate(context.date)}/${context.warehouseId}`;
}

function fetchDetailPackage(kind, context) {
  const cache = kind === "machines"
    ? detailMachineCache : detailSummaryCache;
  const key = detailContextKey(context);
  if (!cache.has(key)) {
    const filename = `${context.warehouseId}.${kind}.json.gz`;
    const version = encodeURIComponent(
      catalog.data_version || catalog.exported_at || catalog.latest_date,
    );
    const url = `data/details/${context.dataCenterId}/${compactDate(context.date)}/${filename}?v=${version}`;
    const pending = fetchGzipJson(url).catch(error => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
  }
  return cache.get(key);
}

function detailMetricGroup(key, title, note, metrics) {
  return `<section class="detail-metric-group" data-detail-group="${esc(key)}">
    <div class="detail-group-head">
      <strong>${esc(title)}</strong>
      <span>${esc(note)}</span>
    </div>
    <div class="detail-metric-grid">
      ${metrics.map(item => metric(
        item.label, item.value, item.unit, item.note,
      )).join("")}
    </div>
  </section>`;
}

function renderDetailSummary(row) {
  $("detail-title").textContent = `${row.warehouse_name} · 矿箱详情`;
  const reporting = finite(row.lark_power?.mounted_machine_count)
    ? ` · 上报 ${row.machine_count}/${fmt(row.lark_power.mounted_machine_count, 0)} 台`
    : "";
  $("detail-meta").textContent = `${row.data_center_name} · 采样时间 ${machineSampleLabel(row)} · 本箱覆盖 ${coverageLabel(warehouseHours(row.warehouse_id))}${reporting}`;
  const gap = powerGap(row);
  const gapLabel = gap?.value === 0
    ? "达到矿箱理论功率"
    : gap?.over ? "超出矿箱理论功率" : "矿箱理论功率余量";
  const meterPower = Number(row.meter_power_kw);
  const meterPowerAvailable = Number.isFinite(meterPower);
  const actualPower = Number(row.actual_power_kw);
  const meterDelta = meterPowerAvailable && Number.isFinite(actualPower)
    ? meterPower - actualPower : null;
  const meterNote = !meterPowerAvailable
    ? "本小时无电表记录"
    : meterDelta == null
      ? "本小时只有电表数据"
      : Math.abs(meterDelta) < 0.05
    ? "电表独立实测口径"
        : `电表独立实测口径 · 较矿机小时汇总 ${meterDelta > 0 ? "+" : "−"}${fmt(Math.abs(meterDelta))} kW`;
  const meterSampleNote = meterPowerAvailable && row.meter_recorded_at
    ? `电表采样 ${timestampLabel(row.meter_recorded_at, true)}`
    : "";
  const sampleTime = machineSampleLabel(row);
  const missingTemplateCount = (row.templates || []).reduce(
    (total, item) => total + (item.template_id ? 0 : Number(item.machine_count || 0)),
    0,
  );
  $("detail-metrics").innerHTML = detailMetricGroup(
    "warehouse",
    "矿箱层面指标",
    `采样时间 ${sampleTime}`,
    [
      {
        label: "矿箱小时实际功率",
        value: fmt(row.actual_power_kw),
        unit: "kW",
        note: "矿机小时平均功耗汇总",
      },
      {
        label: "矿箱电表小时实测功率",
        value: meterPowerAvailable ? fmt(meterPower) : "—",
        unit: meterPowerAvailable ? "kW" : "",
        note: [meterNote, meterSampleNote].filter(Boolean).join(" · "),
      },
      {
        label: gap ? gapLabel : "矿箱理论功率差值",
        value: gap ? fmt(Math.abs(gap.value)) : "—",
        unit: "kW",
        note: `矿箱理论功率 ${fmt(row.theoretical_power_kw)} kW − 矿箱小时实际功率`,
      },
      {
        label: "矿箱小时整体功耗比",
        value: fmtRatio(row.power_ratio_overall_w_per_th),
        unit: "W/TH",
        note: `有效样本 ${row.power_ratio_sample_count ?? "—"} / 运行矿机 ${row.machine_count ?? "—"} 台`,
      },
      {
        label: "本小时运行矿机数量 / 算力组数量",
        value: `${row.machine_count ?? "—"} / ${row.template_count ?? "—"}`,
        unit: "台 / 组",
        note: missingTemplateCount
          ? `${fmt(missingTemplateCount, 0)} 台矿机的算力组 ID 未记录`
          : "按去重 IP 与算力组统计",
      },
      {
        label: "矿箱内矿机小时平均温度 / 最高温度",
        value: `${fmt(row.temperature_avg_c)} / ${fmt(row.temperature_max_c)}`,
        unit: "°C",
        note: "矿箱内矿机温度，单位 °C",
      },
      {
        label: "矿箱小时平均拒绝率 / 最高拒绝率",
        value: `${percent(row.rejected_rate_avg)} / ${percent(row.rejected_rate_max)}`,
        unit: "",
        note: "按矿机小时样本汇总",
      },
    ],
  ) + detailMetricGroup(
    "machine",
    "矿机层面指标",
    `当前采样单机均值 · ${sampleTime}`,
    [
      {
        label: "单机小时平均算力",
        value: fmt(row.avg_hashrate_ths),
        unit: "TH/s",
        note: "当前小时矿机算术平均",
      },
      {
        label: "单机小时平均功耗",
        value: fmt(row.avg_power_w),
        unit: "W",
        note: "当前小时矿机算术平均",
      },
      {
        label: "单机理论平均功率",
        value: fmt(row.lark_power?.unit_theoretical_power_kw, 2),
        unit: "kW",
        note: "Lark-OM表配置",
      },
      {
        label: "单机小时平均功耗比",
        value: fmtRatio(row.power_ratio_avg_w_per_th),
        unit: "W/TH",
        note: "按有效单机功耗与算力样本平均",
      },
    ],
  );
  const capacityPanel = larkPanelHTML(row);
  $("detail-capacity").innerHTML = capacityPanel
    ? `<h3>容量与负荷</h3>${capacityPanel}`
    : `<p class="capacity-empty">该矿箱暂未匹配容量数据。</p>`;
}

function machinePeakCardsHTML(row) {
  const card = ({
    key, kicker, power, ip, model, workMode, note, hashrate, ratio,
    temperature, rejectedRate, factPrefix = "",
  }) => {
    const available = finite(power);
    return `<article class="machine-peak-card ${esc(key)}${available ? "" : " empty"}"
      data-machine-peak-card="${esc(key)}">
      <div class="machine-peak-card-head">
        <div>
          <span>${esc(kicker)}</span>
          <strong>${esc(ip || "IP 未记录")}</strong>
          <em>${esc(model || "型号未记录")} · 档位 ${esc(workMode || "未记录")}</em>
        </div>
        <div class="machine-peak-card-power">
          <strong>${fmt(power)}<small>W</small></strong>
          <span>${esc(note)}</span>
        </div>
      </div>
      <div class="machine-peak-card-facts">
        <span>${factPrefix}单机小时平均算力<b>${fmt(hashrate)} TH/s</b></span>
        <span>${factPrefix}单机功耗比<b>${fmtRatio(ratio)} W/TH</b></span>
        <span>${factPrefix}单机温度<b>${fmt(temperature)} °C</b></span>
        <span>${factPrefix}单机拒绝率<b>${percent(rejectedRate)}</b></span>
      </div>
    </article>`;
  };
  return `<div class="machine-peak-grid" aria-label="矿机峰值指标">
    ${card({
      key: "hour-peak",
      kicker: "当日单机小时峰值功率矿机",
      power: row.machine_hour_peak_power_w,
      ip: row.machine_hour_peak_ip,
      model: row.machine_hour_peak_model,
      workMode: row.machine_hour_peak_work_mode,
      note: finite(row.machine_hour_peak_hour)
        ? `发生小时 ${hourOnlyLabel(row.machine_hour_peak_hour)}`
        : "当日无有效矿机小时样本",
      hashrate: row.machine_hour_peak_hashrate_ths,
      ratio: row.machine_hour_peak_ratio_w_per_th,
      temperature: row.machine_hour_peak_temperature_c,
      rejectedRate: row.machine_hour_peak_rejected_rate,
    })}
    ${card({
      key: "daily-average-peak",
      kicker: "矿箱内矿机当日平均功率峰值矿机",
      power: row.machine_daily_avg_peak_power_w,
      ip: row.machine_daily_avg_peak_ip,
      model: row.machine_daily_avg_peak_model,
      workMode: row.machine_daily_avg_peak_work_mode,
      note: finite(row.machine_daily_avg_peak_power_w)
        ? `按有效 ${row.machine_daily_avg_peak_valid_hours ?? "—"} 小时平均 · 最高功率小时 ${hourOnlyLabel(row.machine_daily_avg_peak_hour)}`
        : "当日暂无有效矿机小时样本",
      hashrate: row.machine_daily_avg_peak_hashrate_ths,
      ratio: row.machine_daily_avg_peak_ratio_w_per_th,
      temperature: row.machine_daily_avg_peak_temperature_c,
      rejectedRate: row.machine_daily_avg_peak_rejected_rate,
      factPrefix: "最高功率小时 · ",
    })}
  </div>`;
}

async function openDetail(id) {
  const warehouse = warehouses.find(item =>
    item.data_center_id === currentSite()?.data_center_id
    && item.warehouse_id === id
  );
  if (!warehouse) return;
  const row = {
    ...warehouse,
    ...(currentRows.find(item => item.warehouse_id === id) || {}),
    lark_power: larkRecordFor(warehouse, selectedDate),
  };
  if (!detailAvailable()) return;
  const token = ++requestVersion;
  detailData = null;
  detailSummaryRow = row;
  detailContext = {
    dataCenterId: row.data_center_id,
    date: selectedDate,
    warehouseId: row.warehouse_id,
    hour: Number(row.hour),
  };
  powerLimitFilter = "all";
  detailPowerLimitW = configuredPowerLimit(warehouse);
  level = "template_rows";
  renderDetailSummary(row);
  $("detail-focus").innerHTML = "";
  $("power-limit-panel").innerHTML = "";
  $("detail-search").value = "";
  $("detail").showModal();
  $("detail-content").innerHTML = "<p>正在读取矿箱明细…</p>";
  try {
    const summaryPayload = await fetchDetailPackage("summary", detailContext);
    if (token !== requestVersion) return;
    detailData = summaryPayload.hours[String(row.hour)];
    if (!detailData) throw Error("该小时没有明细");
    renderDetail();
  } catch (error) {
    if (token === requestVersion) {
      $("detail-content").innerHTML = `<p class="error">${esc(error.message || "明细读取失败")}</p>`;
    }
  }
}

async function ensureMachineRows() {
  if (!detailData || !detailContext) return false;
  if (Array.isArray(detailData.machine_rows)) return true;
  const token = requestVersion;
  $("detail-content").innerHTML = "<p>正在读取矿机明细…</p>";
  $("power-limit-panel").innerHTML = "";
  $("detail-focus").innerHTML = "";
  try {
    const payload = await fetchDetailPackage("machines", detailContext);
    if (token !== requestVersion) return false;
    const machineData = payload.hours[String(detailContext.hour)];
    if (!machineData) throw Error("该小时没有矿机明细");
    detailData = {
      ...detailData,
      machine_rows: machineData.machine_rows,
    };
    return true;
  } catch (error) {
    if (token === requestVersion) {
      $("detail-content").innerHTML = `<p class="error">${esc(error.message || "矿机明细读取失败")}</p>`;
    }
    return false;
  }
}

function primeDetail(id) {
  if (!detailAvailable()) return;
  const row = currentRows.find(item => item.warehouse_id === id);
  if (!row) return;
  const context = {
    dataCenterId: row.data_center_id,
    date: selectedDate,
    warehouseId: row.warehouse_id,
    hour: Number(row.hour),
  };
  fetchDetailPackage("summary", context).catch(() => {});
}

function renderPowerLimitPanel() {
  const panel = $("power-limit-panel");
  if (level !== "machine_rows" || !Array.isArray(detailData?.machine_rows)) {
    panel.innerHTML = "";
    return;
  }
  const states = (detailData.machine_rows || [])
    .map(machine => machinePowerState(machine))
    .filter(Boolean);
  const entries = [
    ["all", "全部矿机", (detailData.machine_rows || []).length],
    ["over100", "大于单机功耗上限（>100%）", states.filter(
      state => state.ratio > 1,
    ).length],
    ["range95to100", "占单机功耗上限（95%–100%）", states.filter(
      state => state.ratio >= 0.95 && state.ratio <= 1,
    ).length],
    ["below95", "占单机功耗上限（<95%）", states.filter(
      state => state.ratio < 0.95,
    ).length],
  ];
  panel.innerHTML = `<div class="power-limit-summary">
    <div class="power-limit-heading">
      <span>单机小时平均功耗上限</span>
      <strong>${fmt(detailPowerLimitW, 0)}<small>W</small></strong>
      <em>按单机小时平均功耗判定</em>
    </div>
    <div class="power-limit-options" role="group" aria-label="按单机功耗上限筛选">
      ${entries.map(([key, label, count]) => `
        <button type="button" data-power-limit="${key}"
          aria-pressed="${key === powerLimitFilter}">
          <span>${label}</span>
          <strong>${fmt(count, 0)}<small>台</small></strong>
        </button>`).join("")}
    </div>
  </div>`;
}

function renderDetail() {
  document.querySelectorAll("[data-level]").forEach(button =>
    button.setAttribute("aria-selected", button.dataset.level === level));
  if (!detailData) return;
  const search = $("detail-search").value.trim().toLowerCase();
  let sourceRows = [...(detailData[level] || [])];
  if (level === "model_rows") {
    sourceRows = mergeDetailRows(sourceRows, ["model"]);
  }
  else if (level === "work_mode_rows") {
    sourceRows = mergeDetailRows(sourceRows, ["model", "work_mode"]);
  }
  let rows = sourceRows.filter(row =>
    [row.template_name, row.template_id, row.model, row.work_mode, row.ip]
      .some(value => String(value ?? "").toLowerCase().includes(search)));
  if (level === "machine_rows" && powerLimitFilter !== "all") {
    rows = rows.filter(matchesPowerLimitFilter);
  }
  if (level === "machine_rows") {
    rows.sort((a, b) =>
      (b.avg_power_w ?? -Infinity) - (a.avg_power_w ?? -Infinity));
  }
  const columns = [];
  if (level === "template_rows") columns.push(["算力组", "template_name"]);
  else columns.push(["型号", "model"]);
  if (["work_mode_rows", "machine_rows"].includes(level)) columns.push(["档位", "work_mode"]);
  if (level === "machine_rows") columns.push(["IP", "ip"]);
  else columns.push(["矿机数", "machine_count"]);
  const detailScope = {
    template_rows: "本组",
    model_rows: "本型号",
    work_mode_rows: "本档位",
    machine_rows: "单机",
  }[level];
  const machineMetricSubject = level === "machine_rows"
    ? "单机" : `${detailScope}单机`;
  columns.push(
    [`${machineMetricSubject}小时平均算力 TH/s`, "avg_hashrate_ths"],
    [`${machineMetricSubject}小时平均功耗 W`, "avg_power_w"],
  );
  if (level === "machine_rows") {
    columns.push(
      ["单机功耗上限 W", "__power_limit_w"],
      ["占单机功耗上限", "__power_limit_ratio"],
      ["超单机功耗上限 W", "__power_over_w"],
    );
  }
  columns.push(
    [
      level === "machine_rows"
        ? "单机功耗比 W/TH" : `${detailScope}矿机样本整体功耗比 W/TH`,
      level === "machine_rows"
        ? "power_ratio_w_per_th" : "power_ratio_overall_w_per_th",
    ],
    [
      level === "machine_rows"
        ? "单机拒绝率" : `${detailScope}单机小时平均拒绝率`,
      level === "machine_rows" ? "rejected_rate" : "rejected_rate_avg",
    ],
    [
      level === "machine_rows"
        ? "单机温度 °C" : `${detailScope}单机小时平均温度 °C`,
      level === "machine_rows" ? "temperature_c" : "temperature_avg_c",
    ],
  );
  renderPowerLimitPanel();
  $("detail-focus").innerHTML = level === "machine_rows"
    ? machinePeakCardsHTML(detailSummaryRow || {})
    : "";
  $("detail-content").innerHTML = `<table><thead><tr>${columns.map(([label]) => `<th>${label}</th>`).join("")}</tr></thead><tbody>${rows.map(row => {
    const currentDetailHour = Number(detailContext?.hour);
    const isHourPeakMachine = level === "machine_rows"
      && row.ip === detailSummaryRow?.machine_hour_peak_ip
      && currentDetailHour === Number(detailSummaryRow?.machine_hour_peak_hour);
    const isDailyAveragePeakMachine = level === "machine_rows"
      && row.ip === detailSummaryRow?.machine_daily_avg_peak_ip
      && currentDetailHour === Number(detailSummaryRow?.machine_daily_avg_peak_hour);
    const powerState = level === "machine_rows"
      ? machinePowerState(row) : null;
    const rowClasses = [];
    if (isHourPeakMachine) rowClasses.push("hour-peak-machine-row");
    if (isDailyAveragePeakMachine) {
      rowClasses.push("daily-average-peak-machine-row");
    }
    if (powerState?.ratio > 1) rowClasses.push("machine-power-over-100");
    else if (powerState?.ratio >= 0.95) rowClasses.push("machine-power-95-to-100");
    else if (powerState) rowClasses.push("machine-power-below-95");
    const rowTitle = [
      isHourPeakMachine ? "本行也是当日单机小时峰值功率矿机" : "",
      isDailyAveragePeakMachine
        ? "本行也是矿箱内矿机当日平均功率峰值矿机的最高功率小时" : "",
    ].filter(Boolean).join("；");
    return `<tr class="${rowClasses.join(" ")}"${rowTitle ? ` title="${esc(rowTitle)}"` : ""}>${columns.map(([, key]) => {
      let value;
      if (key === "__power_limit_w") value = fmt(powerState?.limit, 0);
      else if (key === "__power_limit_ratio") {
        value = percent2(powerState == null ? null : powerState.ratio * 100);
      } else if (key === "__power_over_w") {
        value = powerState?.over
          ? `+${fmt(powerState.power - powerState.limit)}` : "—";
      } else {
        value = key.includes("rejected") ? percent(row[key])
          : key.includes("power_ratio") ? fmtRatio(row[key])
            : typeof row[key] === "number" ? fmt(row[key])
              : row[key] ?? "未记录";
      }
      return `<td>${esc(value)}</td>`;
    }).join("")}</tr>`;
  }).join("")}</tbody></table>${rows.length ? "" : "<p>没有符合条件的明细。</p>"}`;
}

$("hour").onchange = async () => {
  if ($("distribution").open) $("distribution").close();
  await selectHour(Number($("hour").value));
};
$("date").onchange = async () => {
  if ($("distribution").open) $("distribution").close();
  if ($("detail").open) {
    $("detail").close();
    requestVersion++;
  }
  $("search").value = "";
  await selectDate($("date").value);
};
$("site").onchange = async () => {
  if ($("distribution").open) $("distribution").close();
  if ($("detail").open) {
    $("detail").close();
    requestVersion++;
  }
  populateDates();
  $("search").value = "";
  await selectDate(selectedDate);
};
$("sort").onchange = render;
document.querySelectorAll('input[name="sort-order"]').forEach(input => {
  input.onchange = render;
});
$("search").oninput = render;
document.querySelectorAll("[data-load-filter]").forEach(button => {
  button.onclick = () => {
    loadFilter = button.dataset.loadFilter;
    document.querySelectorAll("[data-load-filter]").forEach(item =>
      item.setAttribute(
        "aria-pressed",
        item === button ? "true" : "false",
      ));
    render();
  };
});
$("cards").onclick = event => {
  const meterTrendButton = event.target.closest("[data-meter-trend-id]");
  if (meterTrendButton) {
    openMeterTrend(
      meterTrendButton.dataset.meterTrendId,
      meterTrendButton.dataset.meterTrendName,
    );
    return;
  }
  const distributionButton = event.target.closest("[data-distribution-id]");
  if (distributionButton) {
    openDistribution(distributionButton.dataset.distributionId);
    return;
  }
  const button = event.target.closest("[data-detail-id]");
  if (button) openDetail(button.dataset.detailId);
};
$("cards").addEventListener("pointerover", event => {
  if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) {
    return;
  }
  const button = event.target.closest("[data-detail-id]");
  if (button && !button.dataset.prefetched) {
    button.dataset.prefetched = "true";
    primeDetail(button.dataset.detailId);
  }
});
$("cards").addEventListener("focusin", event => {
  const button = event.target.closest("[data-detail-id]");
  if (button && !button.dataset.prefetched) {
    button.dataset.prefetched = "true";
    primeDetail(button.dataset.detailId);
  }
});
$("close").onclick = () => { $("detail").close(); requestVersion++; };
$("detail").addEventListener("cancel", () => requestVersion++);
$("distribution-close").onclick = () => $("distribution").close();
$("distribution").addEventListener("click", event => {
  if (event.target === $("distribution")) $("distribution").close();
});
$("distribution").addEventListener("close", () => {
  distributionWarehouseId = null;
});
$("distribution-detail").onclick = () => {
  const id = distributionWarehouseId;
  if (!id || !detailAvailable()) return;
  $("distribution").close();
  openDetail(id);
};
$("meter-trend-close").onclick = closeMeterTrend;
function hoverMeterTrendHourFromChart(target) {
  if (!meterTrendState?.hours || !target) return;
  const hourIndex = Number(target.dataset.meterTrendHour);
  if (!Number.isInteger(hourIndex)
    || hourIndex < 0 || hourIndex >= expectedHoursPerDay) return;
  if (meterTrendState.hoveredHourIndex === hourIndex) return;
  meterTrendState.hoveredHourIndex = hourIndex;
  renderMeterTrendChart(meterTrendState);
}
function clearMeterTrendHover() {
  if (!meterTrendState?.hours || meterTrendState.hoveredHourIndex == null) {
    return;
  }
  meterTrendState.hoveredHourIndex = null;
  renderMeterTrendChart(meterTrendState);
}
$("meter-trend-chart").addEventListener("pointermove", event => {
  hoverMeterTrendHourFromChart(
    event.target.closest("[data-meter-trend-hour]"),
  );
});
$("meter-trend-chart").addEventListener("pointerleave", clearMeterTrendHover);
$("meter-trend-chart").addEventListener("focusin", event => {
  hoverMeterTrendHourFromChart(
    event.target.closest("[data-meter-trend-hour]"),
  );
});
$("meter-trend-chart").addEventListener("focusout", event => {
  if (!event.relatedTarget || !$("meter-trend-chart").contains(event.relatedTarget)) {
    clearMeterTrendHover();
  }
});
$("meter-trend-chart").addEventListener("click", event => {
  hoverMeterTrendHourFromChart(
    event.target.closest("[data-meter-trend-hour]"),
  );
});
$("meter-trend-chart").addEventListener("keydown", event => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const target = event.target.closest("[data-meter-trend-hour]");
  if (!target) return;
  event.preventDefault();
  hoverMeterTrendHourFromChart(target);
});
$("meter-trend").addEventListener("click", event => {
  if (event.target === $("meter-trend")) closeMeterTrend();
});
$("meter-trend").addEventListener("cancel", () => {
  meterTrendRequestVersion++;
});
document.querySelectorAll("[data-level]").forEach(button => {
  button.onclick = async () => {
    const nextLevel = button.dataset.level;
    if (nextLevel === "machine_rows" && !Array.isArray(detailData?.machine_rows)) {
      level = nextLevel;
      document.querySelectorAll("[data-level]").forEach(item =>
        item.setAttribute("aria-selected", item === button));
      const loaded = await ensureMachineRows();
      if (loaded) renderDetail();
      return;
    }
    level = nextLevel;
    renderDetail();
  };
});
$("power-limit-panel").onclick = event => {
  const button = event.target.closest("[data-power-limit]");
  if (!button) return;
  powerLimitFilter = button.dataset.powerLimit;
  renderDetail();
};
document.querySelectorAll("[data-trend-mode]").forEach(button => {
  button.onclick = () => {
    trendMode = button.dataset.trendMode;
    document.querySelectorAll("[data-trend-mode]").forEach(item =>
      item.setAttribute("aria-pressed", item === button ? "true" : "false"));
    renderTrend();
  };
});
document.querySelectorAll("[data-trend-metric]").forEach(button => {
  button.onclick = () => {
    trendMetric = button.dataset.trendMetric;
    document.querySelectorAll("[data-trend-metric]").forEach(item =>
      item.setAttribute("aria-pressed", item === button ? "true" : "false"));
    renderTrend();
  };
});
$("detail-search").oninput = renderDetail;
window.addEventListener("resize", () => {
  if (dayData) renderTrend();
  if ($("meter-trend").open && meterTrendState?.hours) {
    renderMeterTrendChart(meterTrendState);
  }
});
bindChart();

(async () => {
  try {
    const response = await fetch(`data/catalog.json?v=${Date.now()}`);
    if (!response.ok) throw Error("目录读取失败");
    catalog = await response.json();
    sites = catalog.sites || [];
    warehouses = catalog.warehouses || [];
    if (!sites.length) throw Error("没有场地数据");
    populateSiteSelector();
    populateDates();
    if (!dates.length) throw Error("没有日期数据");
    await selectDate(selectedDate);
  } catch (error) {
    setLoading(false);
    $("meta").textContent = "看板数据读取失败";
    $("notice").textContent = "尚无可用数据，请检查导出及发布结果。";
    console.error(error);
  }
})();
