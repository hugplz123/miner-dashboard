import argparse
import csv
import datetime as dt
import json
import sys
import zipfile
from collections import defaultdict
from decimal import Decimal
from pathlib import Path
from xml.etree import ElementTree as ET

VENDOR_DIR = Path(__file__).resolve().parent.parent / "功耗数据更新" / "vendor"
if VENDOR_DIR.exists():
    sys.path.insert(0, str(VENDOR_DIR))

import pymysql
import tomli

SITES = {
    "Nimrod01": "1c675cf08cea473393c3cfa01976b065",
    "Nimrod02": "2da96783a4bf449a90f81d4d9c5fc884",
    "WhiteOak01": "435d3ecd71a34488a17c5f788a0f25ca",
    "May01": "abca092860704393bcf1070462510797",
    "Blossom01": "c0449798c6494a49bac60a6d924c9115",
}
SOURCE_TEMPERATURE_UNIT = "fahrenheit"
TEMPERATURE_VALID_MAX = Decimal(250)  # 250 F = 121 C
HASHRATE_PER_TH = Decimal(10**12)
QUERY_CHUNK_HOURS = 6
DEFAULT_THEORETICAL_POWER_PATH = Path("inputs") / "矿箱理论功率.xlsx"
SUMMARY_API_FIELDS = {
    "data_center_id": "场地ID", "data_center_name": "场地名称",
    "hour": "小时", "warehouse_id": "矿箱ID", "warehouse_name": "矿箱号",
    "machine_count": "矿机数量(去重IP)", "template_count": "算力组数量",
    "actual_power_kw": "实际功率(kW)",
    "theoretical_power_kw": "理论功率(kW)",
    "load_ratio": "负载率",
    "capacity_difference_kw": "容量差额(kW)",
    "available_capacity_kw": "可填负荷(kW)",
    "rejected_rate_max": "最大拒绝率", "rejected_rate_min": "最小拒绝率",
    "rejected_rate_avg": "平均拒绝率", "avg_hashrate_ths": "平均算力(TH/s)",
    "avg_power_w": "平均功耗(W)",
    "power_ratio_avg_w_per_th": "平均单机功耗比(W/TH)",
    "power_ratio_max_w_per_th": "最大单机功耗比(W/TH)",
    "power_ratio_min_w_per_th": "最小单机功耗比(W/TH)",
    "power_ratio_overall_w_per_th": "整体功耗比(W/TH)",
    "power_ratio_sample_count": "单机功耗比有效样本数",
    "temperature_max_c": "最高温度(°C)", "temperature_min_c": "最低温度(°C)",
    "temperature_avg_c": "平均温度(°C)",
}
DETAIL_FIELDS = [
    "场地ID", "场地名称", "小时", "矿箱ID", "矿箱号", "IP", "型号",
    "算力组ID", "算力组名称", "档位(work_mode)",
    "平均算力(TH/s)", "平均功耗(W)",
    "单机功耗比(W/TH)", "拒绝率", "温度(°C)", "MAC", "源记录ID",
    "worker_location",
]
METRIC_FIELDS = [
    "矿机数量(去重IP)", "最大拒绝率", "最小拒绝率", "平均拒绝率",
    "平均算力(TH/s)", "平均功耗(W)", "平均单机功耗比(W/TH)",
    "最大单机功耗比(W/TH)", "最小单机功耗比(W/TH)",
    "整体功耗比(W/TH)", "单机功耗比有效样本数",
    "最高温度(°C)", "最低温度(°C)", "平均温度(°C)",
]
HIERARCHY_IDENTITIES = {
    "template": ["场地ID", "场地名称", "小时", "矿箱ID", "矿箱号",
                 "算力组ID", "算力组名称"],
    "model": ["场地ID", "场地名称", "小时", "矿箱ID", "矿箱号",
              "算力组ID", "算力组名称", "型号"],
    "work_mode": ["场地ID", "场地名称", "小时", "矿箱ID", "矿箱号",
                  "算力组ID", "算力组名称", "型号", "档位(work_mode)"],
}
API_IDENTITY_FIELDS = {
    "场地ID": "data_center_id", "场地名称": "data_center_name",
    "小时": "hour", "矿箱ID": "warehouse_id", "矿箱号": "warehouse_name",
    "算力组ID": "template_id", "算力组名称": "template_name",
    "型号": "model", "档位(work_mode)": "work_mode",
}
SUMMARY_QUERY_COLUMNS = """
    id, data_center_id, client_miner_template_id, model, ip, hour,
    avg_hashrate, rejected_rate, avg_power, temperature, work_mode,
    worker_location, gmt_create, gmt_modified
"""
FULL_QUERY_COLUMNS = """
    id, data_center_id, client_miner_template_id, model, ip, hour, mac,
    avg_hashrate, rejected_rate, avg_power, temperature, work_mode,
    worker_location, gmt_create, gmt_modified
"""


def read_config(path):
    path = Path(path)
    if not path.exists():
        return {
            "main_db": {
                "host": __import__("os").environ["DB_HOST"],
                "port": __import__("os").environ.get("DB_PORT", "3306"),
                "user": __import__("os").environ["DB_USER"],
                "password": __import__("os").environ["DB_PASSWORD"],
            }
        }
    with Path(path).open("rb") as stream:
        return tomli.load(stream)


def normalize_warehouse_name(value):
    text = str(value or "").strip().upper()
    if len(text) > 1 and text[0] == "C" and text[1:].isdigit():
        return f"C{int(text[1:]):02d}"
    return text


def iter_hour_chunks(start_hour, end_hour, chunk_hours):
    current = dt.datetime.strptime(str(start_hour), "%Y%m%d%H")
    end = dt.datetime.strptime(str(end_hour), "%Y%m%d%H")
    while current < end:
        chunk_end = min(current + dt.timedelta(hours=chunk_hours), end)
        yield (
            int(current.strftime("%Y%m%d%H")),
            int(chunk_end.strftime("%Y%m%d%H")),
        )
        current = chunk_end


