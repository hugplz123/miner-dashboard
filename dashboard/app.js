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
const hourLabel = hour => `${String(hour).slice(0, 4)}-${String(hour).slice(4, 6)}-${String(hour).slice(6, 8)} ${String(hour).slice(8)}:00`;
const expectedHoursPerDay = 24;
const palette = ["#3f8273", "#557fa4", "#bd9147", "#937190", "#b56e55", "#72906d", "#80795f", "#5f8790"];
let catalog, sites = [], warehouses = [], dates = [], hours = [], currentRows = [];
let selectedDate, dayData, detailData, detailBundle, level = "template_rows";
let requestVersion = 0, dayRequestVersion = 0, trendMode = "daily";
let trendMetric = "ratio", trendState = null, loadFilter = "all";
let distributionWarehouseId = null;
let powerLimitFilter = "all", detailPowerLimitW = null;
const hourCache = new Map();
const detailCache = new Map();

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

function powerMarginHTML(value, theory) {
  if (!finite(value) || !finite(theory) || Number(theory) <= 0) {
    return `<div class="overview-margin unavailable">
      <span>对应余量</span>
      <strong>—</strong>
      <em>暂无对应理论功率</em>
    </div>`;
  }
  const delta = Number(theory) - Number(value);
  const over = delta < 0;
  return `<div class="overview-margin${over ? " over" : ""}">
    <span>对应余量</span>
    <strong>${delta < 0 ? "−" : "+"}${fmt(Math.abs(delta))}<small>kW</small></strong>
    <em>理论 ${fmt(theory)} kW</em>
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
  const threshold = {
    over100: 1,
    over90: 0.9,
    over80: 0.8,
  }[powerLimitFilter];
  return state && Number.isFinite(threshold) && state.ratio > threshold;
}

function syncTimeLabel(value) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hour12: false,
  });
}

function dailyPeak(warehouseId) {
  if (!dayData) return null;
  return (dayData.warehouse_peaks || []).find(row =>
    row.data_center_id === currentSite()?.data_center_id
    && row.warehouse_id === warehouseId
  ) || null;
}

function dailyMachinePeak(payload) {
  let peak = null;
  for (const [hour, data] of Object.entries(payload?.hours || {})) {
    for (const machine of data.machine_rows || []) {
      const power = Number(machine.avg_power_w);
      if (!finite(power)) continue;
      if (!peak || power > Number(peak.machine.avg_power_w)) {
        peak = { hour: Number(hour), machine };
      }
    }
  }
  return peak;
}

function currentSite() {
  return sites.find(site => site.data_center_id === $("site").value);
}

function larkRecordFor(warehouse, date = selectedDate) {
  return warehouse?.lark_power_by_date?.[date] || null;
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
  const recorded = site?.warehouse_hours_by_date?.[date]?.[warehouseId];
  if (Array.isArray(recorded)) return recorded.length;
  return new Set(
    (dayData?.warehouse_rows || [])
      .filter(row => row.data_center_id === site?.data_center_id
        && row.warehouse_id === warehouseId
        && String(row.hour).startsWith(compactDate(date)))
      .map(row => row.hour),
  ).size;
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

function loadClass(row) {
  if (!row) return "no_hour";
  if (row.missing) return "no_hour";
  const load = Number(row.load_ratio);
  if (!finite(load) || !finite(row.theoretical_power_kw)
    || Number(row.theoretical_power_kw) <= 0) return "unclassified";
  if (load > 1) return "over";
  return "below";
}

function loadClassLabel(classification, row) {
  const load = Number(row?.load_ratio);
  return {
    over: "高于理论",
    below: load === 1 ? "达到理论 100%" : "低于理论",
    no_hour: "本小时无记录",
    unclassified: "理论功率缺失",
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
    return `<option value="${esc(date)}">${esc(date)} · 运行 ${esc(coverageLabel(observed, expected))} · 完整 ${esc(completeWarehouses ?? "—")}/${esc(totalWarehouses ?? "—")} 箱</option>`;
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
  const version = encodeURIComponent(catalog.exported_at || catalog.latest_date);
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
    const label = item[nameKey]
      || (nameKey === "template_name" ? "未分组" : "未记录");
    grouped.set(label, (grouped.get(label) || 0) + count);
  }
  const categories = [...grouped.entries()]
    .map(([label, count], index) => ({
      label,
      count,
      color: palette[index % palette.length],
    }))
    .sort((a, b) => b.count - a.count)
    .map((item, index) => ({
      ...item,
      color: palette[index % palette.length],
    }));
  const total = categories.reduce((value, item) => value + item.count, 0);
  return { categories, total, emptyLabel };
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
  return `<div class="distribution-trigger">
    <div class="distribution-trigger-copy">
      <span>箱内配置分布</span>
      <strong>${templates.categories.length} 个算力组 · ${workModes.categories.length} 个档位 · ${fmt(row.machine_count, 0)} 台矿机</strong>
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
    <div><span>算力组</span><strong>${templates.categories.length}</strong></div>
    <div><span>档位</span><strong>${workModes.categories.length}</strong></div>`;
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
  details.push(lark.available
    ? `Lark 使用 ${selectedDate} 当日快照。`
    : `${selectedDate} 没有 Lark 功率快照，不沿用其他日期。`);
  const element = $("coverage");
  element.className = `coverage-note ${
    complete ? "complete" : "incomplete"
  }`;
  element.dataset.complete = complete ? "true" : "false";
  element.innerHTML = `<strong>${
    complete ? "数据完整" : "数据不完整"
  }</strong><span>${esc(site.data_center_name)} · ${esc(details.join(" "))}</span>`;
}

function larkPanelHTML(row) {
  const lark = row.lark_power;
  if (!lark) {
    return `<div class="lark-power-panel unmatched snapshot-missing">
      <div class="lark-panel-head">
        <span>容量与负荷</span>
        <b>当日无快照</b>
      </div>
      <div class="lark-unmatched">${esc(selectedDate)} 没有 Lark 容量记录，未使用其他日期替代。</div>
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
  const capacityRow = (label, value) => {
    if (!finite(value)) {
      return `<div class="capacity-row missing"><span>${label}</span><strong>容量字段缺失</strong></div>`;
    }
    if (!finite(theory) || Number(theory) <= 0) {
      return `<div class="capacity-row"><span>${label}</span><strong>${fmt(value)}<small>kW</small></strong><em>缺少理论功率</em></div>`;
    }
    const width = Math.max(0, Math.min(100, Number(value) / Number(theory) * 100));
    const margin = Number(theory) - Number(value);
    const over = margin < 0;
    return `<div class="capacity-row${over ? " over" : ""}">
      <div class="capacity-copy">
        <span>${label}</span>
        <strong>${fmt(value)}<small>kW</small></strong>
        <em>${over ? `超理论 ${fmt(Math.abs(margin))}` : `余量 ${fmt(margin)}`} kW</em>
      </div>
      <div class="capacity-track" title="${label} ${fmt(value)} kW，理论功率 ${fmt(theory)} kW">
        <i style="width:${width}%"></i>
      </div>
    </div>`;
  };
  return `<div class="lark-power-panel">
    <div class="lark-panel-head">
      <span>容量刻度 · 理论 ${finite(theory) ? `${fmt(theory)} kW` : "未配置"}</span>
      <b>${status}</b>
    </div>
    <div class="capacity-grid">
      ${capacityRow("在架", lark.mounted_power_kw)}
      ${capacityRow("占位", lark.reserved_power_kw)}
    </div>
    <div class="lark-panel-foot">
      <span>在架 ${lark.mounted_machine_count ?? "—"} 台 · 占位 ${lark.occupied_slots ?? "—"}/${lark.total_slots ?? "—"}</span>
    </div>
  </div>`;
}

