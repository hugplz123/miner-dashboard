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
const palette = ["#3f8273", "#557fa4", "#bd9147", "#937190", "#b56e55", "#72906d", "#80795f", "#5f8790"];
let catalog, sites = [], warehouses = [], dates = [], hours = [], currentRows = [];
let selectedDate, dayData, detailData, detailBundle, level = "template_rows";
let requestVersion = 0, trendMode = "daily", trendState = null;
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

function currentSite() {
  return sites.find(site => site.data_center_id === $("site").value);
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
  $("date").innerHTML = dates.map(date =>
    `<option value="${esc(date)}">${esc(date)}</option>`
  ).join("");
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
  const promise = fetch(`data/days/${compactDate(date)}.json?v=${catalog.latest_date}`)
    .then(response => {
      if (!response.ok) throw Error("按日汇总读取失败");
      return response.json();
    });
  dayCache.set(date, promise);
  try {
    return await promise;
  } catch (error) {
    dayCache.delete(date);
    throw error;
  }
}

function modelSummary(models) {
  const sorted = [...(models || [])].sort((a, b) => b.machine_count - a.machine_count);
  const visible = sorted.slice(0, 5);
  const rest = sorted.slice(5);
  if (rest.length) {
    visible.push({
      model: `其他 ${rest.length} 种`,
      machine_count: rest.reduce((total, item) => total + item.machine_count, 0),
      rest: true,
    });
  }
  return { sorted, visible, rest };
}

function detailAvailable() {
  return (catalog.detail_dates || []).includes(selectedDate);
}

function cardHTML(row) {
  if (row.missing) {
    return `<article class="warehouse-card missing-card">
      <div class="card-head"><div class="card-title"><strong>${esc(row.warehouse_name)}</strong><span class="status">本小时无记录</span></div></div>
      <span>没有可用于汇总的矿机小时数据</span>
    </article>`;
  }
  const overload = row.load_ratio > 1;
  const width = Math.max(0, Math.min(100, (row.load_ratio || 0) * 100));
  const models = modelSummary(row.models);
  const stack = models.visible.map((item, index) =>
    `<i style="width:${row.machine_count ? item.machine_count / row.machine_count * 100 : 0}%;background:${palette[index % palette.length]}" title="${esc(item.model || "未记录")}：${item.machine_count} 台"></i>`
  ).join("");
  const tags = models.visible.map((item, index) =>
    `<span class="model-tag" title="${esc(item.model || "未记录")}：${item.machine_count} 台"><i style="background:${palette[index % palette.length]}"></i>${esc(item.model || "未记录")} <b>${item.machine_count}</b></span>`
  ).join("");
  const modes = [...(row.work_modes || [])].sort((a, b) => b.machine_count - a.machine_count);
  const modeRows = modes.map((item, index) => `
    <div class="mode-row" style="--mode-color:${palette[index % palette.length]}" title="${esc(item.work_mode || "未记录")}：${item.machine_count} 台">
      <span><i></i><span class="mode-name">${esc(item.work_mode || "未记录")}</span></span>
      <b>${item.machine_count} 台</b>
    </div>`).join("");
  const coverage = ratioCoverage(row);
  const surplus = row.capacity_difference_kw == null
    ? "—" : fmt(row.available_capacity_kw);
  const details = detailAvailable()
    ? `<button type="button" data-id="${esc(row.warehouse_id)}" aria-label="查看 ${esc(row.warehouse_name)} 明细">详情<i data-lucide="arrow-up-right"></i></button>`
    : `<button type="button" disabled title="历史日期仅保留矿箱汇总，明细保留最新一天">仅汇总</button>`;
  return `<article class="warehouse-card${overload ? " overload" : ""}">
    <div class="card-head">
      <div class="card-title"><strong>${esc(row.warehouse_name)}</strong><span class="status">${overload ? "超理论功率" : "理论功率内"}</span></div>
      ${details}
    </div>
    <div class="power-line"><span class="actual-power">${fmt(row.actual_power_kw)}<small>kW 实际</small></span><span class="theory-power">理论 <strong>${fmt(row.theoretical_power_kw)}</strong> kW</span></div>
    <div class="load-track"><i style="width:${width}%"></i></div>
    <div class="load-labels"><span>理论功率负载 <strong>${percent(row.load_ratio)}</strong></span><span>100% = 理论功率</span></div>
    <div class="card-facts">
      <div class="card-fact"><div class="fact-label">理论余量</div><div class="fact-value ${row.capacity_difference_kw < 0 ? "deficit" : "surplus"}">${surplus}<small>kW</small></div></div>
      <div class="card-fact"><div class="fact-label">整体功耗比</div><div class="fact-value">${fmt(row.power_ratio_overall_w_per_th)}<small>W/TH</small></div></div>
      <div class="card-fact"><div class="fact-label">矿机 · 算力组</div><div class="fact-value">${row.machine_count}<small>/ ${row.template_count}</small></div></div>
    </div>
    <div class="composition">
      <div class="composition-title"><span>型号分布</span><span>${row.machine_count} 台</span></div>
      <div class="model-stack">${stack}</div>
      <div class="model-tags">${tags}</div>
      <div class="mode-block">
        <div class="mode-title">档位分布</div>
        <div class="mode-list">${modeRows || '<div class="mode-row"><span>未记录</span></div>'}</div>
      </div>
    </div>
    <div class="card-foot"><span class="${coverage != null && coverage < .9 ? "warn" : ""}" title="算力和功耗均大于 0、可计算功耗比的矿机占本箱矿机的比例">功耗比样本 ${row.power_ratio_sample_count} / ${row.machine_count}</span><span>${fmt(row.avg_hashrate_ths)} TH/s 平均</span></div>
  </article>`;
}