def read_theoretical_power(path):
    """Read the first three columns of the supplied xlsx without extra dependencies."""
    path = Path(path)
    if not path.exists():
        return {}
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    rel_ns = {
        "r": "http://schemas.openxmlformats.org/package/2006/relationships"
    }
    with zipfile.ZipFile(path) as archive:
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root.findall("m:si", ns):
                shared.append("".join(
                    node.text or "" for node in item.iter()
                    if node.tag.endswith("}t")
                ))
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        sheet = workbook.find("m:sheets/m:sheet", ns)
        rel_id = sheet.attrib[
            "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
        ]
        relationships = ET.fromstring(
            archive.read("xl/_rels/workbook.xml.rels")
        )
        target = next(
            rel.attrib["Target"] for rel in relationships.findall("r:Relationship", rel_ns)
            if rel.attrib["Id"] == rel_id
        )
        sheet_path = target.lstrip("/")
        if not sheet_path.startswith("xl/"):
            sheet_path = "xl/" + sheet_path
        sheet_root = ET.fromstring(archive.read(sheet_path))
        values = []
        for row in sheet_root.findall(".//m:sheetData/m:row", ns):
            cells = {}
            for cell in row.findall("m:c", ns):
                reference = cell.attrib.get("r", "")
                column = "".join(ch for ch in reference if ch.isalpha())
                value_node = cell.find("m:v", ns)
                value = value_node.text if value_node is not None else ""
                if cell.attrib.get("t") == "s" and value:
                    value = shared[int(value)]
                cells[column] = value
            values.append([cells.get("A", ""), cells.get("B", ""), cells.get("C", "")])
    result = {}
    for site, warehouse, power in values[1:]:
        if not site or not warehouse or power == "":
            continue
        key = (str(site).strip().lower(), normalize_warehouse_name(warehouse))
        if key in result:
            raise ValueError(f"Duplicate theoretical power key: {key}")
        result[key] = Decimal(str(power))
    return result


def connect(conf):
    return pymysql.connect(
        host=conf["host"],
        port=int(conf.get("port", 3306)),
        user=conf["user"],
        password=conf.get("password") or __import__("os").environ[conf["password_env"]],
        database="tdtc_core",
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        connect_timeout=15,
        read_timeout=int(conf.get("read_timeout", 600)),
        write_timeout=60,
    )


def temperature_to_celsius(value):
    if value is None:
        return None
    value = Decimal(value)
    # Some sites never populate temperature: every row is 0. Treat non-positive
    # readings as missing instead of turning 0 F into a misleading -17.8 C.
    if value <= 0 or value > TEMPERATURE_VALID_MAX:
        return None
    if SOURCE_TEMPERATURE_UNIT == "fahrenheit":
        return (value - Decimal(32)) * Decimal(5) / Decimal(9)
    if SOURCE_TEMPERATURE_UNIT == "celsius":
        return value
    raise ValueError(f"Unsupported temperature unit: {SOURCE_TEMPERATURE_UNIT}")


def mean(values):
    return sum(values, Decimal(0)) / len(values) if values else None


def aggregate_metrics(machines):
    hash_values = [m["平均算力(TH/s)"] for m in machines
                   if m["平均算力(TH/s)"] is not None]
    power_values = [m["平均功耗(W)"] for m in machines
                    if m["平均功耗(W)"] is not None]
    reject_values = [m["拒绝率"] for m in machines if m["拒绝率"] is not None]
    temp_values = [m["温度(°C)"] for m in machines if m["温度(°C)"] is not None]
    ratio_values = [m["单机功耗比(W/TH)"] for m in machines
                    if m["单机功耗比(W/TH)"] is not None]
    valid_pairs = [
        m for m in machines
        if m["平均算力(TH/s)"] is not None and m["平均算力(TH/s)"] > 0
        and m["平均功耗(W)"] is not None and m["平均功耗(W)"] > 0
    ]
    valid_hashrate = sum(
        (m["平均算力(TH/s)"] for m in valid_pairs), Decimal(0)
    )
    valid_power = sum((m["平均功耗(W)"] for m in valid_pairs), Decimal(0))
    metrics = {
        "矿机数量(去重IP)": len(machines),
        "最大拒绝率": max(reject_values) if reject_values else None,
        "最小拒绝率": min(reject_values) if reject_values else None,
        "平均拒绝率": mean(reject_values),
        "平均算力(TH/s)": mean(hash_values),
        "平均功耗(W)": mean(power_values),
        "平均单机功耗比(W/TH)": mean(ratio_values),
        "最大单机功耗比(W/TH)": max(ratio_values) if ratio_values else None,
        "最小单机功耗比(W/TH)": min(ratio_values) if ratio_values else None,
        "整体功耗比(W/TH)": (
            valid_power / valid_hashrate if valid_hashrate > 0 else None
        ),
        "单机功耗比有效样本数": len(ratio_values),
        "最高温度(°C)": max(temp_values) if temp_values else None,
        "最低温度(°C)": min(temp_values) if temp_values else None,
        "平均温度(°C)": mean(temp_values),
    }
    samples = {
        metric: {"count": len(values),
                 "sum": sum(values, Decimal(0)) if values else None}
        for metric, values in (
            ("hashrate_ths", hash_values), ("power_w", power_values),
            ("rejected_rate", reject_values), ("temperature_c", temp_values),
            ("power_ratio_w_per_th", ratio_values),
        )
    }
    return metrics, samples, valid_power, valid_hashrate


def hierarchy_api_row(row, identity_fields):
    api = {
        API_IDENTITY_FIELDS[field]: row[field] or None
        for field in identity_fields
    }
    for field, label in SUMMARY_API_FIELDS.items():
        if label in METRIC_FIELDS:
            api[field] = row[label]
    api["metric_samples"] = row["_metric_samples"]
    api["power_ratio_valid_power_sum_w"] = row["_valid_power_w"]
    api["power_ratio_valid_hashrate_sum_ths"] = row["_valid_hashrate_ths"]
    return api


