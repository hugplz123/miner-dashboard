const $ = id => document.getElementById(id);
const fmt = (n, digits = 1) => n == null || !Number.isFinite(n)
  ? "—" : n.toLocaleString("zh-CN", { maximumFractionDigits: digits });
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));
const percent = n => n == null || !Number.isFinite(n) ? "—" : `${fmt(n * 100)}%`;
const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
const compactDate = date => String(date).replaceAll("-", "");
const shortDate = date => String(date).slice(5);
const hourLabel = hour => `${String(hour).slice(0, 4)}-${String(hour).slice(4, 6)}-${String(hour).slice(6, 8)} ${String(hour).slice(8)}:00`;
const expectedHoursPerDay = 24;
const palette = ["#3f8273", "#557fa4", "#bd9147", "#937190", "#b56e55", "#72906d", "#80795f", "#5f8790"];
let catalog, sites = [], warehouses = [], dates = [], hours = [], currentRows = [];
let selectedDate, dayData, detailData, detailBundle, level = "template_rows";
let requestVersion = 0, dayRequestVersion = 0, trendMode = "daily", trendState = null;
const dayCache = new Map();
const detailCache = new Map();

function iconize() {
  if (window.lucide) window.lucide.createIcons();
}

function metric(label, value, unit, note = "") {
  return `<div class="metric"><div class="metric-label">${esc(label)}</div><div class="metric-value">${esc(value)}<span class="unit">${esc(unit)}</span></div><div class="metric-note">${esc(note)}</div></div>`;
}

function ratio(rows) {
  const hashrate = sum(rows, "power_ratio_valid_hashrate_sum_ths");
  return hashrate > 0 ? sum(rows, "power_ratio_valid_power_sum_w") / hashrate : null;
}

function ratioCoverage(row) {
  return row.machine_count ? row.power_ratio_sample_count / row.machine_count : null;
}

function finite(value) {
  return value != null && Number.isFinite(Number(value));
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
  const rows = dayData.warehouse_rows.filter(row =>
    row.data_center_id === currentSite()?.data_center_id
    && row.warehouse_id === warehouseId
    && finite(row.actual_power_kw)
  );
  if (!rows.length) return null;
  return rows.reduce((peak, row) =>
    !peak || row.actual_power_kw > peak.actual_power_kw ? row : peak,
  null);
}

function currentSite() {
  return sites.find(site => site.data_center_id === $("site").value);
}