function render() {
  if (!dayData) return;
  const centerId = $("site").value;
  const site = currentSite();
  const hour = Number($("hour").value);
  currentRows = dayData.warehouse_rows.filter(row =>
    row.data_center_id === centerId && row.hour === hour
  );
  const machineCount = sum(currentRows, "machine_count");
  const actualPower = sum(currentRows, "actual_power_kw");
  const theoryPower = sum(currentRows, "theoretical_power_kw");
  const validSamples = sum(currentRows, "power_ratio_sample_count");
  $("brand-mark").textContent = site.data_center_name.charAt(0).toUpperCase();
  $("brand-name").textContent = site.data_center_name;
  $("trend-title").textContent = `${site.data_center_name} 功耗比趋势`;
  $("trend").setAttribute("aria-label", `${site.data_center_name} 功耗比趋势`);
  $("meta").textContent = `${catalog.date_range.start} 至 ${catalog.date_range.end} · 当前 ${selectedDate} · ${hours.length} 个小时 · ${site.warehouse_count} 个矿箱`;
  document.title = `${site.data_center_name} · 矿箱负荷`;
  $("metrics").innerHTML = metric("上报实际功率", fmt(actualPower), "kW", "矿机小时平均功耗之和")
    + metric("对应理论功率", fmt(theoryPower), "kW", `${currentRows.length} / ${site.warehouse_count} 个有数据矿箱`)
    + metric("理论余量", fmt(sum(currentRows, "available_capacity_kw")), "kW", "逐箱余量之和，超载不抵扣")
    + metric("样本整体功耗比", fmt(ratio(currentRows)), "W/TH", `可计算样本 ${validSamples} / ${machineCount}`)
    + metric("上报矿机", fmt(machineCount, 0), "台", `有数据 ${currentRows.length} / ${site.warehouse_count} 箱`);

  const search = $("search").value.trim().toLowerCase();
  let rows = warehouses.filter(warehouse =>
    warehouse.data_center_id === centerId
  ).map(warehouse =>
    currentRows.find(row => row.warehouse_id === warehouse.warehouse_id)
    || { ...warehouse, hour, missing: true }
  );
  rows = rows.filter(row => JSON.stringify([
    row.warehouse_name, row.models, row.work_modes, row.templates,
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
  return site.daily_summary.map(item => ({
    key: item.date,
    label: shortDate(item.date),
    value: item.power_ratio_overall_w_per_th,
    detail: item,
  }));
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
  if (!dayData || !hours.length) return;
  const series = trendMode === "daily" ? dailySeries() : hourlySeries();
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
  const averageLabel = trendMode === "daily" ? "近 7 天均值" : "当日小时均值";
  $("trend-summary").innerHTML = `
    <span class="trend-stat current">
      <span class="trend-stat-label">${currentLabel}</span>
      <span class="trend-stat-value">${fmt(selected?.value)}</span>
      <span class="trend-stat-unit">W/TH</span>
      <span class="trend-stat-context">${esc(selected?.label || "")}</span>
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
    return `<rect class="chart-hit" x="${x(index) - hitWidth / 2}" y="${pad.top}" width="${hitWidth}" height="${plotH}" tabindex="0" role="button" data-chart-key="${esc(item.key)}" aria-label="${esc(dateText)}，功耗比 ${fmt(value)} W/TH，点击查看"><title>${esc(dateText)} · ${fmt(value)} W/TH · 样本 ${detail.power_ratio_sample_count ?? "—"}/${detail.machine_count ?? "—"}</title></rect>
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
  tooltip.innerHTML = `<strong>${fmt(item.value)} W/TH</strong><span>${esc(dateText)}<br>功耗比样本 ${detail.power_ratio_sample_count ?? "—"} / ${detail.machine_count ?? "—"}</span>`;
  const x = pad.left + (series.length === 1 ? plotW / 2 : plotW * index / (series.length - 1));
  const yPos = item.value == null ? pad.top
    : pad.top + plotH * (1 - (item.value - minValue) / (maxValue - minValue));
  tooltip.style.left = `${Math.max(75, Math.min(rect.width - 75, x / scale))}px`;
  tooltip.style.top = `${yPos / scale - 8}px`;
  tooltip.hidden = false;
}

async function selectDate(date, preferredHour) {
  selectedDate = date;
  $("date").value = date;
  populateHours();
  if (preferredHour != null) {
    const candidate = [...hours].reverse().find(hour => hour <= preferredHour);
    if (candidate) $("hour").value = candidate;
  }
  dayData = await loadDay(date);
  render();
}

function bindChart() {
  const svg = $("trend");
  svg.addEventListener("pointermove", showTooltip);
  svg.addEventListener("pointerleave", () => { $("chart-tooltip").hidden = true; });
  svg.addEventListener("click", async event => {
    const target = event.target.closest("[data-chart-key]");
    if (!target) return;
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

async function fetchGzipJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw Error("明细读取失败");
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  if (typeof DecompressionStream === "undefined") {
    throw Error("浏览器不支持压缩明细读取");
  }
  const stream = new Blob([buffer]).stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).json();
}

async function openDetail(id) {
  const row = currentRows.find(item => item.warehouse_id === id);
  if (!row || !detailAvailable()) return;
  const token = ++requestVersion;
  detailData = null;
  detailBundle = null;
  $("detail-title").textContent = `${row.warehouse_name} · 矿箱详情`;
  $("detail-meta").textContent = `${row.data_center_name} · ${hourLabel(row.hour)} · 数据库业务小时`;
  $("detail-metrics").innerHTML = metric("实际功率", fmt(row.actual_power_kw), "kW")
    + metric("理论余量", fmt(row.available_capacity_kw), "kW")
    + metric("平均 / 最高温度", `${fmt(row.temperature_avg_c)} / ${fmt(row.temperature_max_c)}`, "°C")
    + metric("平均 / 最大拒绝率", `${percent(row.rejected_rate_avg)} / ${percent(row.rejected_rate_max)}`, "")
    + metric("平均单机算力", fmt(row.avg_hashrate_ths), "TH/s");
  $("detail-search").value = "";
  $("detail").showModal();
  $("detail-content").innerHTML = "<p>正在读取矿箱明细…</p>";
  const key = `${row.data_center_id}/${compactDate(selectedDate)}/${row.warehouse_id}`;
  try {
    if (!detailCache.has(key)) {
      detailCache.set(key, fetchGzipJson(
        `data/details/${row.data_center_id}/${compactDate(selectedDate)}/${row.warehouse_id}.json.gz`
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

function renderDetail() {
  document.querySelectorAll("[data-level]").forEach(button =>
    button.setAttribute("aria-selected", button.dataset.level === level));
  if (!detailData) return;
  const search = $("detail-search").value.trim().toLowerCase();
  const rows = detailData[level].filter(row =>
    [row.template_name, row.template_id, row.model, row.work_mode, row.ip]
      .some(value => String(value ?? "").toLowerCase().includes(search)));
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
  $("detail-content").innerHTML = `<table><thead><tr>${columns.map(([label]) => `<th>${label}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(([, key]) => `<td>${esc(key.includes("rejected") ? percent(row[key]) : typeof row[key] === "number" ? fmt(row[key]) : row[key] ?? "未记录")}</td>`).join("")}</tr>`).join("")}</tbody></table>${rows.length ? "" : "<p>没有符合条件的明细。</p>"}`;
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
  const button = event.target.closest("[data-id]");
  if (button) openDetail(button.dataset.id);
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
    $("meta").textContent = "看板数据读取失败";
    $("notice").textContent = "尚无可用数据，请检查导出及发布结果。";
    console.error(error);
  }
})();