function peakHTML(row) {
  const peak = dailyPeak(row.warehouse_id);
  if (!peak) {
    return `<div class="peak-summary empty"><span>当日功率峰值</span><strong>暂无数据</strong></div>`;
  }
  const action = detailAvailable()
    ? `<div class="peak-actions">
      <button type="button" class="peak-action peak-hour-action" data-peak-hour-id="${esc(row.warehouse_id)}" title="查看矿箱当日总功率最高的小时">查看当日峰值<i data-lucide="arrow-up-right"></i></button>
      <button type="button" class="peak-action peak-machine-action" data-daily-machine-id="${esc(row.warehouse_id)}" title="扫描当日全部小时并查看平均功率最高的矿机">查看最大功率矿机<i data-lucide="arrow-up-right"></i></button>
    </div>`
    : `<div class="peak-actions"><button type="button" disabled title="历史日期只保留矿箱汇总">仅最新一天可查看</button></div>`;
  return `<div class="peak-summary">
    <div class="peak-summary-copy">
      <span>当日峰值</span>
      <strong>${fmt(peak.actual_power_kw)}<small>kW</small></strong>
      <em>${esc(String(peak.hour).slice(-2))}:00</em>
    </div>
    ${action}
  </div>`;
}

function cardHTML(row) {
  const observedHours = warehouseHours(row.warehouse_id);
  const boxComplete = observedHours === expectedHoursPerDay;
  const classification = loadClass(row);
  if (row.missing) {
    return `<article class="warehouse-card missing-card" data-warehouse-id="${esc(row.warehouse_id)}" data-load-class="no_hour">
      <div class="card-head"><div class="card-title"><strong>${esc(row.warehouse_name)}</strong><span class="status">本小时无记录</span></div></div>
      <span>没有可用于本小时汇总的矿机数据</span>
      <span class="missing-coverage${boxComplete ? "" : " warn"}">当日覆盖 ${esc(coverageLabel(observedHours))}</span>
    </article>`;
  }
  const hasTheory = finite(row.theoretical_power_kw) && finite(row.load_ratio);
  const overload = hasTheory && row.load_ratio > 1;
  const gap = powerGap(row);
  const loadPercent = hasTheory
    ? Math.max(0, Math.min(100, Number(row.load_ratio) * 100)) : null;
  const installedMachines = row.lark_power?.mounted_machine_count;
  const reportingIncomplete = finite(installedMachines)
    && Number(installedMachines) > Number(row.machine_count);
  const statusText = loadClassLabel(classification, row);
  const details = detailAvailable()
    ? `<button type="button" data-detail-id="${esc(row.warehouse_id)}" aria-label="查看 ${esc(row.warehouse_name)} 详情">详情<i data-lucide="arrow-up-right"></i></button>`
    : `<button type="button" disabled title="历史日期仅保留矿箱汇总，明细保留最新一天">仅汇总</button>`;
  const cardClasses = [
    "warehouse-card",
    overload ? "overload" : "",
    classification === "below" ? "below-theory" : "",
    hasTheory ? "" : "actual-only",
  ].filter(Boolean).join(" ");
  return `<article class="${cardClasses}" data-warehouse-id="${esc(row.warehouse_id)}" data-load-class="${esc(classification)}">
    <div class="card-head">
      <div class="card-title"><strong>${esc(row.warehouse_name)}</strong><span class="status status-${esc(classification)}">${esc(statusText)}</span></div>
      ${details}
    </div>
    <div class="power-block">
      <div class="power-label">当前实际功率${reportingIncomplete
        ? `<span class="reporting warn">上报 ${row.machine_count}/${installedMachines} 台</span>`
        : ""}</div>
      <div class="power-line">
        <span class="actual-power">${fmt(row.actual_power_kw)}<small>kW</small></span>
        ${hasTheory ? `<span class="power-reference">理论 ${fmt(row.theoretical_power_kw)} kW</span>` : ""}
      </div>
      ${hasTheory ? `<div class="power-comparison${gap?.over ? " over" : ""}">
        <div class="power-comparison-track"
          title="实际 ${fmt(row.actual_power_kw)} kW，理论 ${fmt(row.theoretical_power_kw)} kW，已用 ${fmt(row.load_ratio * 100)}%">
          <i style="width:${fmt(loadPercent, 2)}%"></i>
        </div>
        <div class="power-comparison-labels">
          <span>已用 ${fmt(row.load_ratio * 100)}%</span>
          <strong>${gap
            ? gap.value === 0
              ? "已达理论功率"
              : gap.over
                ? `超出理论 ${fmt(Math.abs(gap.value))} kW`
                : `剩余 ${fmt(gap.value)} kW`
            : "差值不可用"}</strong>
        </div>
      </div>` : ""}
    </div>
    ${larkPanelHTML(row)}
    <div class="card-glance">
      <div class="glance-item">
        <span>功耗比</span>
        <strong>${fmtRatio(row.power_ratio_overall_w_per_th)}<small>W/TH</small></strong>
      </div>
      <div class="glance-item">
        <span>运行矿机</span>
        <strong>${row.machine_count}<small>台</small></strong>
      </div>
    </div>
    ${distributionTriggerHTML(row)}
    ${peakHTML(row)}
    ${boxComplete ? "" : `<div class="card-alert"><span class="warehouse-hour-coverage warn">当日覆盖 ${esc(coverageLabel(observedHours))}</span></div>`}
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
  const activeWarehouseCount = siteWarehouses.length;
  const machineCount = sum(currentRows, "machine_count");
  const actualPower = sum(currentRows, "actual_power_kw");
  const theoryPower = siteTheoreticalPower(dailyFor(selectedDate, site))
    ?? sum(currentRows, "theoretical_power_kw");
  const validSamples = sum(currentRows, "power_ratio_sample_count");
  const lark = larkPowerSnapshot(site, selectedDate);
  const reportedBoxes = new Set(currentRows.map(row => row.warehouse_id)).size;
  const larkMatched = lark.matched;
  const larkMounted = lark.mountedPower;
  const larkReserved = lark.reservedPower;
  const daily = dailyFor(selectedDate, site);
  const observedHours = daily?.hours_with_data ?? daily?.hours?.length ?? hours.length;
  const expectedHours = daily?.expected_hours ?? expectedHoursPerDay;
  $("brand-mark").textContent = site.data_center_name.charAt(0).toUpperCase();
  $("brand-name").textContent = site.data_center_name;
  const trendLabel = trendMetric === "ratio" ? "功耗比趋势" : "功率趋势";
  $("trend-title").textContent = `${site.data_center_name} ${trendLabel}`;
  $("trend").setAttribute("aria-label", `${site.data_center_name} ${trendLabel}`);
  const warehouseCoverage = `${activeWarehouseCount} 个矿箱`;
  $("meta").textContent = `${catalog.date_range.start} 至 ${catalog.date_range.end} · 当前 ${selectedDate} · ${siteCoverageLabel(daily, site)} · ${warehouseCoverage}`;
  document.title = `${site.data_center_name} · 矿箱负荷`;
  renderCoverage(daily, site, lark);
  $("notice").textContent = lark.available
    ? `功率为矿机上报的小时平均值；Lark 使用 ${selectedDate} 当日快照，同步于 ${syncTimeLabel(lark.syncedAt)}。没有快照的日期不会沿用其他日期数据。`
    : `功率为矿机上报的小时平均值；${selectedDate} 没有 Lark 容量快照，因此不显示在架、占位和理论容量对比。`;
  $("metrics").innerHTML = `<div class="overview-power-grid">
      ${overviewMetric(
        "上报实际功率", fmt(actualPower), "kW",
        powerMarginHTML(actualPower, theoryPower),
        {
          key: "actual",
          scope: "当前小时",
          meta: `上报矿箱 <b>${reportedBoxes}/${activeWarehouseCount}</b> · 上报矿机 <b>${fmt(machineCount, 0)}${lark.available && finite(lark.mountedMachines) ? `/${fmt(lark.mountedMachines, 0)}` : ""}</b> 台`,
        },
      )}
      ${overviewMetric(
        "Lark 在架功率", fmt(larkMounted), "kW",
        powerMarginHTML(larkMounted, theoryPower),
        {
          key: "mounted",
          scope: lark.available ? "当日快照" : "无快照",
          meta: lark.available
            ? `快照覆盖 ${lark.mountedPowerCount}/${larkMatched} 箱`
            : "Lark 快照缺失",
        },
      )}
      ${overviewMetric(
        "Lark 占位功率", fmt(larkReserved), "kW",
        powerMarginHTML(larkReserved, theoryPower),
        {
          key: "reserved",
          scope: lark.available ? "当日快照" : "无快照",
          meta: lark.available
            ? `快照覆盖 ${lark.reservedPowerCount}/${larkMatched} 箱`
            : "Lark 快照缺失",
        },
      )}
    </div>
    <div class="overview-support">
      ${overviewSupportMetric(
        "小时覆盖", `${observedHours ?? "—"}/${expectedHours}`, "小时",
        `当前小时 ${String(hour).slice(-2)}:00`, "hour-coverage",
      )}
      ${overviewSupportMetric(
        "样本整体功耗比", fmtRatio(ratio(currentRows)), "W/TH",
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
      : { ...warehouse, lark_power: larkPower, hour, missing: true };
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
    available: "available_capacity_kw",
    power: "actual_power_kw",
  }[sort];
  rows.sort((a, b) => {
    if (sort === "name") {
      return b.warehouse_name.localeCompare(
        a.warehouse_name, undefined, { numeric: true },
      );
    }
    return ((b[sortKey] ?? -Infinity) - (a[sortKey] ?? -Infinity))
      || a.warehouse_name.localeCompare(
        b.warehouse_name, undefined, { numeric: true },
      );
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
    const complete = item.is_fully_complete ?? (
      item.is_complete ?? observed === expected
    );
    return {
      key: item.date,
      label: `${shortDate(item.date)}${complete ? "" : "*"}`,
      ratio: item.power_ratio_overall_w_per_th,
      actualPower: finite(item.actual_power_kw) && observed
        ? item.actual_power_kw / observed : null,
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
  const lark = larkPowerSnapshot(site, selectedDate);
  const theoryPower = siteTheoreticalPower();
  const recordedHours = new Set(hours.map(Number));
  const summaries = new Map(
    (dayData.hourly_summary || []).map(item => [Number(item.hour), item]),
  );
  return Array.from({ length: expectedHoursPerDay }, (_, index) => {
    const hour = Number(`${compactDate(selectedDate)}${String(index).padStart(2, "0")}`);
    const summary = summaries.get(hour);
    const hasData = recordedHours.has(hour);
    return {
      key: String(hour),
      label: `${String(hour).slice(-2)}:00`,
      ratio: summary?.power_ratio_overall_w_per_th ?? null,
      actualPower: hasData ? summary?.actual_power_kw ?? null : null,
      theoreticalPower: hasData ? theoryPower : null,
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
  const definitions = trendMetric === "ratio"
    ? [{
        key: "ratio",
        label: "功耗比",
        className: "ratio",
        unit: "W/TH",
        value: item => item.ratio,
        primary: true,
        area: true,
      }]
    : [
        {
          key: "actual",
          label: "实际功率",
          className: "actual",
          unit: "kW",
          value: item => item.actualPower,
          primary: true,
          area: true,
        },
        {
          key: "theory",
          label: "理论功率",
          className: "theory",
          unit: "kW",
          value: item => item.theoreticalPower,
        },
        {
          key: "mounted",
          label: "Lark 在架",
          className: "mounted",
          unit: "kW",
          value: item => item.mountedPower,
        },
      ];
  const primary = definitions.find(definition => definition.primary);
  const titleLabel = trendMetric === "ratio" ? "功耗比趋势" : "功率趋势";
  $("trend-title").textContent = `${currentSite().data_center_name} ${titleLabel}`;
  $("trend").setAttribute(
    "aria-label",
    `${currentSite().data_center_name} ${titleLabel}`,
  );
  const incompleteDays = series.filter(item =>
    trendMode === "daily" && !item.complete
  ).length;
  if (trendMetric === "ratio") {
    $("trend-meta").textContent = trendMode === "daily"
      ? `样本功耗加权 · W/TH${incompleteDays ? " · * 存在小时或矿箱缺口" : ""}`
      : `样本功耗加权 · W/TH · 当日覆盖 ${coverageLabel(hours.length)} · 灰色带为未上报小时`;
  }
  else {
    $("trend-meta").textContent = trendMode === "daily"
      ? `日均小时功率 · kW${incompleteDays ? " · * 存在小时或矿箱缺口" : ""}`
      : `当前小时功率 · kW · Lark 使用当日快照 · 灰色带为未上报小时`;
  }
  const selectedKey = trendMode === "daily" ? selectedDate : String($("hour").value);
  const allValues = definitions.flatMap(definition =>
    series.map(item => trendNumber(definition, item))
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
  const low = Math.min(...allValues);
  const high = Math.max(...allValues);
  const span = Math.max(high - low, 0.5);
  const ratioMode = trendMetric === "ratio";
  const minValue = ratioMode ? Math.max(0, low - span * 0.28) : 0;
  const maxValue = high + span * (ratioMode ? 0.28 : 0.16);
  const x = index => pad.left + (series.length === 1
    ? plotW / 2 : plotW * index / (series.length - 1));
  const y = value => pad.top + plotH * (1 - (value - minValue) / (maxValue - minValue));
  const selected = series.find(item => item.key === selectedKey);
  const currentLabel = trendMode === "daily" ? "当前日期" : "当前小时";
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
      ? `近 7 天均值${incompleteDays ? "（含不完整日）" : ""}`
      : "当日小时均值";
    $("trend-summary").innerHTML = `
      <span class="trend-stat current">
        <span class="trend-stat-label">${currentLabel}</span>
        <span class="trend-stat-value">${fmtRatio(selected?.ratio)}</span>
        <span class="trend-stat-unit">W/TH</span>
        <span class="trend-stat-context">${esc(selected?.label || "")}${esc(selectedCoverage)}</span>
      </span>
      <span class="trend-stat-separator" aria-hidden="true"></span>
      <span class="trend-stat">
        <span class="trend-stat-label">${averageLabel}</span>
        <span class="trend-stat-value">${fmtRatio(average)}</span>
        <span class="trend-stat-unit">W/TH</span>
      </span>`;
  }
  else {
    $("trend-summary").innerHTML = `
      <span class="trend-stat current">
        <span class="trend-stat-label">${currentLabel}实际</span>
        <span class="trend-stat-value">${fmt(selected?.actualPower)}</span>
        <span class="trend-stat-unit">kW</span>
        <span class="trend-stat-context">${esc(selected?.label || "")}${esc(selectedCoverage)}</span>
      </span>
      <span class="trend-stat-separator" aria-hidden="true"></span>
      <span class="trend-stat">
        <span class="trend-stat-label">同期理论</span>
        <span class="trend-stat-value">${fmt(selected?.theoreticalPower)}</span>
        <span class="trend-stat-unit">kW</span>
      </span>
      <span class="trend-stat">
        <span class="trend-stat-label">Lark 在架</span>
        <span class="trend-stat-value">${fmt(selected?.mountedPower)}</span>
        <span class="trend-stat-unit">kW</span>
      </span>
      <span class="trend-legend" aria-label="趋势图例">
        <span><i class="actual"></i>实际</span>
        <span><i class="theory"></i>理论</span>
        <span><i class="mounted"></i>Lark 在架快照</span>
      </span>`;
  }
  const grid = [0, 1, 2, 3].map(index => {
    const value = maxValue - (maxValue - minValue) * index / 3;
    const yPos = pad.top + plotH * index / 3;
    return `<line class="chart-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${yPos}" y2="${yPos}"/>
      <text class="chart-axis" x="0" y="${yPos + 3}">${ratioMode ? fmtRatio(value) : fmt(value)}</text>`;
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
    return `<rect class="chart-missing-band" x="${left}" y="${pad.top}" width="${Math.max(1, right - left)}" height="${plotH}"><title>${esc(item.label)} 无上报数据</title></rect>`;
  }).join("") : "";
  const pointsByDefinition = new Map(definitions.map(definition => [
    definition.key,
    series.map((item, index) => {
      const value = trendNumber(definition, item);
      return value == null ? null : [x(index), y(value)];
    }),
  ]));
  const primaryPoints = pointsByDefinition.get(primary.key);
  const hits = series.map((item, index) => {
    const detail = item.detail || {};
    const center = primaryPoints[index];
    const dateText = trendMode === "daily" ? item.key : hourLabel(Number(item.key));
    const coverage = trendMode === "daily" && detail.expected_hours
      ? ` · ${siteCoverageLabel(detail)}`
      : "";
    const valueText = ratioMode
      ? `功耗比 ${fmtRatio(item.ratio)} W/TH`
      : `实际 ${fmt(item.actualPower)} kW，理论 ${fmt(item.theoreticalPower)} kW，在架 ${fmt(item.mountedPower)} kW`;
    const sampleText = ratioMode
      ? `样本 ${detail.power_ratio_sample_count ?? "—"}/${detail.machine_count ?? "—"}`
      : "";
    const missingText = item.missing ? "，无上报数据" : "";
    return `<rect class="chart-hit" x="${x(index) - hitWidth / 2}" y="${pad.top}" width="${hitWidth}" height="${plotH}" tabindex="0" role="button" data-chart-key="${esc(item.key)}" aria-label="${esc(dateText)}，${esc(valueText)}${esc(coverage)}${esc(missingText)}，点击查看"><title>${esc(dateText)} · ${esc(valueText)}${esc(coverage)}${sampleText ? ` · ${esc(sampleText)}` : ""}${esc(missingText)}</title></rect>
      ${center ? `<circle class="chart-point" cx="${center[0]}" cy="${center[1]}" r="3"/>` : ""}`;
  }).join("");
  const currentIndex = series.findIndex(item => item.key === selectedKey);
  const currentPoint = currentIndex >= 0 && primaryPoints[currentIndex]
    ? `<circle class="chart-current" cx="${primaryPoints[currentIndex][0]}" cy="${primaryPoints[currentIndex][1]}" r="4.2"/>` : "";
  const selection = currentIndex < 0 ? ""
    : `<line class="chart-selection" x1="${x(currentIndex)}" x2="${x(currentIndex)}" y1="${pad.top}" y2="${pad.top + plotH}"/>`;
  const linePaths = definitions.map(definition => {
    const points = pointsByDefinition.get(definition.key);
    const segments = chartSegments(points);
    const paths = segments.map(segment =>
      segment.length > 1
        ? `<path class="chart-line ${definition.className}" d="${chartPath(segment)}"/>`
        : ""
    ).join("");
    if (!definition.primary && segments.length === 1 && segments[0].length === 1) {
      const [point] = segments[0];
      return `${paths}<circle class="chart-series-point ${definition.className}" cx="${point[0]}" cy="${point[1]}" r="3.2"/>`;
    }
    return paths;
  }).join("");
  const primarySegments = chartSegments(primaryPoints);
  const area = primary.area
    ? primarySegments.filter(segment => segment.length > 1).map(segment =>
      `<path class="chart-area ${primary.className}" d="${chartPath(segment)} L${segment.at(-1)[0].toFixed(1)},${(pad.top + plotH).toFixed(1)} L${segment[0][0].toFixed(1)},${(pad.top + plotH).toFixed(1)} Z"/>`
    ).join("")
    : "";
  trendState = {
    series, definitions, primary, width, height, pad, minValue, maxValue,
    plotW, plotH, metric: trendMetric, mode: trendMode,
  };
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.innerHTML = `<defs>
      <linearGradient id="ratioFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#147960" stop-opacity=".16"/><stop offset="1" stop-color="#147960" stop-opacity="0"/></linearGradient>
      <linearGradient id="powerFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#147960" stop-opacity=".13"/><stop offset="1" stop-color="#147960" stop-opacity="0"/></linearGradient>
    </defs>
    ${missingBands}${grid}${meanY == null ? "" : `<line class="chart-mean" x1="${pad.left}" x2="${width - pad.right}" y1="${meanY}" y2="${meanY}"/>`}
    ${area}
    ${selection}
    ${linePaths}
    ${hits}${currentPoint}${labels}`;
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
  const dateText = trendMode === "daily" ? item.key : hourLabel(Number(item.key));
  const coverage = trendMode === "daily" && detail.expected_hours
    ? ` · ${siteCoverageLabel(detail)}`
    : "";
  if (item.missing) {
    tooltip.innerHTML = `<strong>无上报数据</strong><span>${esc(dateText)}<br>该小时没有被矿机小时汇总覆盖</span>`;
  }
  else if (trendState.metric === "ratio") {
    tooltip.innerHTML = `<strong>${fmtRatio(item.ratio)} W/TH</strong><span>${esc(dateText)}${esc(coverage)}<br>功耗比样本 ${detail.power_ratio_sample_count ?? "—"} / ${detail.machine_count ?? "—"}</span>`;
  }
  else {
    tooltip.innerHTML = `<strong>实际 ${fmt(item.actualPower)} kW</strong>
      <div class="tooltip-series">
        <span><i style="color:#7f8c89"></i>理论功率</span><b>${fmt(item.theoreticalPower)} kW</b>
        <span><i style="color:#477b9d"></i>Lark 在架</span><b>${fmt(item.mountedPower)} kW</b>
      </div>
      <span>${esc(dateText)}${esc(coverage)}<br>Lark 在架使用所选日期当日快照</span>`;
  }
  const x = pad.left + (series.length === 1 ? plotW / 2 : plotW * index / (series.length - 1));
  const primaryValue = trendNumber(primary, item);
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
  $("meta").textContent = `${catalog.date_range.start} 至 ${catalog.date_range.end} · 正在读取 ${date} · ${siteCoverageLabel(daily)} · ${currentSite().warehouses_with_data} 个矿箱`;
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

let focusPeakMachineScope = null;

function renderDetailSummary(row, options = {}) {
  const titleSuffix = options.dailyMachinePeak
    ? "当日最大功率矿机"
    : options.peakHourView ? "当日峰值小时" : "矿箱详情";
  $("detail-title").textContent = `${row.warehouse_name} · ${titleSuffix}`;
  const reporting = finite(row.lark_power?.mounted_machine_count)
    ? ` · 上报 ${row.machine_count}/${fmt(row.lark_power.mounted_machine_count, 0)} 台`
    : "";
  $("detail-meta").textContent = `${row.data_center_name} · ${hourLabel(row.hour)} · 本箱覆盖 ${coverageLabel(warehouseHours(row.warehouse_id))}${reporting}`;
  const gap = powerGap(row);
  const gapLabel = gap?.value === 0
    ? "与理论持平" : gap?.over ? "超出理论" : "低于理论";
  $("detail-metrics").innerHTML = metric("实际功率", fmt(row.actual_power_kw), "kW")
    + metric(
      gap ? gapLabel : "功率差值",
      gap ? fmt(Math.abs(gap.value)) : "—",
      "kW",
      "理论 − 实际",
    )
    + metric("整体功耗比", fmtRatio(row.power_ratio_overall_w_per_th), "W/TH")
    + metric(
      "单机理论平均功率",
      fmt(row.lark_power?.unit_theoretical_power_kw, 2),
      "kW",
      "Lark 配置",
    )
    + metric("平均单机算力", fmt(row.avg_hashrate_ths), "TH/s")
    + metric("矿机 / 算力组", `${row.machine_count} / ${row.template_count}`, "台 / 组")
    + metric("平均 / 最高温度", `${fmt(row.temperature_avg_c)} / ${fmt(row.temperature_max_c)}`, "°C")
    + metric("平均 / 最大拒绝率", `${percent(row.rejected_rate_avg)} / ${percent(row.rejected_rate_max)}`, "");
  const capacityPanel = larkPanelHTML(row);
  $("detail-capacity").innerHTML = capacityPanel
    ? `<h3>容量与负荷</h3>${capacityPanel}`
    : `<p class="capacity-empty">该矿箱暂未匹配容量数据。</p>`;
}

async function openDetail(id, options = {}) {
  const warehouse = warehouses.find(item =>
    item.data_center_id === currentSite()?.data_center_id
    && item.warehouse_id === id
  );
  if (!warehouse) return;
  let row = {
    ...warehouse,
    ...(options.snapshotRow
      || currentRows.find(item => item.warehouse_id === id)
      || {}),
    lark_power: larkRecordFor(warehouse, selectedDate),
  };
  if (!detailAvailable()) return;
  const token = ++requestVersion;
  detailData = null;
  detailBundle = null;
  powerLimitFilter = "all";
  detailPowerLimitW = configuredPowerLimit(warehouse);
  focusPeakMachineScope = options.dailyMachinePeak
    ? "day" : options.focusPeakMachine ? "hour" : null;
  level = focusPeakMachineScope ? "machine_rows" : "template_rows";
  if (options.dailyMachinePeak) {
    $("detail-title").textContent = `${row.warehouse_name} · 当日最大功率矿机`;
    $("detail-meta").textContent = `${row.data_center_name} · 正在扫描 ${selectedDate} 全部小时`;
    $("detail-metrics").innerHTML = "";
    $("detail-capacity").innerHTML = "";
  } else {
    renderDetailSummary(row, options);
  }
  $("detail-focus").innerHTML = "";
  $("power-limit-panel").innerHTML = "";
  $("detail-search").value = "";
  $("detail").showModal();
  $("detail-content").innerHTML = "<p>正在读取矿箱明细…</p>";
  const key = `${row.data_center_id}/${compactDate(selectedDate)}/${row.warehouse_id}`;
  try {
    if (!detailCache.has(key)) {
      detailCache.set(key, fetchGzipJson(
        `data/details/${row.data_center_id}/${compactDate(selectedDate)}/${row.warehouse_id}.json.gz?v=${encodeURIComponent(catalog.exported_at || catalog.latest_date)}`
      ));
    }
    const payload = await detailCache.get(key);
    if (token !== requestVersion) return;
    detailBundle = payload;
    if (options.dailyMachinePeak) {
      const dayPeak = dailyMachinePeak(payload);
      if (!dayPeak) throw Error("当日没有可用的矿机功率数据");
      const peakHourData = dayData?.hour === dayPeak.hour
        ? dayData
        : await loadHour(row.data_center_id, selectedDate, dayPeak.hour);
      if (token !== requestVersion) return;
      const peakRow = peakHourData?.warehouse_rows.find(item =>
        item.data_center_id === row.data_center_id
        && item.warehouse_id === row.warehouse_id
      );
      if (peakRow) {
        row = {
          ...row,
          ...peakRow,
          lark_power: larkRecordFor(warehouse, selectedDate),
        };
      } else {
        row = { ...row, hour: dayPeak.hour };
      }
      renderDetailSummary(row, options);
      detailData = payload.hours[String(dayPeak.hour)];
    } else {
      detailData = payload.hours[String(row.hour)];
    }
    if (!detailData) throw Error("该小时没有明细");
    renderDetail();
  } catch (error) {
    detailCache.delete(key);
    if (token === requestVersion) {
      $("detail-content").innerHTML = `<p class="error">${esc(error.message || "明细读取失败")}</p>`;
    }
  }
}

async function revealPeakHour(id) {
  const peak = dailyPeak(id);
  if (!peak || !detailAvailable()) return;
  await openDetail(id, { peakHourView: true, snapshotRow: peak });
}

async function revealDailyMachinePeak(id) {
  if (!detailAvailable()) return;
  await openDetail(id, { dailyMachinePeak: true });
}

function renderPowerLimitPanel() {
  const panel = $("power-limit-panel");
  if (level !== "machine_rows" || !detailData) {
    panel.innerHTML = "";
    return;
  }
  const states = (detailData.machine_rows || [])
    .map(machine => machinePowerState(machine))
    .filter(Boolean);
  const entries = [
    ["all", "全部", (detailData.machine_rows || []).length],
    ["over100", "> 100%", states.filter(state => state.ratio > 1).length],
    ["over90", "> 90%", states.filter(state => state.ratio > 0.9).length],
    ["over80", "> 80%", states.filter(state => state.ratio > 0.8).length],
  ];
  panel.innerHTML = `<div class="power-limit-summary">
    <div class="power-limit-heading">
      <span>单机功耗上限</span>
      <strong>${fmt(detailPowerLimitW, 0)}<small>W</small></strong>
      <em>按当前小时平均功耗判定</em>
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
  let rows = [...detailData[level]].filter(row =>
    [row.template_name, row.template_id, row.model, row.work_mode, row.ip]
      .some(value => String(value ?? "").toLowerCase().includes(search)));
  if (level === "machine_rows" && powerLimitFilter !== "all") {
    rows = rows.filter(matchesPowerLimitFilter);
  }
  const peakMachine = level === "machine_rows"
    ? [...detailData.machine_rows].sort((a, b) =>
      (b.avg_power_w ?? -Infinity) - (a.avg_power_w ?? -Infinity))[0]
    : null;
  if (level === "machine_rows") {
    rows.sort((a, b) =>
      (b.avg_power_w ?? -Infinity) - (a.avg_power_w ?? -Infinity));
  }
  const columns = [["算力组", "template_name"]];
  if (level !== "template_rows") columns.push(["型号", "model"]);
  if (["work_mode_rows", "machine_rows"].includes(level)) columns.push(["档位", "work_mode"]);
  if (level === "machine_rows") columns.push(["IP", "ip"]);
  else columns.push(["台数", "machine_count"]);
  columns.push(
    ["平均算力 TH/s", "avg_hashrate_ths"],
    ["平均功耗 W", "avg_power_w"],
  );
  if (level === "machine_rows") {
    columns.push(
      ["单机上限 W", "__power_limit_w"],
      ["占上限", "__power_limit_ratio"],
      ["超上限 W", "__power_over_w"],
    );
  }
  columns.push(
    ["功耗比 W/TH", level === "machine_rows" ? "power_ratio_w_per_th" : "power_ratio_overall_w_per_th"],
    ["拒绝率", level === "machine_rows" ? "rejected_rate" : "rejected_rate_avg"],
    ["温度 °C", level === "machine_rows" ? "temperature_c" : "temperature_avg_c"],
  );
  renderPowerLimitPanel();
  if (focusPeakMachineScope && level === "machine_rows" && peakMachine) {
    const peakLabel = focusPeakMachineScope === "day"
      ? "当日最大功率矿机" : "本小时最大功率矿机";
    $("detail-focus").innerHTML = `<div class="peak-machine-callout">
      <div class="peak-machine-heading">
        <span>${peakLabel}</span>
        <strong>${esc(peakMachine.model || "型号未记录")}</strong>
        <em>${esc(peakMachine.ip || "IP 未记录")}</em>
      </div>
      <div class="peak-machine-power">
        <strong>${fmt(peakMachine.avg_power_w)}<small>W</small></strong>
        <span>${fmt(peakMachine.avg_hashrate_ths)} TH/s · ${fmtRatio(peakMachine.power_ratio_w_per_th)} W/TH</span>
      </div>
      <div class="peak-machine-context">
        <span>档位 ${esc(peakMachine.work_mode || "未记录")}</span>
        <span>温度 ${fmt(peakMachine.temperature_c)} °C</span>
        <span>拒绝率 ${percent(peakMachine.rejected_rate)}</span>
      </div>
    </div>`;
  } else {
    $("detail-focus").innerHTML = "";
  }
  $("detail-content").innerHTML = `<table><thead><tr>${columns.map(([label]) => `<th>${label}</th>`).join("")}</tr></thead><tbody>${rows.map(row => {
    const isPeakMachine = focusPeakMachineScope && level === "machine_rows"
      && peakMachine && row.ip === peakMachine.ip;
    const powerState = level === "machine_rows"
      ? machinePowerState(row) : null;
    const rowClasses = [];
    if (isPeakMachine) rowClasses.push("peak-machine-row");
    if (powerState?.ratio > 1) rowClasses.push("machine-over-100");
    else if (powerState?.ratio > 0.9) rowClasses.push("machine-over-90");
    else if (powerState?.ratio > 0.8) rowClasses.push("machine-over-80");
    return `<tr class="${rowClasses.join(" ")}">${columns.map(([, key]) => {
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
  const distributionButton = event.target.closest("[data-distribution-id]");
  if (distributionButton) {
    openDistribution(distributionButton.dataset.distributionId);
    return;
  }
  const peakHourButton = event.target.closest("[data-peak-hour-id]");
  if (peakHourButton) {
    revealPeakHour(peakHourButton.dataset.peakHourId);
    return;
  }
  const dailyMachineButton = event.target.closest("[data-daily-machine-id]");
  if (dailyMachineButton) {
    revealDailyMachinePeak(dailyMachineButton.dataset.dailyMachineId);
    return;
  }
  const button = event.target.closest("[data-detail-id]");
  if (button) openDetail(button.dataset.detailId);
};
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
document.querySelectorAll("[data-level]").forEach(button => {
  button.onclick = () => { level = button.dataset.level; renderDetail(); };
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
window.addEventListener("resize", () => dayData && renderTrend());
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