function dailyFor(date, site = currentSite()) {
  return (site?.daily_summary || []).find(item => item.date === date);
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

function coverageLabel(observed, expected = expectedHoursPerDay) {
  return `${observed ?? "—"}/${expected ?? expectedHoursPerDay} 小时`;
}

function coverageParts(daily, site = currentSite()) {
  const observed = daily?.hours_with_data ?? daily?.hours?.length;
  const expected = daily?.expected_hours ?? expectedHoursPerDay;
  const totalWarehouses = daily?.warehouses_with_data
    ?? site?.warehouses_with_data
    ?? site?.warehouse_count;
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

async function loadDay(date) {
  if (dayCache.has(date)) return dayCache.get(date);
  const version = encodeURIComponent(catalog.exported_at || catalog.latest_date);
  const promise = fetchGzipJson(
    `data/days/${compactDate(date)}.json.gz?v=${version}`
  );
  dayCache.set(date, promise);
  try {
    return await promise;
  } catch (error) {
    dayCache.delete(date);
    throw error;
  }
}

function setLoading(active, text = "") {
  const loading = $("loading");
  loading.hidden = !active;
  if (text) $("loading-text").textContent = text;
  $("cards").setAttribute("aria-busy", active ? "true" : "false");
  document.querySelector("main").classList.toggle("is-loading", active);
}

function distributionHTML(title, items, nameKey, emptyLabel) {
  const colors = ["#4f8f7a", "#d09a43", "#5b7fa6", "#bb6b55", "#758b66"];
  const sorted = [...(items || [])]
    .filter(item => Number(item.machine_count) > 0)
    .sort((a, b) => b.machine_count - a.machine_count);
  const total = sorted.reduce(
    (sum, item) => sum + Number(item.machine_count || 0),
    0,
  );
  if (!total) {
    return `<section class="distribution-block" data-distribution="${nameKey}">
      <div class="distribution-head"><span>${title}</span><b>暂无数据</b></div>
      <div class="distribution-empty">${emptyLabel}</div>
    </section>`;
  }
  const visible = sorted.slice(0, 4).map((item, index) => ({
    label: item[nameKey] || (nameKey === "template_name" ? "未分组" : "未记录"),
    count: Number(item.machine_count),
    color: colors[index],
  }));
  const rest = sorted.slice(4);
  if (rest.length) {
    visible.push({
      label: `其他 ${rest.length} 类`,
      count: rest.reduce((sum, item) => sum + Number(item.machine_count), 0),
      color: colors[4],
      rest: true,
    });
  }
  return `<section class="distribution-block" data-distribution="${nameKey}" data-total="${total}">
    <div class="distribution-head">
      <span>${title}</span>
      <b>${sorted.length} 类 · ${total} 台</b>
    </div>
    <div class="distribution-track" aria-label="${title}矿机数量分布">
      ${visible.map(item => `<i class="distribution-segment"
        style="--segment-color:${item.color};--segment-weight:${item.count}"
        data-count="${item.count}"
        title="${esc(item.label)}：${item.count} 台（${fmt(item.count / total * 100, 1)}%）"></i>`).join("")}
    </div>
    <div class="distribution-legend">
      ${visible.map(item => `<span class="distribution-key" title="${esc(item.label)}：${item.count} 台">
        <i style="--segment-color:${item.color}"></i>
        <strong>${esc(item.label)}</strong>
        <em>${item.count}</em>
      </span>`).join("")}
    </div>
  </section>`;
}

function detailAvailable() {
  return (catalog.detail_dates || []).includes(selectedDate);
}

function renderCoverage(daily, site) {
  const expected = daily?.expected_hours ?? expectedHoursPerDay;
  const observed = daily?.hours_with_data ?? daily?.hours?.length ?? hours.length;
  const { completeWarehouses, totalWarehouses } = coverageParts(daily, site);
  const partialWarehouses = daily?.incomplete_warehouse_count || 0;
  const minimumHours = daily?.min_warehouse_hours;
  const complete = observed === expected && partialWarehouses === 0;
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
  if (!lark) return "";
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
      <span>单机理论平均 ${fmt(lark.unit_theoretical_power_kw, 2)} kW</span>
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
    ? `<button type="button" class="peak-action" data-peak-id="${esc(row.warehouse_id)}" title="切换到峰值小时并查看功率最高的矿机">查看最大功率矿机<i data-lucide="arrow-up-right"></i></button>`
    : `<button type="button" disabled title="历史日期只保留矿箱汇总">仅最新一天可查看</button>`;
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
  if (row.missing) {
    return `<article class="warehouse-card missing-card" data-warehouse-id="${esc(row.warehouse_id)}">
      <div class="card-head"><div class="card-title"><strong>${esc(row.warehouse_name)}</strong><span class="status">本小时无记录</span></div></div>
      <span>没有可用于本小时汇总的矿机数据</span>
      <span class="missing-coverage${boxComplete ? "" : " warn"}">当日覆盖 ${esc(coverageLabel(observedHours))}</span>
    </article>`;
  }
  const hasTheory = finite(row.theoretical_power_kw) && finite(row.load_ratio);
  const overload = hasTheory && row.load_ratio > 1;
  const installedMachines = row.lark_power?.mounted_machine_count;
  const reportingIncomplete = finite(installedMachines)
    && Number(installedMachines) > Number(row.machine_count);
  const statusText = reportingIncomplete
    ? "上报覆盖不足" : hasTheory ? (overload ? "超理论功率" : "理论功率内") : "实际数据";
  const details = detailAvailable()
    ? `<button type="button" data-detail-id="${esc(row.warehouse_id)}" aria-label="查看 ${esc(row.warehouse_name)} 详情">详情<i data-lucide="arrow-up-right"></i></button>`
    : `<button type="button" disabled title="历史日期仅保留矿箱汇总，明细保留最新一天">仅汇总</button>`;
  return `<article class="warehouse-card${overload ? " overload" : ""}${hasTheory ? "" : " actual-only"}" data-warehouse-id="${esc(row.warehouse_id)}">
    <div class="card-head">
      <div class="card-title"><strong>${esc(row.warehouse_name)}</strong><span class="status${reportingIncomplete ? " warn-status" : ""}">${statusText}</span></div>
      ${details}
    </div>
    <div class="power-block">
      <div class="power-label">当前实际功率</div>
      <div class="power-line">
        <span class="actual-power">${fmt(row.actual_power_kw)}<small>kW</small></span>
        ${hasTheory ? `<span class="power-reference">理论 ${fmt(row.theoretical_power_kw)} kW</span>` : ""}
      </div>
    </div>
    ${larkPanelHTML(row)}
    <div class="card-glance">
      <div class="glance-item">
        <span>功耗比</span>
        <strong>${fmt(row.power_ratio_overall_w_per_th)}<small>W/TH</small></strong>
      </div>
      <div class="glance-item">
        <span>运行矿机</span>
        <strong>${row.machine_count}<small>台</small></strong>
      </div>
    </div>
    <div class="card-distributions">
      ${distributionHTML("算力组分布", row.templates, "template_name", "当前小时未记录算力组")}
      ${distributionHTML("档位分布", row.work_modes, "work_mode", "当前小时未记录档位")}
    </div>
    ${peakHTML(row)}
    ${boxComplete ? "" : `<div class="card-alert"><span class="warehouse-hour-coverage warn">当日覆盖 ${esc(coverageLabel(observedHours))}</span></div>`}
  </article>`;
}

function render() {
  if (!dayData || dayData.date !== selectedDate) return;
  const centerId = $("site").value;
  const site = currentSite();
  const hour = Number($("hour").value);
  currentRows = dayData.warehouse_rows.filter(row =>
    row.data_center_id === centerId && row.hour === hour
  );
  const activeIds = warehousesWithDataOnDate(site, selectedDate);
  const siteWarehouses = warehouses.filter(warehouse =>
    warehouse.data_center_id === centerId
  );
  const visibleWarehouses = activeIds
    ? siteWarehouses.filter(warehouse => activeIds.has(warehouse.warehouse_id))
    : siteWarehouses;
  const activeWarehouseCount = visibleWarehouses.length;
  const activeLarkRows = visibleWarehouses
    .map(warehouse => warehouse.lark_power)
    .filter(Boolean);
  const machineCount = sum(currentRows, "machine_count");
  const actualPower = sum(currentRows, "actual_power_kw");
  const theoryPower = sum(currentRows, "theoretical_power_kw");
  const theoryRows = currentRows.filter(row => finite(row.theoretical_power_kw)).length;
  const validSamples = sum(currentRows, "power_ratio_sample_count");
  const larkMatched = activeLarkRows.length;
  const larkMounted = larkMatched ? sum(activeLarkRows, "mounted_power_kw") : null;
  const larkReserved = larkMatched ? sum(activeLarkRows, "reserved_power_kw") : null;
  const daily = dailyFor(selectedDate, site);
  const observedHours = daily?.hours_with_data ?? daily?.hours?.length ?? hours.length;
  const expectedHours = daily?.expected_hours ?? expectedHoursPerDay;
  $("brand-mark").textContent = site.data_center_name.charAt(0).toUpperCase();
  $("brand-name").textContent = site.data_center_name;
  $("trend-title").textContent = `${site.data_center_name} 功耗比趋势`;
  $("trend").setAttribute("aria-label", `${site.data_center_name} 功耗比趋势`);
  const warehouseCoverage = `${activeWarehouseCount} 个矿箱`;
  $("meta").textContent = `${catalog.date_range.start} 至 ${catalog.date_range.end} · 当前 ${selectedDate} · ${siteCoverageLabel(daily, site)} · ${warehouseCoverage}`;
  document.title = `${site.data_center_name} · 矿箱负荷`;
  renderCoverage(daily, site);
  $("notice").textContent = `功率为矿机上报的小时平均值；Lark 容量为快照数据，同步于 ${syncTimeLabel(catalog.lark_power?.synced_at)}，${site.data_center_name} 已覆盖 ${larkMatched}/${activeWarehouseCount} 个有数据矿箱。`;
  $("metrics").innerHTML = metric("上报实际功率", fmt(actualPower), "kW", "矿机小时平均功耗之和")
    + metric("对应理论功率", fmt(theoryPower), "kW", `${theoryRows}/${currentRows.length} 个当前小时矿箱已配置`)
    + metric("理论余量", fmt(sum(currentRows, "available_capacity_kw")), "kW", "逐箱余量之和，超载不抵扣")
    + metric("Lark 在架功率", fmt(larkMounted), "kW", `${larkMatched}/${activeWarehouseCount} 个有数据矿箱 · 快照`)
    + metric("Lark 占位功率", fmt(larkReserved), "kW", `在架 ${fmt(sum(activeLarkRows, "mounted_machine_count"), 0)} 台 · 占位 ${fmt(sum(activeLarkRows, "occupied_slots"), 0)} 位`)
    + metric("样本整体功耗比", fmt(ratio(currentRows)), "W/TH", `${fmt(machineCount, 0)} 台 · 有效样本 ${validSamples}`);

  const search = $("search").value.trim().toLowerCase();
  let rows = visibleWarehouses.map(warehouse => {
    const measured = currentRows.find(
      row => row.warehouse_id === warehouse.warehouse_id,
    );
    return measured
      ? { ...warehouse, ...measured }
      : { ...warehouse, hour, missing: true };
  });
  rows = rows.filter(row => JSON.stringify([
    row.warehouse_name, row.models, row.work_modes, row.templates,
    row.lark_power,
  ]).toLowerCase().includes(search));
  const sort = $("sort").value;
  const sortKey = { available: "available_capacity_kw", load: "load_ratio", power: "actual_power_kw" }[sort];
  rows.sort((a, b) => sort === "name"
    ? a.warehouse_name.localeCompare(b.warehouse_name, undefined, { numeric: true })
    : ((b[sortKey] ?? -Infinity) - (a[sortKey] ?? -Infinity))
      || a.warehouse_name.localeCompare(b.warehouse_name, undefined, { numeric: true }));

  $("count").textContent = `${site.data_center_name} · ${rows.length} 个矿箱`;
  $("detail-note").textContent = detailAvailable()
    ? "最新一天支持下钻到算力组、型号、档位和单机"
    : "历史日期保留矿箱汇总；下钻明细仅保留最新一天";
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
      value: item.power_ratio_overall_w_per_th,
      detail: item,
      complete,
    };
  });
}