def machine_api_row(row):
    return {
        "data_center_id": row["场地ID"],
        "data_center_name": row["场地名称"],
        "hour": row["小时"],
        "warehouse_id": row["矿箱ID"],
        "warehouse_name": row["矿箱号"],
        "template_id": row["算力组ID"] or None,
        "template_name": row["算力组名称"] or None,
        "model": row["型号"] or None,
        "work_mode": row["档位(work_mode)"] or None,
        "ip": row["IP"],
        "mac": row["MAC"] or None,
        "avg_hashrate_ths": row["平均算力(TH/s)"],
        "avg_power_w": row["平均功耗(W)"],
        "power_ratio_w_per_th": row["单机功耗比(W/TH)"],
        "rejected_rate": row["拒绝率"],
        "temperature_c": row["温度(°C)"],
        "source_id": row["源记录ID"],
        "worker_location": row["worker_location"],
    }


def warehouse_summary_query(source_table, center_id, start_hour, end_hour,
                            warehouse_ids):
    placeholders = ",".join(["%s"] * len(warehouse_ids))
    return f"""
        WITH ranked AS (
            SELECT
                id, client_miner_template_id, model, ip, hour, avg_hashrate,
                rejected_rate, avg_power, temperature, work_mode,
                worker_location,
                ROW_NUMBER() OVER (
                    PARTITION BY hour, ip
                    ORDER BY gmt_modified DESC, gmt_create DESC, id DESC
                ) AS source_rank
            FROM `{source_table}`
            WHERE data_center_id = %s AND hour >= %s AND hour < %s
        ),
        located AS (
            SELECT *,
                CASE
                    WHEN JSON_VALID(worker_location)
                         AND JSON_LENGTH(worker_location) > 0
                    THEN SUBSTRING_INDEX(
                        JSON_UNQUOTE(JSON_EXTRACT(worker_location, '$[0]')),
                        '-', 1
                    )
                    ELSE NULL
                END AS warehouse_id
            FROM ranked
            WHERE source_rank = 1
        ),
        machines AS (
            SELECT *
            FROM located
            WHERE warehouse_id IN ({placeholders})
              AND ip IS NOT NULL AND ip <> ''
        ),
        by_model AS (
            SELECT warehouse_id, hour, COALESCE(model, '') AS model,
                   COUNT(*) AS machine_count
            FROM machines
            GROUP BY warehouse_id, hour, COALESCE(model, '')
        ),
        by_template AS (
            SELECT warehouse_id, hour,
                   COALESCE(client_miner_template_id, '') AS template_id,
                   COUNT(*) AS machine_count
            FROM machines
            GROUP BY warehouse_id, hour,
                     COALESCE(client_miner_template_id, '')
        ),
        by_work_mode AS (
            SELECT warehouse_id, hour, COALESCE(work_mode, '') AS work_mode,
                   COUNT(*) AS machine_count
            FROM machines
            GROUP BY warehouse_id, hour, COALESCE(work_mode, '')
        ),
        metrics AS (
            SELECT
                warehouse_id,
                hour,
                COUNT(DISTINCT ip) AS machine_count,
                COUNT(DISTINCT NULLIF(client_miner_template_id, ''))
                    AS template_count,
                MAX(rejected_rate) AS rejected_rate_max,
                MIN(rejected_rate) AS rejected_rate_min,
                AVG(rejected_rate) AS rejected_rate_avg,
                SUM(rejected_rate) AS rejected_rate_sum,
                COUNT(rejected_rate) AS rejected_rate_count,
                AVG(avg_hashrate) / 1000000000000
                    AS avg_hashrate_ths,
                SUM(avg_hashrate) / 1000000000000
                    AS hashrate_sum_ths,
                COUNT(avg_hashrate) AS hashrate_count,
                AVG(avg_power) AS avg_power_w,
                SUM(avg_power) AS power_sum_w,
                COUNT(avg_power) AS power_count,
                AVG(CASE
                    WHEN avg_hashrate > 0 AND avg_power > 0
                    THEN avg_power / (avg_hashrate / 1000000000000)
                END) AS power_ratio_avg_w_per_th,
                MAX(CASE
                    WHEN avg_hashrate > 0 AND avg_power > 0
                    THEN avg_power / (avg_hashrate / 1000000000000)
                END) AS power_ratio_max_w_per_th,
                MIN(CASE
                    WHEN avg_hashrate > 0 AND avg_power > 0
                    THEN avg_power / (avg_hashrate / 1000000000000)
                END) AS power_ratio_min_w_per_th,
                SUM(CASE
                    WHEN avg_hashrate > 0 AND avg_power > 0
                    THEN avg_power / (avg_hashrate / 1000000000000)
                END) AS power_ratio_sum_w_per_th,
                COUNT(CASE
                    WHEN avg_hashrate > 0 AND avg_power > 0 THEN 1
                END) AS power_ratio_sample_count,
                SUM(CASE
                    WHEN avg_hashrate > 0 AND avg_power > 0 THEN avg_power
                    ELSE 0
                END) AS valid_power_sum_w,
                SUM(CASE
                    WHEN avg_hashrate > 0 AND avg_power > 0 THEN avg_hashrate
                    ELSE 0
                END) / 1000000000000 AS valid_hashrate_sum_ths,
                SUM(CASE
                    WHEN avg_hashrate > 0 AND avg_power > 0
                    THEN avg_power / (avg_hashrate / 1000000000000)
                END) AS ratio_sum,
                MAX(CASE WHEN temperature > 0 AND temperature <= 250
                    THEN (temperature - 32) * 5 / 9 END) AS temperature_max_c,
                MIN(CASE WHEN temperature > 0 AND temperature <= 250
                    THEN (temperature - 32) * 5 / 9 END) AS temperature_min_c,
                AVG(CASE WHEN temperature > 0 AND temperature <= 250
                    THEN (temperature - 32) * 5 / 9 END) AS temperature_avg_c,
                SUM(CASE WHEN temperature > 0 AND temperature <= 250
                    THEN (temperature - 32) * 5 / 9 ELSE 0 END)
                    AS temperature_sum_c,
                SUM(CASE WHEN temperature > 0 AND temperature <= 250
                    THEN 1 ELSE 0 END) AS temperature_count,
                SUM(avg_power) / 1000 AS actual_power_kw
            FROM machines
            GROUP BY warehouse_id, hour
        )
        SELECT
            m.*,
            bm.model_counts,
            bt.template_counts,
            bw.work_mode_counts
        FROM metrics m
        LEFT JOIN (
            SELECT warehouse_id, hour,
                   JSON_OBJECTAGG(model, machine_count) AS model_counts
            FROM by_model
            GROUP BY warehouse_id, hour
        ) bm ON bm.warehouse_id = m.warehouse_id AND bm.hour = m.hour
        LEFT JOIN (
            SELECT warehouse_id, hour,
                   JSON_OBJECTAGG(template_id, machine_count)
                       AS template_counts
            FROM by_template
            GROUP BY warehouse_id, hour
        ) bt ON bt.warehouse_id = m.warehouse_id AND bt.hour = m.hour
        LEFT JOIN (
            SELECT warehouse_id, hour,
                   JSON_OBJECTAGG(work_mode, machine_count)
                       AS work_mode_counts
            FROM by_work_mode
            GROUP BY warehouse_id, hour
        ) bw ON bw.warehouse_id = m.warehouse_id AND bw.hour = m.hour
    """


