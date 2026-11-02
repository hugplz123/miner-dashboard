import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = path.dirname(fileURLToPath(import.meta.url));
const site = process.argv[2] ?? "nimrod01";
const date = process.argv[3] ?? "20261029";
if (!["nimrod01", "whiteoak01"].includes(site) || !/^\d{8}$/.test(date)) {
  throw new Error("Usage: node build_sample_xlsx.mjs [nimrod01|whiteoak01] [YYYYMMDD]");
}
const prefix = `${site}_${date}`;
const outputDir = path.join(root, "outputs", `${date}-${site}`);
const outputPath = path.join(outputDir, `${prefix}_warehouse_load_dashboard.xlsx`);
const loadCsv = async (suffix, sheetName) => Workbook.fromCSV(
  (await fs.readFile(path.join(root, "output", `${prefix}_${suffix}.csv`), "utf8"))
    .replace(/^\uFEFF/, ""),
  { sheetName },
);
const workbook = await loadCsv("warehouse_hourly", "矿箱小时汇总");
for (const [suffix, sheetName] of [
  ["template_hourly", "算力组"],
  ["model_hourly", "型号"],
  ["work_mode_hourly", "档位"],
]) {
  const sourceBook = await loadCsv(suffix, sheetName);
  const sheet = workbook.worksheets.add(sheetName);
  sheet.getRange("A1").write(sourceBook.worksheets.getItemAt(0).getUsedRange().values);
}

function columnName(index) {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + (value - 1) % 26) + name;
  }
  return name;
}

for (const [sheetName, tableName] of [
  ["矿箱小时汇总", "WarehouseHourlySummary"],
  ["算力组", "TemplateHourly"],
  ["型号", "ModelHourly"],
  ["档位", "WorkModeHourly"],
]) {
  const sheet = workbook.worksheets.getItem(sheetName);
  const used = sheet.getUsedRange();
  const values = used.values;
  const headers = values[0];
  for (let row = 1; row < values.length; row += 1) {
    for (let col = 0; col < headers.length; col += 1) {
      const label = headers[col];
      const value = values[row][col];
      const numeric = label === "小时" || label.startsWith("矿机数量")
        || label === "算力组数量"
        || /拒绝率|负载率|功率|功耗|负荷|容量差额|温度|平均算力/.test(label);
      if (numeric && value !== "" && Number.isFinite(Number(value))) {
        values[row][col] = Number(value);
      } else if (["各型号矿机数量", "算力组ID及名称"].includes(label)) {
        values[row][col] = String(value).split("; ").join("\n");
      }
    }
  }
  used.values = values;
  const lastRow = values.length;
  const lastCol = columnName(headers.length - 1);
  sheet.tables.add(`A1:${lastCol}${lastRow}`, true, tableName);
  sheet.showGridLines = false;
  sheet.freezePanes.freezeRows(1);
  used.format.font = { name: "Arial", size: 10, color: "#263238" };
  used.format.verticalAlignment = "center";
  used.format.rowHeight = 26;
  sheet.getRange(`A1:${lastCol}1`).format = {
    fill: "#34495E",
    font: { name: "Arial", size: 10, bold: true, color: "#FFFFFF" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
    rowHeight: 40,
  };
  headers.forEach((label, col) => {
    const letter = columnName(col);
    const data = sheet.getRange(`${letter}2:${letter}${lastRow}`);
    let width = 21;
    if (label.endsWith("ID")) width = 36;
    if (["场地名称", "矿箱号", "小时", "算力组数量", "矿机数量"].includes(label)) width = 15;
    if (label === "型号") width = 30;
    if (label === "算力组名称") width = 42;
    if (label === "档位(work_mode)") width = 30;
    if (label === "各型号矿机数量") width = 42;
    if (label === "算力组ID及名称") width = 58;
    sheet.getRange(`${letter}:${letter}`).format.columnWidth = width;
    if (/拒绝率|负载率/.test(label)) data.setNumberFormat("0.00%");
    else if (/温度/.test(label)) data.setNumberFormat("0.0");
    else if (/功率|功耗|负荷|容量差额|平均算力/.test(label)
             && !label.endsWith("样本数")) {
      data.setNumberFormat("#,##0.00");
    } else if (label === "小时" || /数量|样本数/.test(label)) data.setNumberFormat("0");
    if (["各型号矿机数量", "算力组ID及名称"].includes(label)) data.format.wrapText = true;
  });
  if (sheetName === "矿箱小时汇总") {
    const modelCol = headers.indexOf("各型号矿机数量");
    const templateCol = headers.indexOf("算力组ID及名称");
    for (let row = 1; row < values.length; row += 1) {
      const lines = Math.max(
        String(values[row][modelCol]).split("\n").length,
        String(values[row][templateCol]).split("\n").length * 2,
      );
      sheet.getRange(`A${row + 1}:${lastCol}${row + 1}`).format.rowHeight = Math.max(28, lines * 15);
    }
  }
}
workbook.recalculate();
console.log((await workbook.inspect({
  kind: "table", range: "矿箱小时汇总!F1:W3", include: "values",
  tableMaxRows: 3, tableMaxCols: 18, maxChars: 5000,
})).ndjson);
await fs.mkdir(outputDir, { recursive: true });
for (const [name, sheetName, range] of [
  ["preview", "矿箱小时汇总", "E1:I5"],
  ["metrics", "矿箱小时汇总", "J1:W5"],
  ["dimensions", "档位", "E1:J6"],
]) {
  const preview = await workbook.render({ sheetName, range, scale: 1.5, format: "png" });
  await fs.writeFile(path.join(outputDir, `${name}.png`), new Uint8Array(await preview.arrayBuffer()));
}
console.log((await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!",
  options: { useRegex: true, maxResults: 10 },
})).ndjson);
await (await SpreadsheetFile.exportXlsx(workbook)).save(outputPath);
console.log(outputPath);