function hourlySeries() {
  const site = currentSite();
  return hours.map(hour => {
    const rows = dayData.warehouse_rows.filter(row =>
      row.data_center_id === site.data_center_id && row.hour === hour
    );
    return {
      key: String(hour),
      label: `${String(hour).slice(-2)}:00`,
      value: ratio(rows),
      detail: {
        machine_count: sum(rows, "machine_count"),
        power_ratio_sample_count: sum(rows, "power_ratio_sample_count"),
      },
    };
  });
}

function renderTrend() {
  if (!dayData || dayData.date !== selectedDate || !hours.length) return;
  const series = trendMode === "daily" ? dailySeries() : hourlySeries();
  const incompleteDays = series.filter(item =>
    trendMode === "daily" && !item.complete
  ).length;
  $("trend-meta").textContent = trendMode === "daily"
    ? `样本功耗加权 · W/TH${incompleteDays ? " · * 存在小时或矿箱缺口" : ""}`
    : `样本功耗加权 · W/TH · 当日覆盖 ${coverageLabel(hours.length)}`;
  const selectedKey = trendMode === "daily" ? selectedDate : String($("hour").value);
  const numeric = series.map(item => item.value).filter(value => value != null);
  if (!numeric.length) {
    $("trend-summary").textContent = "当前范围没有可计算的整体功耗比样本";
    $("trend").innerHTML = "";
    return;
  }
  const svg = $("trend");
  const width = Math.max(300, svg.parentElement.clientWidth);
  const height = 218;
  const pad = { left: 43, right: 14, top: 20, bottom: 27 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const low = Math.min(...numeric);
  const high = Math.max(...numeric);
  const span = Math.max(high - low, 0.5);
  const minValue = Math.max(0, low - span * 0.28);
  const maxValue = high + span * 0.28;
  const x = index => pad.left + (series.length === 1
    ? plotW / 2 : plotW * index / (series.length - 1));
  const y = value => pad.top + plotH * (1 - (value - minValue) / (maxValue - minValue));
  const points = series.map((item, index) =>
    item.value == null ? null : [x(index), y(item.value)]
  );
  const visiblePoints = points.filter(Boolean);
  const line = visiblePoints.map((point, index) =>
    `${index ? "L" : "M"}${point[0].toFixed(1)},${point[1].toFixed(1)}`
  ).join(" ");
  const area = visiblePoints.length
    ? `${line} L${visiblePoints.at(-1)[0].toFixed(1)},${(pad.top + plotH).toFixed(1)} L${visiblePoints[0][0].toFixed(1)},${(pad.top + plotH).toFixed(1)} Z` : "";
  const average = numeric.reduce((total, value) => total + value, 0) / numeric.length;
  const selected = series.find(item => item.key === selectedKey);
  const currentLabel = trendMode === "daily" ? "当前日期" : "当前小时";
  const averageLabel = trendMode === "daily"
    ? `近 7 天均值${incompleteDays ? "（含不完整日）" : ""}`
    : "当日小时均值";
  const selectedCoverage = trendMode === "daily"
    && selected?.detail?.expected_hours
    ? ` · ${siteCoverageLabel(selected.detail)}`
    : "";
  $("trend-summary").innerHTML = `
    <span class="trend-stat current">
      <span class="trend-stat-label">${currentLabel}</span>
      <span class="trend-stat-value">${fmt(selected?.value)}</span>
      <span class="trend-stat-unit">W/TH</span>
      <span class="trend-stat-context">${esc(selected?.label || "")}${esc(selectedCoverage)}</span>
    </span>
    <span class="trend-stat-separator" aria-hidden="true"></span>
    <span class="trend-stat">
      <span class="trend-stat-label">${averageLabel}</span>
      <span class="trend-stat-value">${fmt(average)}</span>
      <span class="trend-stat-unit">W/TH</span>
    </span>`;
  const grid = [0, 1, 2, 3].map(index => {
    const value = maxValue - (maxValue - minValue) * index / 3;
    const yPos = pad.top + plotH * index / 3;
    return `<line class="chart-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${yPos}" y2="${yPos}"/>
      <text class="chart-axis" x="0" y="${yPos + 3}">${fmt(value)}</text>`;
  }).join("");
  const meanY = y(average);
  const labelEvery = series.length > 12 ? 4 : 1;
  const labels = series.map((item, index) => index % labelEvery === 0
    ? `<text class="chart-hour" x="${x(index)}" y="${height - 7}" text-anchor="middle" data-chart-key="${esc(item.key)}">${esc(item.label)}</text>` : "").join("");
  const hitWidth = plotW / Math.max(series.length, 1);
  const hits = series.map((item, index) => {
    const detail = item.detail || {};
    const value = item.value;
    const center = points[index];
    const dateText = trendMode === "daily" ? item.key : hourLabel(Number(item.key));
    const coverage = trendMode === "daily" && detail.expected_hours
      ? ` · ${siteCoverageLabel(detail)}`
      : "";
    return `<rect class="chart-hit" x="${x(index) - hitWidth / 2}" y="${pad.top}" width="${hitWidth}" height="${plotH}" tabindex="0" role="button" data-chart-key="${esc(item.key)}" aria-label="${esc(dateText)}，功耗比 ${fmt(value)} W/TH${esc(coverage)}，点击查看"><title>${esc(dateText)} · ${fmt(value)} W/TH${esc(coverage)} · 样本 ${detail.power_ratio_sample_count ?? "—"}/${detail.machine_count ?? "—"}</title></rect>
      ${center ? `<circle class="chart-point" cx="${center[0]}" cy="${center[1]}" r="3"/>` : ""}`;
  }).join("");
  const currentIndex = series.findIndex(item => item.key === selectedKey);
  const currentPoint = points[currentIndex]
    ? `<circle class="chart-current" cx="${points[currentIndex][0]}" cy="${points[currentIndex][1]}" r="4.2"/>` : "";
  const selection = currentIndex < 0 ? ""
    : `<line class="chart-selection" x1="${x(currentIndex)}" x2="${x(currentIndex)}" y1="${pad.top}" y2="${pad.top + plotH}"/>`;
  trendState = { series, width, height, pad, minValue, maxValue, plotW, plotH };
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.innerHTML = `<defs><linearGradient id="ratioFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#147960" stop-opacity=".16"/><stop offset="1" stop-color="#147960" stop-opacity="0"/></linearGradient></defs>
    ${grid}<line class="chart-mean" x1="${pad.left}" x2="${width - pad.right}" y1="${meanY}" y2="${meanY}"/>
    ${area ? `<path class="chart-area" d="${area}"/>` : ""}
    ${selection}
    ${line ? `<path class="chart-line" d="${line}"/>` : ""}
    ${hits}${currentPoint}${labels}`;
}

function showTooltip(event) {
  if (!trendState) return;
  const svg = $("trend");
  const tooltip = $("chart-tooltip");
  const rect = svg.getBoundingClientRect();
  const scale = trendState.width / rect.width;
  const relativeX = (event.clientX - rect.left) * scale;
  const { series, pad, plotW, plotH, minValue, maxValue } = trendState;
  const index = Math.round((relativeX - pad.left) / Math.max(1, plotW) * (series.length - 1));
  if (index < 0 || index >= series.length) { tooltip.hidden = true; return; }
  const item = series[index];
  const detail = item.detail || {};
  const dateText = trendMode === "daily" ? item.key : hourLabel(Number(item.key));
  const coverage = trendMode === "daily" && detail.expected_hours
    ? ` · ${siteCoverageLabel(detail)}`
    : "";
  tooltip.innerHTML = `<strong>${fmt(item.value)} W/TH</strong><span>${esc(dateText)}${esc(coverage)}<br>功耗比样本 ${detail.power_ratio_sample_count ?? "—"} / ${detail.machine_count ?? "—"}</span>`;
  const x = pad.left + (series.length === 1 ? plotW / 2 : plotW * index / (series.length - 1));
  const yPos = item.value == null ? pad.top
    : pad.top + plotH * (1 - (item.value - minValue) / (maxValue - minValue));
  tooltip.style.left = `${Math.max(75, Math.min(rect.width - 75, x / scale))}px`;
  tooltip.style.top = `${yPos / scale - 8}px`;
  tooltip.hidden = false;
}

async function selectDate(date, preferredHour) {
  const token = ++dayRequestVersion;
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
  setLoading(true, `正在加载 ${date} 的数据，请稍候…`);
  try {
    const payload = await loadDay(date);
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
      $("hour").value = target.dataset.chartKey;
      render();
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
      $("hour").value = target.dataset.chartKey;
      render();
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

let focusPeakMachine = false;

async function openDetail(id, options = {}) {
  const warehouse = warehouses.find(item =>
    item.data_center_id === currentSite()?.data_center_id
    && item.warehouse_id === id
  );
  const row = {
    ...(warehouse || {}),
    ...(currentRows.find(item => item.warehouse_id === id) || {}),
  };
  if (!row || !detailAvailable()) return;
  const token = ++requestVersion;
  detailData = null;
  detailBundle = null;
  focusPeakMachine = Boolean(options.focusPeakMachine);
  level = focusPeakMachine ? "machine_rows" : "template_rows";
  $("detail-title").textContent = focusPeakMachine
    ? `${row.warehouse_name} · 峰值矿机`
    : `${row.warehouse_name} · 矿箱详情`;
  const reporting = finite(row.lark_power?.mounted_machine_count)
    ? ` · 上报 ${row.machine_count}/${fmt(row.lark_power.mounted_machine_count, 0)} 台`
    : "";
  $("detail-meta").textContent = `${row.data_center_name} · ${hourLabel(row.hour)} · 本箱覆盖 ${coverageLabel(warehouseHours(row.warehouse_id))}${reporting}`;
  const theoryMetric = finite(row.available_capacity_kw)
    ? metric("理论余量", fmt(row.available_capacity_kw), "kW")
    : "";
  $("detail-metrics").innerHTML = metric("实际功率", fmt(row.actual_power_kw), "kW")
    + theoryMetric
    + metric("整体功耗比", fmt(row.power_ratio_overall_w_per_th), "W/TH")
    + metric("矿机 / 算力组", `${row.machine_count} / ${row.template_count}`, "台 / 组")
    + metric("平均 / 最高温度", `${fmt(row.temperature_avg_c)} / ${fmt(row.temperature_max_c)}`, "°C")
    + metric("平均 / 最大拒绝率", `${percent(row.rejected_rate_avg)} / ${percent(row.rejected_rate_max)}`, "")
    + metric("平均单机算力", fmt(row.avg_hashrate_ths), "TH/s");
  const capacityPanel = larkPanelHTML(row);
  $("detail-capacity").innerHTML = capacityPanel
    ? `<h3>容量与负荷</h3>${capacityPanel}`
    : `<p class="capacity-empty">该矿箱暂未匹配容量数据。</p>`;
  $("detail-focus").innerHTML = "";
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
    detailData = payload.hours[String(row.hour)];
    if (!detailData) throw Error("该小时没有明细");
    renderDetail();
  } catch (error) {
    detailCache.delete(key);
    if (token === requestVersion) {
      $("detail-content").innerHTML = `<p class="error">${esc(error.message || "明细读取失败")}</p>`;
    }
  }
}

async function revealPeak(id) {
  const peak = dailyPeak(id);
  if (!peak || !detailAvailable()) return;
  $("hour").value = String(peak.hour);
  render();
  await openDetail(id, { focusPeakMachine: true });
}

function renderDetail() {
  document.querySelectorAll("[data-level]").forEach(button =>
    button.setAttribute("aria-selected", button.dataset.level === level));
  if (!detailData) return;
  const search = $("detail-search").value.trim().toLowerCase();
  const rows = [...detailData[level]].filter(row =>
    [row.template_name, row.template_id, row.model, row.work_mode, row.ip]
      .some(value => String(value ?? "").toLowerCase().includes(search)));
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
    ["功耗比 W/TH", level === "machine_rows" ? "power_ratio_w_per_th" : "power_ratio_overall_w_per_th"],
    ["拒绝率", level === "machine_rows" ? "rejected_rate" : "rejected_rate_avg"],
    ["温度 °C", level === "machine_rows" ? "temperature_c" : "temperature_avg_c"],
  );
  if (focusPeakMachine && level === "machine_rows" && peakMachine) {
    $("detail-focus").innerHTML = `<div class="peak-machine-callout">
      <div class="peak-machine-heading">
        <span>本小时最大功率矿机</span>
        <strong>${esc(peakMachine.model || "型号未记录")}</strong>
        <em>${esc(peakMachine.ip || "IP 未记录")}</em>
      </div>
      <div class="peak-machine-power">
        <strong>${fmt(peakMachine.avg_power_w)}<small>W</small></strong>
        <span>${fmt(peakMachine.avg_hashrate_ths)} TH/s · ${fmt(peakMachine.power_ratio_w_per_th)} W/TH</span>
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
    const isPeakMachine = focusPeakMachine && level === "machine_rows"
      && peakMachine && row.ip === peakMachine.ip;
    return `<tr class="${isPeakMachine ? "peak-machine-row" : ""}">${columns.map(([, key]) => `<td>${esc(key.includes("rejected") ? percent(row[key]) : typeof row[key] === "number" ? fmt(row[key]) : row[key] ?? "未记录")}</td>`).join("")}</tr>`;
  }).join("")}</tbody></table>${rows.length ? "" : "<p>没有符合条件的明细。</p>"}`;
}

$("hour").onchange = render;
$("date").onchange = async () => {
  if ($("detail").open) {
    $("detail").close();
    requestVersion++;
  }
  $("search").value = "";
  await selectDate($("date").value);
};
$("site").onchange = async () => {
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
$("cards").onclick = event => {
  const peakButton = event.target.closest("[data-peak-id]");
  if (peakButton) {
    revealPeak(peakButton.dataset.peakId);
    return;
  }
  const button = event.target.closest("[data-detail-id]");
  if (button) openDetail(button.dataset.detailId);
};
$("close").onclick = () => { $("detail").close(); requestVersion++; };
$("detail").addEventListener("cancel", () => requestVersion++);
document.querySelectorAll("[data-level]").forEach(button => {
  button.onclick = () => { level = button.dataset.level; renderDetail(); };
});
document.querySelectorAll("[data-trend-mode]").forEach(button => {
  button.onclick = () => {
    trendMode = button.dataset.trendMode;
    document.querySelectorAll("[data-trend-mode]").forEach(item =>
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