def warehouse_machine_rows_query(source_table, start_hour, end_hour,
                                 warehouse_ids):
    """Return compact deduplicated machine rows for Python-side aggregation."""
    placeholders = ",".join(["%s"] * len(warehouse_ids))
    return f"""
        WITH ranked AS (
            SELECT
                client_miner_template_id, model, ip, hour, avg_hashrate,
                rejected_rate, avg_power, temperature, work_mode,
                worker_location,
                ROW_NUMBER() OVER (
                    PARTITION BY hour, ip
                    ORDER BY gmt_modified DESC, gmt_create DESC, id DESC
                ) AS source_rank
            FROM `{source_table}`
            WHERE data_center_id = %s AND hour >= %s AND hour < %s
        ),
        located AS (
            SELECT *,
                CASE
                    WHEN JSON_VALID(worker_location)
                         AND JSON_LENGTH(worker_location) > 0
                    THEN SUBSTRING_INDEX(
                        JSON_UNQUOTE(JSON_EXTRACT(worker_location, '$[0]')),
                        '-', 1
                    )
                    ELSE NULL
                END AS warehouse_id
            FROM ranked
            WHERE source_rank = 1
              AND ip IS NOT NULL AND ip <> ''
        )
        SELECT
            warehouse_id, hour, ip, client_miner_template_id, model,
            avg_hashrate, rejected_rate, avg_power, temperature, work_mode
        FROM located
        WHERE warehouse_id IN ({placeholders})
    """


def build_summary_payloads(aggregates, center_id, site, warehouses,
                           templates, theoretical_power):
    def object_value(value):
        if not value:
            return {}
        return value if isinstance(value, dict) else json.loads(value)

    summary_rows = []
    dashboard_rows = []
    for aggregate in aggregates:
        warehouse = warehouses[aggregate["warehouse_id"]]
        models = object_value(aggregate["model_counts"])
        template_counts = object_value(aggregate["template_counts"])
        work_modes = object_value(aggregate["work_mode_counts"])
        template_names = {
            template_id: templates.get(template_id) or "(未匹配)"
            for template_id in template_counts if template_id
        }
        theoretical_power_kw = theoretical_power.get(
            (site.lower(), normalize_warehouse_name(warehouse["name"]))
        )
        actual_power_kw = aggregate["actual_power_kw"]
        capacity_difference_kw = (
            theoretical_power_kw - actual_power_kw
            if theoretical_power_kw is not None else None
        )
        summary = {
            "场地ID": center_id,
            "场地名称": site,
            "小时": aggregate["hour"],
            "矿箱ID": warehouse["id"],
            "矿箱号": warehouse["name"],
            "算力组数量": int(aggregate["template_count"]),
            "各型号矿机数量": "; ".join(
                f"{key or '(空)'}: {value}"
                for key, value in sorted(models.items())
            ),
            "算力组ID及名称": "; ".join(
                f"{key}: {value}"
                for key, value in sorted(template_names.items())
            ),
            "各档位矿机数量": "; ".join(
                f"{key or '(空)'}: {value}"
                for key, value in sorted(work_modes.items())
            ),
            "实际功率(kW)": actual_power_kw,
            "理论功率(kW)": theoretical_power_kw,
            "负载率": (
                actual_power_kw / theoretical_power_kw
                if theoretical_power_kw is not None
                and theoretical_power_kw > 0 else None
            ),
            "容量差额(kW)": capacity_difference_kw,
            "可填负荷(kW)": (
                max(capacity_difference_kw, Decimal(0))
                if capacity_difference_kw is not None else None
            ),
            "矿机数量(去重IP)": int(aggregate["machine_count"]),
            "最大拒绝率": aggregate["rejected_rate_max"],
            "最小拒绝率": aggregate["rejected_rate_min"],
            "平均拒绝率": aggregate["rejected_rate_avg"],
            "平均算力(TH/s)": aggregate["avg_hashrate_ths"],
            "平均功耗(W)": aggregate["avg_power_w"],
            "平均单机功耗比(W/TH)": aggregate[
                "power_ratio_avg_w_per_th"
            ],
            "最大单机功耗比(W/TH)": aggregate[
                "power_ratio_max_w_per_th"
            ],
            "最小单机功耗比(W/TH)": aggregate[
                "power_ratio_min_w_per_th"
            ],
            "整体功耗比(W/TH)": (
                aggregate["valid_power_sum_w"]
                / aggregate["valid_hashrate_sum_ths"]
                if aggregate["valid_hashrate_sum_ths"] else None
            ),
            "单机功耗比有效样本数": int(
                aggregate["power_ratio_sample_count"] or 0
            ),
            "最高温度(°C)": aggregate["temperature_max_c"],
            "最低温度(°C)": aggregate["temperature_min_c"],
            "平均温度(°C)": aggregate["temperature_avg_c"],
        }
        dashboard = {
            field: summary[label] for field, label in SUMMARY_API_FIELDS.items()
        }
        dashboard["models"] = [
            {"model": model or None, "machine_count": int(count)}
            for model, count in sorted(models.items())
        ]
        dashboard["templates"] = [
            {
                "template_id": template_id or None,
                "template_name": templates.get(template_id) or None,
                "machine_count": int(count),
            }
            for template_id, count in sorted(template_counts.items())
        ]
        dashboard["work_modes"] = [
            {"work_mode": work_mode or None, "machine_count": int(count)}
            for work_mode, count in sorted(work_modes.items())
        ]
        dashboard["metric_samples"] = {
            "hashrate_ths": {
                "count": int(aggregate["hashrate_count"] or 0),
                "sum": aggregate["hashrate_sum_ths"],
            },
            "power_w": {
                "count": int(aggregate["power_count"] or 0),
                "sum": aggregate["power_sum_w"],
            },
            "rejected_rate": {
                "count": int(aggregate["rejected_rate_count"] or 0),
                "sum": aggregate["rejected_rate_sum"],
            },
            "temperature_c": {
                "count": int(aggregate["temperature_count"] or 0),
                "sum": aggregate["temperature_sum_c"],
            },
            "power_ratio_w_per_th": {
                "count": int(aggregate["power_ratio_sample_count"] or 0),
                "sum": aggregate["ratio_sum"],
            },
        }
        dashboard["power_ratio_valid_power_sum_w"] = aggregate[
            "valid_power_sum_w"
        ]
        dashboard["power_ratio_valid_hashrate_sum_ths"] = aggregate[
            "valid_hashrate_sum_ths"
        ]
        summary_rows.append(summary)
        dashboard_rows.append(dashboard)
    return summary_rows, dashboard_rows


def write_summary_only_outputs(output_dir, prefix, day, stat_date, site,
                               center_id, sources_table, warehouse_rows,
                               warehouses, summary_rows, dashboard_rows,
                               theoretical_power_path):
    write_csv(output_dir / f"{prefix}_warehouse_hourly.csv", summary_rows,
              fields=list(SUMMARY_API_FIELDS.values())[:7]
              + ["各型号矿机数量", "算力组ID及名称", "各档位矿机数量"]
              + list(SUMMARY_API_FIELDS.values())[7:])
    (output_dir / f"{prefix}_warehouse_dashboard.json").write_text(json.dumps({
        "schema_version": "2.1",
        "purpose": "public_warehouse_hourly_dashboard",
        "data_center_id": center_id,
        "data_center_name": site,
        "date": day.isoformat(),
        "hour_encoding": "YYYYMMDDHH",
        "timezone": None,
        "units": {
            "hashrate": "TH/s", "power": "W", "warehouse_power": "kW",
            "temperature": "C", "power_ratio": "W/TH",
            "rejected_rate": "fraction", "load_ratio": "fraction",
        },
        "warehouses": [
            {"warehouse_id": row["id"], "warehouse_name": row["name"]}
            for row in sorted(warehouses.values(), key=lambda item: item["name"])
        ],
        "warehouse_rows": dashboard_rows,
    }, ensure_ascii=False, indent=2,
        default=lambda value: float(value) if isinstance(value, Decimal) else str(value)),
        encoding="utf-8")
    machine_hours = sum(
        row["矿机数量(去重IP)"] for row in summary_rows
    )
    report = {
        "source_rows": None,
        "deduplicated_machine_hour_rows": machine_hours,
        "summary_rows": len(summary_rows),
        "template_rows": None,
        "model_rows": None,
        "work_mode_rows": None,
        "schema_version": "2.1",
        "data_center_name": site,
        "date": stat_date,
        "source_table": sources_table,
        "warehouse_count": len(warehouses),
        "anomaly_counts": {},
        "hours": sorted({row["小时"] for row in summary_rows}),
        "output_dir": str(output_dir.resolve()),
        "warehouses_with_data": sorted({
            row["矿箱号"] for row in summary_rows
        }),
        "warehouses_without_data": sorted(
            row["name"] for row in warehouse_rows if row.get("type") == 1
            and row["id"] not in {
                summary["矿箱ID"] for summary in summary_rows
            }
        ),
        "summary_machine_count_total": machine_hours,
        "theoretical_power_source": str(Path(theoretical_power_path).resolve()),
        "theoretical_power_matched_rows": sum(
            row["理论功率(kW)"] is not None for row in summary_rows
        ),
    }
    (output_dir / f"{prefix}_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


def export(config_path, stat_date, output_dir, reuse=False, site="Nimrod01",
           theoretical_power_path=DEFAULT_THEORETICAL_POWER_PATH,
           summary_only=False):
    center_id = SITES[site]
    source_table = f"t_machine_worker_hashrate_hour_{center_id}"
    prefix = f"{site.lower()}_{stat_date}"
    day = dt.datetime.strptime(stat_date, "%Y%m%d").date()
    start_hour = int(day.strftime("%Y%m%d") + "00")
    end_hour = int((day + dt.timedelta(days=1)).strftime("%Y%m%d") + "00")
    output_dir.mkdir(parents=True, exist_ok=True)
    theoretical_power = read_theoretical_power(theoretical_power_path)
    cache_path = output_dir / f"{prefix}_source.json"
    query_columns = FULL_QUERY_COLUMNS
    if reuse:
        cache = json.loads(cache_path.read_text(encoding="utf-8"))
        if cache["table"] != source_table or cache["day"] != stat_date:
            raise ValueError("Cache site/date does not match request")
        source_rows = cache["rows"]
        if source_rows and "work_mode" not in source_rows[0]:
            raise ValueError(
                "Cached source has no work_mode; rerun without --reuse to refresh it"
            )
        warehouse_rows = cache["warehouses"]
        templates = cache["templates"]
        for row in source_rows:
            for field in (
                "avg_hashrate", "avg_power", "temperature", "rejected_rate",
                "theory_power_ratio",
            ):
                if row.get(field) is not None:
                    row[field] = Decimal(str(row[field]))
    else:
        conn = connect(read_config(config_path)["main_db"])
        try:
            with conn.cursor() as cur:
                cur.execute("SET TRANSACTION READ ONLY")
                cur.execute("START TRANSACTION WITH CONSISTENT SNAPSHOT")
                cur.execute(
                    """
                    SELECT id, name, data_center_id, type, is_deleted
                    FROM t_data_center_ware_house
                    WHERE data_center_id = %s
                    """,
                    (center_id,),
                )
                warehouse_rows = cur.fetchall()
                source_rows = []
                for chunk_start, chunk_end in iter_hour_chunks(
                    start_hour, end_hour, QUERY_CHUNK_HOURS
                ):
                    cur.execute(
                        f"""
                    SELECT /*+ MAX_EXECUTION_TIME(300000) */
                           {query_columns}
                    FROM `{source_table}`
                    WHERE data_center_id = %s AND hour >= %s AND hour < %s
                    """,
                        (center_id, chunk_start, chunk_end),
                    )
                    hour_rows = cur.fetchall()
                    source_rows.extend(hour_rows)
                    print(
                        f"{site} {chunk_start}-{chunk_end}: "
                        f"{len(hour_rows)} rows", flush=True,
                    )
                template_ids = sorted({
                    row["client_miner_template_id"]
                    for row in source_rows if row["client_miner_template_id"]
                })
                templates = {}
                if template_ids:
                    placeholders = ",".join(["%s"] * len(template_ids))
                    cur.execute(
                        f"SELECT id, name FROM t_client_miner_template "
                        f"WHERE id IN ({placeholders})", template_ids,
                    )
                    templates = {row["id"]: row["name"] for row in cur.fetchall()}
        finally:
            conn.close()
        if not summary_only:
            cache_path.write_text(json.dumps({
                "table": source_table, "day": stat_date, "rows": source_rows,
                "warehouses": warehouse_rows, "templates": templates,
            }, ensure_ascii=False, default=str), encoding="utf-8")
    warehouses = {
        row["id"]: row for row in warehouse_rows
        if row.get("type") == 1 and row.get("is_deleted") == 0
    }

    anomalies = []
    # Select one source record per machine-hour before resolving its location.
    source_rows.sort(key=lambda row: (
        str(row.get("gmt_modified") or ""),
        str(row.get("gmt_create") or ""), row["id"],
    ), reverse=True)
    unique_source = {}
    for row in source_rows:
        if row["data_center_id"] != center_id:
            anomalies.append({
                "hour": row["hour"], "ip": row["ip"], "source_id": row["id"],
                "issue": "data_center_mismatch", "detail": row["data_center_id"],
            })
            continue
        key = (row["data_center_id"], row["hour"], row["ip"])
        if key in unique_source:
            anomalies.append({
                "hour": row["hour"], "ip": row["ip"], "source_id": row["id"],
                "issue": "duplicate_center_hour_ip",
                "detail": f"retained source: {unique_source[key]['id']}",
            })
            continue
        unique_source[key] = row
    candidates = []
    for row in unique_source.values():
        raw_location = row.get("worker_location") or ""
        try:
            location_values = json.loads(raw_location) if raw_location else []
            if not isinstance(location_values, list):
                raise ValueError("worker_location is not a JSON array")
        except (ValueError, TypeError) as exc:
            anomalies.append(
                {"hour": row["hour"], "ip": row["ip"], "source_id": row["id"],
                 "issue": "invalid_worker_location", "detail": str(exc)}
            )
            continue

        location_ids = set()
        invalid_locations = []
        for value in location_values:
            if isinstance(value, str):
                location_id = value.split("-", 1)[0]
                if location_id in warehouses:
                    location_ids.add(location_id)
                else:
                    invalid_locations.append(value)
            else:
                invalid_locations.append(value)

        if not location_ids or invalid_locations:
            anomalies.append(
                {"hour": row["hour"], "ip": row["ip"], "source_id": row["id"],
                 "issue": "warehouse_not_matched", "detail": raw_location}
            )
            continue
        if len(location_ids) > 1:
            anomalies.append(
                {"hour": row["hour"], "ip": row["ip"], "source_id": row["id"],
                 "issue": "multiple_warehouses",
                 "detail": json.dumps(sorted(location_ids))}
            )
            continue
        if not row.get("ip"):
            anomalies.append(
                {"hour": row["hour"], "ip": "", "source_id": row["id"],
                 "issue": "empty_ip", "detail": raw_location}
            )
            continue

        row["warehouse_id"] = next(iter(location_ids))
        candidates.append(row)

    groups = defaultdict(list)
    detail_rows = []
    machine_hour_count = 0
    for row in candidates:
        warehouse = warehouses[row["warehouse_id"]]
        template_id = row.get("client_miner_template_id") or ""
        machine = {
            "型号": row.get("model") or "",
            "算力组ID": template_id,
            "算力组名称": templates.get(template_id, "") if template_id else "",
            "档位(work_mode)": row.get("work_mode") or "",
            "平均算力(TH/s)": (
                row.get("avg_hashrate") / HASHRATE_PER_TH
                if row.get("avg_hashrate") is not None else None
            ),
            "平均功耗(W)": row.get("avg_power"),
            "单机功耗比(W/TH)": None,
            "拒绝率": row.get("rejected_rate"),
            "温度(°C)": temperature_to_celsius(row.get("temperature")),
        }
        hashrate = row.get("avg_hashrate")
        power = row.get("avg_power")
        if hashrate is not None and power is not None and hashrate > 0 and power > 0:
            machine["单机功耗比(W/TH)"] = power / (hashrate / HASHRATE_PER_TH)
        else:
            anomalies.append({
                "hour": row["hour"], "ip": row["ip"],
                "source_id": row.get("id"),
                "issue": "power_ratio_unavailable",
                "detail": f"hashrate={hashrate}; power={power}",
            })
        if not summary_only:
            detail = {
                "场地ID": center_id,
                "场地名称": site,
                "小时": row["hour"],
                "矿箱ID": warehouse["id"],
                "矿箱号": warehouse["name"],
                "IP": row["ip"],
                **machine,
                "MAC": row.get("mac") or "",
                "源记录ID": row["id"],
                "worker_location": row.get("worker_location") or "",
            }
            detail_rows.append(detail)
        groups[(warehouse["id"], row["hour"])].append(machine)
        machine_hour_count += 1

    summary_rows = []
    hierarchy_groups = (
        {
            "template": defaultdict(list),
            "model": defaultdict(list),
            "work_mode": defaultdict(list),
        }
        if not summary_only else {}
    )
    hierarchy_rows = {
        "template": [], "model": [], "work_mode": [],
    }
    dashboard_rows = []
    for (warehouse_id, hour), machines in sorted(groups.items()):
        warehouse = warehouses[warehouse_id]
        model_counts = defaultdict(int)
        template_names = {}
        template_counts = defaultdict(int)
        work_mode_counts = defaultdict(int)
        for machine in machines:
            model_counts[machine["型号"]] += 1
            template_counts[machine["算力组ID"]] += 1
            work_mode_counts[machine["档位(work_mode)"]] += 1
            if machine["算力组ID"]:
                template_names[machine["算力组ID"]] = machine["算力组名称"] or "(未匹配)"
            if not summary_only:
                base = (
                    center_id, site, hour, warehouse_id,
                    warehouse["name"], machine["算力组ID"],
                    machine["算力组名称"],
                )
                hierarchy_groups["template"][base].append(machine)
                hierarchy_groups["model"][
                    base + (machine["型号"],)
                ].append(machine)
                hierarchy_groups["work_mode"][
                    base + (machine["型号"], machine["档位(work_mode)"])
                ].append(machine)

        metrics, samples, valid_power, valid_hashrate = aggregate_metrics(machines)
        actual_power_w = sum(
            (machine["平均功耗(W)"] for machine in machines
             if machine["平均功耗(W)"] is not None),
            Decimal(0),
        )
        actual_power_kw = actual_power_w / Decimal(1000)
        theoretical_power_kw = theoretical_power.get(
            (site.lower(), normalize_warehouse_name(warehouse["name"]))
        )
        capacity_difference_kw = (
            theoretical_power_kw - actual_power_kw
            if theoretical_power_kw is not None else None
        )

        summary = {
            "场地ID": center_id,
            "场地名称": site,
            "小时": hour,
            "矿箱ID": warehouse_id,
            "矿箱号": warehouse["name"],
            "算力组数量": len(template_names),
            "各型号矿机数量": "; ".join(
                f"{k or '(空)'}: {v}" for k, v in sorted(model_counts.items())
            ),
            "算力组ID及名称": "; ".join(
                f"{key}: {value}" for key, value in sorted(template_names.items())
            ),
            "各档位矿机数量": "; ".join(
                f"{key or '(空)'}: {value}"
                for key, value in sorted(work_mode_counts.items())
            ),
            "实际功率(kW)": actual_power_kw,
            "理论功率(kW)": theoretical_power_kw,
            "负载率": (
                actual_power_kw / theoretical_power_kw
                if theoretical_power_kw is not None and theoretical_power_kw > 0
                else None
            ),
            "容量差额(kW)": capacity_difference_kw,
            "可填负荷(kW)": (
                max(capacity_difference_kw, Decimal(0))
                if capacity_difference_kw is not None else None
            ),
            **metrics,
        }
        summary_rows.append(summary)
        dashboard = {
            field: summary[label] for field, label in SUMMARY_API_FIELDS.items()
        }
        dashboard["models"] = [
            {"model": model, "machine_count": count}
            for model, count in sorted(model_counts.items())
        ]
        dashboard["templates"] = [
            {"template_id": template_id or None,
             "template_name": templates.get(template_id) or None,
             "machine_count": count}
            for template_id, count in sorted(template_counts.items())
        ]
        dashboard["work_modes"] = [
            {"work_mode": mode or None, "machine_count": count}
            for mode, count in sorted(work_mode_counts.items())
        ]
        dashboard["metric_samples"] = samples
        dashboard["power_ratio_valid_power_sum_w"] = valid_power or None
        dashboard["power_ratio_valid_hashrate_sum_ths"] = valid_hashrate or None
        dashboard_rows.append(dashboard)

    if not summary_only:
        for level, grouped in hierarchy_groups.items():
            identity_fields = HIERARCHY_IDENTITIES[level]
            for identity, machines in sorted(grouped.items()):
                metrics, samples, valid_power, valid_hashrate = aggregate_metrics(
                    machines
                )
                hierarchy_rows[level].append({
                    **dict(zip(identity_fields, identity)),
                    **metrics,
                    "_metric_samples": samples,
                    "_valid_power_w": valid_power or None,
                    "_valid_hashrate_ths": valid_hashrate or None,
                })

    summary_rows.sort(key=lambda row: (row["矿箱号"], row["小时"]))
    detail_rows.sort(key=lambda row: (row["小时"], row["矿箱号"], row["IP"]))
    dashboard_rows.sort(key=lambda row: (row["hour"], row["warehouse_id"]))
    if not summary_only:
        write_csv(output_dir / f"{prefix}_warehouse_hourly.csv", summary_rows,
                  fields=list(SUMMARY_API_FIELDS.values())[:7]
                  + ["各型号矿机数量", "算力组ID及名称", "各档位矿机数量"]
                  + list(SUMMARY_API_FIELDS.values())[7:])
        write_csv(output_dir / f"{prefix}_machine_hourly.csv", detail_rows,
                  fields=DETAIL_FIELDS)
        for level, rows in hierarchy_rows.items():
            write_csv(
                output_dir / f"{prefix}_{level}_hourly.csv", rows,
                fields=HIERARCHY_IDENTITIES[level] + METRIC_FIELDS,
            )
        write_csv(output_dir / f"{prefix}_anomalies.csv", anomalies)
        (output_dir / f"{prefix}_dashboard.json").write_text(json.dumps({
            "schema_version": "2.0",
            "data_center_id": center_id, "data_center_name": site,
            "date": day.isoformat(),
            "source_table": source_table,
            "hour_encoding": "YYYYMMDDHH", "timezone": None,
            "source_temperature_unit": SOURCE_TEMPERATURE_UNIT,
            "units": {"hashrate": "TH/s", "power": "W", "temperature": "C",
                      "power_ratio": "W/TH", "rejected_rate": "fraction"},
            "warehouse_rows": dashboard_rows,
            "template_rows": [
                hierarchy_api_row(row, HIERARCHY_IDENTITIES["template"])
                for row in hierarchy_rows["template"]
            ],
            "model_rows": [
                hierarchy_api_row(row, HIERARCHY_IDENTITIES["model"])
                for row in hierarchy_rows["model"]
            ],
            "work_mode_rows": [
                hierarchy_api_row(row, HIERARCHY_IDENTITIES["work_mode"])
                for row in hierarchy_rows["work_mode"]
            ],
            "machine_rows": [machine_api_row(row) for row in detail_rows],
        }, ensure_ascii=False, indent=2,
            default=lambda value: float(value) if isinstance(value, Decimal) else str(value)),
            encoding="utf-8")
    (output_dir / f"{prefix}_warehouse_dashboard.json").write_text(json.dumps({
        "schema_version": "2.1",
        "purpose": "public_warehouse_hourly_dashboard",
        "data_center_id": center_id,
        "data_center_name": site,
        "date": day.isoformat(),
        "hour_encoding": "YYYYMMDDHH",
        "timezone": None,
        "units": {
            "hashrate": "TH/s", "power": "W", "warehouse_power": "kW",
            "temperature": "C", "power_ratio": "W/TH",
            "rejected_rate": "fraction", "load_ratio": "fraction",
        },
        "warehouses": [
            {"warehouse_id": row["id"], "warehouse_name": row["name"]}
            for row in sorted(warehouses.values(), key=lambda item: item["name"])
        ],
        "warehouse_rows": dashboard_rows,
    }, ensure_ascii=False, indent=2,
        default=lambda value: float(value) if isinstance(value, Decimal) else str(value)),
        encoding="utf-8")
    report = {
        "source_rows": len(source_rows),
        "deduplicated_machine_hour_rows": (
            len(detail_rows) if not summary_only else machine_hour_count
        ),
        "summary_rows": len(summary_rows),
        "template_rows": len(hierarchy_rows["template"]),
        "model_rows": len(hierarchy_rows["model"]),
        "work_mode_rows": len(hierarchy_rows["work_mode"]),
        "schema_version": "2.0",
        "data_center_name": site,
        "date": stat_date,
        "warehouse_count": len(warehouses),
        "anomaly_counts": dict(
            (kind, sum(1 for item in anomalies if item["issue"] == kind))
            for kind in sorted({item["issue"] for item in anomalies})
        ),
        "hours": sorted({row["小时"] for row in summary_rows}),
        "output_dir": str(output_dir.resolve()),
        "warehouses_with_data": sorted({row["矿箱号"] for row in summary_rows}),
        "warehouses_without_data": sorted(
            row["name"] for row in warehouse_rows if row.get("type") == 1
            and row["id"] not in {key[0] for key in groups}
        ),
        "summary_machine_count_total": sum(row["矿机数量(去重IP)"] for row in summary_rows),
        "theoretical_power_source": str(Path(theoretical_power_path).resolve()),
        "theoretical_power_matched_rows": sum(
            row["理论功率(kW)"] is not None for row in summary_rows
        ),
    }
    assert report["summary_machine_count_total"] == machine_hour_count
    (output_dir / f"{prefix}_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


def write_csv(path, rows, fields=None):
    if fields is None:
        fields = list(rows[0]) if rows else ["hour", "ip", "source_id", "issue", "detail"]
    with path.open("w", newline="", encoding="utf-8-sig") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({
                key: "" if value is None else str(value)
                for key, value in row.items()
            })


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=r"..\功耗数据更新\config.toml")
    parser.add_argument("--date", default="20261029", help="YYYYMMDD")
    parser.add_argument("--site", choices=sorted(SITES), default="Nimrod01")
    parser.add_argument(
        "--all-sites", action="store_true",
        help="Export every configured site except Koye01",
    )
    parser.add_argument("--output-dir", default="output")
    parser.add_argument(
        "--theoretical-power",
        default=str(DEFAULT_THEORETICAL_POWER_PATH),
        help="XLSX with site, warehouse and theoretical power (kW)",
    )
    parser.add_argument(
        "--summary-only", action="store_true",
        help="Write only the lightweight warehouse dashboard and report",
    )
    parser.add_argument("--reuse", action="store_true", help="Recalculate cached source")
    args = parser.parse_args()
    sites = sorted(SITES) if args.all_sites else [args.site]
    for site in sites:
        export(
            Path(args.config), args.date, Path(args.output_dir), args.reuse, site,
            Path(args.theoretical_power), args.summary_only,
        )


if __name__ == "__main__":
    main()
