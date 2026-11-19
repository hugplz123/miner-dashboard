"""Build a rolling, static dashboard from exported warehouse summaries."""
import argparse
import datetime as dt
import gzip
import json
import math
import re
import shutil
import time
from collections import defaultdict
from pathlib import Path


SUMMARY_PATTERN = re.compile(
    r"^(?P<site>.+?)_(?P<date>\d{8})_warehouse_dashboard\.json$"
)
DETAIL_PATTERN = re.compile(
    r"^(?P<site>.+?)_(?P<date>\d{8})_dashboard\.json$"
)
LARK_SNAPSHOT_PATTERN = re.compile(r"^(?P<date>\d{8})\.json$")
SUMMARY_DETAIL_LEVELS = ("template_rows", "model_rows", "work_mode_rows")
DETAIL_LEVELS = (*SUMMARY_DETAIL_LEVELS, "machine_rows")
DETAIL_SCHEMA_VERSION = "4.0"
PRIVATE_FIELDS = {"mac", "source_id", "worker_location"}
EXPECTED_HOURS_PER_DAY = 24
DATA_TIMEZONE = "UTC+0"
WAREHOUSE_NUMBER = re.compile(r"^C?0*(\d+)$", re.IGNORECASE)
WAREHOUSE_COUNT_OVERRIDES = {"nimrod02": 16}
DEFAULT_UNIT_POWER_LIMIT_W = 4000
UNIT_POWER_LIMIT_OVERRIDES = {"nimrod01": 3500}


def atomic_replace(source, target, attempts=10):
    source = Path(source)
    target = Path(target)
    for attempt in range(attempts):
        try:
            source.replace(target)
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(0.2 * (attempt + 1))


def iso_date(value):
    return dt.datetime.strptime(str(value), "%Y%m%d").date().isoformat()


def numeric_sum(rows, key):
    return sum(row.get(key) or 0 for row in rows)


def discover_summary_sources(root, days=None, end_date=None):
    root = Path(root)
    candidates = list(root.rglob("*_warehouse_dashboard.json")) if root.exists() else []
    selected = {}
    for path in candidates:
        match = SUMMARY_PATTERN.match(path.name)
        if not match:
            continue
        key = (match.group("date"), match.group("site"))
        previous = selected.get(key)
        if previous is None or path.stat().st_mtime > previous.stat().st_mtime:
            selected[key] = path
    if not selected:
        raise FileNotFoundError(f"No warehouse dashboard summaries found in {root}")

    available_dates = sorted({key[0] for key in selected})
    if end_date:
        end_date = str(end_date).replace("-", "")
        available_dates = [date for date in available_dates if date <= end_date]
    if not available_dates:
        raise ValueError(f"No summaries on or before {end_date}")
    if days:
        available_dates = available_dates[-int(days):]
    selected = {
        key: path for key, path in selected.items() if key[0] in available_dates
    }
    return available_dates, selected


def discover_detail_sources(root, detail_dates=None):
    root = Path(root) if root else None
    selected = {}
    allowed_dates = (
        {str(value).replace("-", "") for value in detail_dates}
        if detail_dates is not None else None
    )
    if root and root.exists():
        for path in root.rglob("*_dashboard.json"):
            if path.name.endswith("_warehouse_dashboard.json"):
                continue
            match = DETAIL_PATTERN.match(path.name)
            if not match:
                continue
            if (
                allowed_dates is not None
                and match.group("date") not in allowed_dates
            ):
                continue
            key = (match.group("date"), match.group("site"))
            previous = selected.get(key)
            if previous is None or path.stat().st_mtime > previous.stat().st_mtime:
                selected[key] = path
    return selected


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def normalize_warehouse_number(value):
    match = WAREHOUSE_NUMBER.fullmatch(str(value or "").strip())
    if not match:
        raise ValueError(f"Unsupported warehouse number: {value!r}")
    return int(match.group(1))


def warehouse_allowed(site_name, warehouse_name):
    max_count = WAREHOUSE_COUNT_OVERRIDES.get(
        str(site_name or "").strip().casefold()
    )
    return (
        max_count is None
        or normalize_warehouse_number(warehouse_name) <= max_count
    )


def unit_power_limit_w(site_name):
    """Return the configured per-machine power ceiling for a site."""
    return UNIT_POWER_LIMIT_OVERRIDES.get(
        str(site_name or "").strip().casefold(),
        DEFAULT_UNIT_POWER_LIMIT_W,
    )


def load_lark_power(path, expected_date=None):
    path = Path(path)
    if not path.exists():
        return None, {}, None
    snapshot = load_json(path)
    if snapshot.get("schema_version") != "1.0":
        raise ValueError(f"Unsupported Lark-OM表 power schema in {path}")
    snapshot_date = str(
        snapshot.get("snapshot_date")
        or (iso_date(expected_date) if expected_date else "")
    ).strip()
    try:
        snapshot_date = dt.date.fromisoformat(snapshot_date).isoformat()
    except ValueError as exc:
        raise ValueError(
            f"Lark-OM表 power snapshot {path} has no valid snapshot_date"
        ) from exc
    if expected_date and snapshot_date != iso_date(expected_date):
        raise ValueError(
            f"Lark-OM表 snapshot date {snapshot_date} does not match {path.name}"
        )
    by_key = {}
    for record in snapshot.get("records") or []:
        key = (
            str(record.get("site") or "").strip().casefold(),
            int(record["warehouse_number"]),
        )
        if not key[0]:
            raise ValueError("Lark-OM表 power record has no site")
        if key in by_key:
            raise ValueError(f"Duplicate Lark-OM表 power record: {key}")
        by_key[key] = record
    if snapshot.get("record_count") != len(by_key):
        raise ValueError("Lark-OM表 power record_count does not match records")
    return snapshot, by_key, snapshot_date


def load_lark_power_history(history_dir, latest_path):
    history_dir = Path(history_dir)
    snapshots = {}
    if history_dir.exists():
        for path in sorted(history_dir.glob("*.json")):
            match = LARK_SNAPSHOT_PATTERN.fullmatch(path.name)
            if not match:
                continue
            snapshot, by_key, snapshot_date = load_lark_power(
                path, expected_date=match.group("date")
            )
            snapshots[snapshot_date] = (snapshot, by_key)

    latest_snapshot, latest_by_key, latest_date = load_lark_power(latest_path)
    if latest_date:
        previous = snapshots.get(latest_date)
        if previous is None or (
            str(latest_snapshot.get("synced_at") or "")
            >= str(previous[0].get("synced_at") or "")
        ):
            snapshots[latest_date] = (latest_snapshot, latest_by_key)
    return snapshots


def load_supabase_power(path):
    path = Path(path)
    if not path.exists():
        return None
    snapshot = load_json(path)
    if snapshot.get("schema_version") != "1.0":
        raise ValueError(f"Unsupported Supabase power schema in {path}")
    records = snapshot.get("records")
    if not isinstance(records, list):
        raise ValueError(f"Supabase power snapshot {path} has no records")
    if snapshot.get("record_count") != len(records):
        raise ValueError(
            f"Supabase power record_count does not match {path}"
        )
    return snapshot


def supabase_power_dates(snapshot):
    """Return compact YYYYMMDD dates represented by meter records."""
    dates = set()
    for record in (snapshot or {}).get("records") or []:
        hour = str(record.get("hour") or "")
        if len(hour) >= 8 and hour[:8].isdigit():
            dates.add(hour[:8])
    return sorted(dates)


def attach_supabase_power(warehouses, snapshot):
    if not snapshot:
        return [], None
    lookup = {}
    for warehouse in warehouses.values():
        key = (
            str(warehouse["data_center_name"]).strip().casefold(),
            normalize_warehouse_number(warehouse["warehouse_name"]),
        )
        lookup[key] = warehouse

    rows = []
    seen = set()
    unmatched = []
    for record in snapshot.get("records") or []:
        try:
            site_name = str(record["site"]).strip()
            warehouse_name = str(record["warehouse_name"]).strip()
            hour = int(record["hour"])
            power = finite_number(record["meter_power_kw"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(
                f"Invalid Supabase power record: {record!r}"
            ) from exc
        if power is None or power < 0:
            raise ValueError(
                f"Invalid Supabase meter power: {record!r}"
            )
        key = (
            site_name.casefold(),
            normalize_warehouse_number(warehouse_name),
        )
        warehouse = lookup.get(key)
        if not warehouse:
            unmatched.append({
                "site": site_name,
                "warehouse_name": warehouse_name,
                "hour": hour,
            })
            continue
        record_key = (warehouse["data_center_id"], hour, warehouse["warehouse_id"])
        if record_key in seen:
            raise ValueError(f"Duplicate Supabase power record: {record_key}")
        seen.add(record_key)
        rows.append({
            "data_center_id": warehouse["data_center_id"],
            "data_center_name": warehouse["data_center_name"],
            "warehouse_id": warehouse["warehouse_id"],
            "warehouse_name": warehouse["warehouse_name"],
            "hour": hour,
            "meter_power_kw": power,
            "meter_recorded_at": record.get("recorded_at"),
        })

    metadata = {
        "schema_version": snapshot["schema_version"],
        "source": snapshot.get("source"),
        "table": snapshot.get("table"),
        "timezone": snapshot.get("timezone", DATA_TIMEZONE),
        "synced_at": snapshot.get("synced_at"),
        "date_range": snapshot.get("date_range"),
        "raw_record_count": snapshot.get("raw_record_count"),
        "record_count": snapshot.get("record_count"),
        "duplicate_count": snapshot.get("duplicate_count", 0),
        "matched_records": len(rows),
        "unmatched_records": len(unmatched),
        "unmatched_samples": unmatched[:25],
        "coverage": snapshot.get("coverage"),
    }
    return rows, metadata


def attach_lark_power(warehouses, snapshots):
    matched_by_date = {}
    for date, (snapshot, by_key) in sorted(snapshots.items()):
        matched_keys = set()
        for warehouse in warehouses.values():
            key = (
                str(warehouse["data_center_name"]).strip().casefold(),
                normalize_warehouse_number(warehouse["warehouse_name"]),
            )
            record = by_key.get(key)
            if record:
                warehouse.setdefault("lark_power_by_date", {})[date] = record
                matched_keys.add(key)
        unmatched = [
            {
                "site": record["site"],
                "warehouse_number": record["warehouse_number"],
            }
            for key, record in sorted(by_key.items())
            if key not in matched_keys
        ]
        matched_by_date[date] = {
            "snapshot_date": date,
            "schema_version": snapshot["schema_version"],
            "source": snapshot.get("source"),
            "synced_at": snapshot.get("synced_at"),
            "record_count": len(by_key),
            "matched_warehouses": len(matched_keys),
            "unmatched_records": unmatched,
        }
    if not matched_by_date:
        return None
    latest_date = max(matched_by_date)
    return {
        "latest_snapshot_date": latest_date,
        "snapshots": [matched_by_date[date] for date in sorted(matched_by_date)],
    }


def site_lark_power(warehouses, snapshots, date):
    loaded = snapshots.get(date)
    if not loaded:
        return {"available": False, "snapshot_date": date}
    snapshot, by_key = loaded
    matched = []
    for warehouse in warehouses:
        key = (
            str(warehouse["data_center_name"]).strip().casefold(),
            normalize_warehouse_number(warehouse["warehouse_name"]),
        )
        record = by_key.get(key)
        if record:
            matched.append(record)
    return {
        "available": True,
        "snapshot_date": date,
        "synced_at": snapshot.get("synced_at"),
        "matched_warehouses": len(matched),
        "total_warehouses": len(warehouses),
        "missing_capacity_warehouses": sum(
            not isinstance(record.get("mounted_power_kw"), (int, float))
            for record in matched
        ),
        "mounted_power_kw": numeric_sum(matched, "mounted_power_kw"),
        "reserved_power_kw": numeric_sum(matched, "reserved_power_kw"),
        "power_limit_kw": numeric_sum(matched, "power_limit_kw"),
        "mounted_machine_count": int(
            numeric_sum(matched, "mounted_machine_count")
        ),
        "occupied_slots": int(numeric_sum(matched, "occupied_slots")),
        "total_slots": int(numeric_sum(matched, "total_slots")),
    }


def summary_warehouses(slim, full=None, cache=None):
    rows = slim.get("warehouses") or []
    if not rows and cache:
        rows = [
            {"warehouse_id": row["id"], "warehouse_name": row["name"]}
            for row in cache.get("warehouses", [])
            if row.get("type") == 1 and row.get("is_deleted") == 0
        ]
    return rows


def sanitize_detail_row(row):
    return {key: value for key, value in row.items() if key not in PRIVATE_FIELDS}


def finite_number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def machine_power_stats(machine_rows):
    """Build warehouse-day power statistics from unique machine-hour samples."""
    samples_by_hour = {}
    for row in machine_rows:
        power = finite_number(row.get("avg_power_w"))
        if power is None:
            continue
        warehouse_id = row.get("warehouse_id")
        hour = row.get("hour")
        if not warehouse_id or hour is None:
            continue
        key = (
            warehouse_id,
            int(hour),
            str(row.get("ip") or ""),
        )
        previous = samples_by_hour.get(key)
        if previous is None or power > previous[0]:
            samples_by_hour[key] = (power, row)

    rows_by_warehouse = defaultdict(list)
    for (warehouse_id, hour, _), (power, row) in samples_by_hour.items():
        rows_by_warehouse[warehouse_id].append((hour, power, row))

    result = {}
    for warehouse_id, samples in rows_by_warehouse.items():
        total_power = sum(power for _, power, _ in samples)
        hour, peak_power, peak_row = max(
            samples, key=lambda item: (item[1], -item[0])
        )
        rows_by_ip = defaultdict(list)
        for sample_hour, sample_power, sample_row in samples:
            rows_by_ip[str(sample_row.get("ip") or "")].append(
                (sample_hour, sample_power, sample_row)
            )

        daily_ip, daily_samples = max(
            rows_by_ip.items(),
            key=lambda item: (
                sum(power for _, power, _ in item[1]) / len(item[1]),
                item[0],
            ),
        )
        daily_total = sum(power for _, power, _ in daily_samples)
        daily_peak_hour, _, daily_row = max(
            daily_samples, key=lambda item: (item[1], -item[0])
        )
        result[warehouse_id] = {
            "machine_hour_peak_power_w": peak_power,
            "machine_hour_peak_hour": hour,
            "machine_hour_peak_ip": peak_row.get("ip"),
            "machine_hour_peak_model": peak_row.get("model"),
            "machine_hour_peak_work_mode": peak_row.get("work_mode"),
            "machine_hour_peak_hashrate_ths": finite_number(
                peak_row.get("avg_hashrate_ths")
            ),
            "machine_hour_peak_ratio_w_per_th": finite_number(
                peak_row.get("power_ratio_w_per_th")
            ),
            "machine_hour_peak_temperature_c": finite_number(
                peak_row.get("temperature_c")
            ),
            "machine_hour_peak_rejected_rate": finite_number(
                peak_row.get("rejected_rate")
            ),
            "machine_daily_avg_peak_power_w": (
                daily_total / len(daily_samples)
            ),
            "machine_daily_avg_peak_ip": daily_ip,
            "machine_daily_avg_peak_model": daily_row.get("model"),
            "machine_daily_avg_peak_work_mode": daily_row.get("work_mode"),
            "machine_daily_avg_peak_valid_hours": len(daily_samples),
            "machine_daily_avg_peak_hour": daily_peak_hour,
            "machine_daily_avg_peak_hashrate_ths": finite_number(
                daily_row.get("avg_hashrate_ths")
            ),
            "machine_daily_avg_peak_ratio_w_per_th": finite_number(
                daily_row.get("power_ratio_w_per_th")
            ),
            "machine_daily_avg_peak_temperature_c": finite_number(
                daily_row.get("temperature_c")
            ),
            "machine_daily_avg_peak_rejected_rate": finite_number(
                daily_row.get("rejected_rate")
            ),
            "warehouse_machine_avg_power_w": total_power / len(samples),
            "machine_hour_sample_count": len(samples),
        }
    return result


def daily_totals(
    site_id, site_name, date, rows, warehouse_count, site_warehouses,
    meter_rows=None,
):
    machine_rows = [
        row for row in rows
        if row.get("actual_power_kw") is not None
        or int(row.get("machine_count") or 0) > 0
    ]
    valid_power = numeric_sum(rows, "power_ratio_valid_power_sum_w")
    valid_hashrate = numeric_sum(rows, "power_ratio_valid_hashrate_sum_ths")
    configured_theoretical_power = sum(
        float(warehouse["theoretical_power_kw"])
        for warehouse in site_warehouses
    )
    hours = sorted({int(row["hour"]) for row in rows})
    machine_hours = sorted({int(row["hour"]) for row in machine_rows})
    warehouse_hours = defaultdict(set)
    for row in machine_rows:
        warehouse_hours[row["warehouse_id"]].add(int(row["hour"]))
    warehouse_hour_counts = {
        warehouse_id: len(values)
        for warehouse_id, values in sorted(warehouse_hours.items())
    }
    complete_warehouse_count = sum(
        count == EXPECTED_HOURS_PER_DAY
        for count in warehouse_hour_counts.values()
    )
    meter_rows = meter_rows or []
    meter_hours = {int(row["hour"]) for row in meter_rows}
    meter_warehouses = {row["warehouse_id"] for row in meter_rows}
    meter_power = numeric_sum(meter_rows, "meter_power_kw")
    actual_power = (
        numeric_sum(machine_rows, "actual_power_kw")
        if machine_rows else None
    )
    return {
        "data_center_id": site_id,
        "data_center_name": site_name,
        "date": iso_date(date),
        "hours": hours,
        "hours_with_data": len(hours),
        "machine_hours": machine_hours,
        "machine_hours_with_data": len(machine_hours),
        "expected_hours": EXPECTED_HOURS_PER_DAY,
        "hours_coverage_ratio": (
            len(hours) / EXPECTED_HOURS_PER_DAY if EXPECTED_HOURS_PER_DAY else None
        ),
        "is_complete": len(hours) == EXPECTED_HOURS_PER_DAY,
        "is_fully_complete": (
            len(hours) == EXPECTED_HOURS_PER_DAY
            and complete_warehouse_count == warehouse_count
        ),
        "warehouse_rows": len(rows),
        "warehouses_with_data": len({row["warehouse_id"] for row in rows}),
        "machine_warehouses_with_data": len({
            row["warehouse_id"] for row in machine_rows
        }),
        "warehouse_count": warehouse_count,
        "complete_warehouse_count": complete_warehouse_count,
        "incomplete_warehouse_count": sum(
            count < EXPECTED_HOURS_PER_DAY
            for count in warehouse_hour_counts.values()
        ),
        "warehouses_without_data": max(
            0, warehouse_count - len(warehouse_hour_counts)
        ),
        "min_warehouse_hours": (
            min(warehouse_hour_counts.values())
            if warehouse_hour_counts else None
        ),
        "warehouse_hour_counts": warehouse_hour_counts,
        "machine_count": int(numeric_sum(rows, "machine_count")),
        "power_ratio_sample_count": int(
            numeric_sum(rows, "power_ratio_sample_count")
        ),
        "actual_power_kw": actual_power,
        "meter_hour_sum_kw": meter_power if meter_rows else None,
        "meter_hour_count": len(meter_hours),
        "meter_hours_with_data": len(meter_hours),
        "meter_covered_warehouses": len(meter_warehouses),
        "meter_total_warehouses": warehouse_count,
        "theoretical_power_kw": configured_theoretical_power,
        "configured_theoretical_power_kw": configured_theoretical_power,
        "available_capacity_kw": numeric_sum(rows, "available_capacity_kw"),
        "power_ratio_valid_power_sum_w": valid_power,
        "power_ratio_valid_hashrate_sum_ths": valid_hashrate,
        "power_ratio_overall_w_per_th": (
            valid_power / valid_hashrate if valid_hashrate > 0 else None
        ),
    }


def hourly_summaries(rows, meter_rows=None, warehouse_count=None):
    """Build the small per-hour series used by the dashboard trend chart."""
    rows_by_hour = defaultdict(list)
    for row in rows:
        rows_by_hour[int(row["hour"])].append(row)
    meter_by_hour = defaultdict(list)
    for row in meter_rows or []:
        meter_by_hour[int(row["hour"])].append(row)
    all_hours = sorted(set(rows_by_hour) | set(meter_by_hour))
    summaries = []
    for hour in all_hours:
        hour_rows = rows_by_hour.get(hour, [])
        hour_meter_rows = meter_by_hour.get(hour, [])
        machine_rows = [
            row for row in hour_rows
            if row.get("actual_power_kw") is not None
            or int(row.get("machine_count") or 0) > 0
        ]
        valid_power = numeric_sum(
            machine_rows, "power_ratio_valid_power_sum_w"
        )
        valid_hashrate = numeric_sum(
            machine_rows, "power_ratio_valid_hashrate_sum_ths"
        )
        summaries.append({
            "hour": hour,
            "warehouse_count": len({
                row["warehouse_id"] for row in machine_rows
            }),
            "machine_count": int(numeric_sum(machine_rows, "machine_count")),
            "power_ratio_sample_count": int(
                numeric_sum(machine_rows, "power_ratio_sample_count")
            ),
            "actual_power_kw": (
                numeric_sum(machine_rows, "actual_power_kw")
                if machine_rows else None
            ),
            "meter_hour_sum_kw": (
                numeric_sum(hour_meter_rows, "meter_power_kw")
                if hour_meter_rows else None
            ),
            "meter_covered_warehouses": len({
                row["warehouse_id"] for row in hour_meter_rows
            }),
            "meter_total_warehouses": (
                warehouse_count
                if warehouse_count is not None
                else len({
                    row["warehouse_id"] for row in machine_rows
                })
            ),
            "power_ratio_valid_power_sum_w": valid_power,
            "power_ratio_valid_hashrate_sum_ths": valid_hashrate,
            "power_ratio_overall_w_per_th": (
                valid_power / valid_hashrate if valid_hashrate > 0 else None
            ),
        })
    return summaries


def warehouse_daily_peaks(rows):
    """Return each warehouse's highest actual-power row for the day."""
    rows_by_warehouse = defaultdict(list)
    for row in rows:
        if row.get("actual_power_kw") is not None:
            rows_by_warehouse[row["warehouse_id"]].append(row)
    return sorted(
        (
            max(values, key=lambda row: row["actual_power_kw"])
            for values in rows_by_warehouse.values()
        ),
        key=lambda row: row["warehouse_name"],
    )


def write_gzip_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    encoded = json.dumps(
        payload, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    # A fixed gzip timestamp keeps unchanged data byte-identical across builds.
    with temporary.open("wb") as raw:
        with gzip.GzipFile(
            filename="", fileobj=raw, mode="wb", compresslevel=9, mtime=0
        ) as stream:
            stream.write(encoded)
    atomic_replace(temporary, path)


def source_exported_at(paths):
    newest = max(Path(path).stat().st_mtime for path in paths)
    return dt.datetime.fromtimestamp(
        newest, tz=dt.timezone.utc
    ).isoformat()


def remove_children(directory, keep):
    directory = Path(directory)
    if not directory.exists():
        return
    for child in directory.iterdir():
        if child.name in keep:
            continue
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()


def build(summary_root, destination, days=7, end_date=None, detail_root=None,
          detail_date=None, lark_power_path=None, lark_history_dir=None,
          theoretical_power_path=None, supabase_power_path=None):
    """Build all static assets. Raises if discovery or validation fails."""
    summary_root = Path(summary_root)
    destination = Path(destination)
    theoretical_power_path = (
        Path(theoretical_power_path) if theoretical_power_path
        else Path("inputs") / "矿箱理论功率.xlsx"
    )
    if not theoretical_power_path.exists():
        raise FileNotFoundError(
            f"Theoretical power workbook not found: {theoretical_power_path}"
        )
    from sample_export import read_theoretical_power

    theoretical_power = read_theoretical_power(theoretical_power_path)
    if not theoretical_power:
        raise ValueError(
            f"Theoretical power workbook has no records: {theoretical_power_path}"
        )
    lark_power_path = (
        Path(lark_power_path) if lark_power_path
        else destination / "data" / "lark_power.json"
    )
    lark_history_dir = (
        Path(lark_history_dir) if lark_history_dir
        else destination / "data" / "lark_power_history"
    )
    supabase_power_path = (
        Path(supabase_power_path) if supabase_power_path
        else destination / "data" / "supabase_power.json"
    )
    supabase_snapshot = load_supabase_power(supabase_power_path)
    summary_dates, selected = discover_summary_sources(
        summary_root, days=None, end_date=end_date
    )
    dates = sorted(
        set(summary_dates) | set(supabase_power_dates(supabase_snapshot))
    )
    if end_date:
        end_date_key = str(end_date).replace("-", "")
        dates = [date for date in dates if date <= end_date_key]
    if days:
        dates = dates[-int(days):]
    if not dates:
        raise ValueError(
            "No machine or meter dates available in the rolling window"
        )
    allowed_date_keys = set(dates)
    selected = {
        key: path for key, path in selected.items()
        if key[0] in allowed_date_keys
    }
    requested_detail_dates = (
        {str(detail_date).replace("-", "")}
        if detail_date else set(dates)
    )
    detail_sources = discover_detail_sources(
        detail_root, requested_detail_dates
    )

    site_names = {}
    warehouses = {}
    rows_by_date = defaultdict(list)
    details = defaultdict(
        lambda: {"template_rows": [], "model_rows": [], "work_mode_rows": [],
                 "machine_rows": []}
    )
    machine_power_by_warehouse_day = {}

    def fixed_theoretical_power(warehouse):
        key = (
            str(warehouse["data_center_name"]).strip().casefold(),
            f"C{normalize_warehouse_number(warehouse['warehouse_name']):02d}",
        )
        try:
            return float(theoretical_power[key])
        except KeyError as exc:
            raise ValueError(
                "Missing fixed theoretical power for "
                f"{warehouse['data_center_name']} {warehouse['warehouse_name']}"
            ) from exc

    for (date, site_key), path in sorted(selected.items()):
        slim = load_json(path)
        center_id = slim["data_center_id"]
        center_name = slim["data_center_name"]
        site_names[center_id] = center_name
        slim_warehouses = summary_warehouses(slim)
        allowed_warehouse_ids = set()
        for row in slim_warehouses:
            if not warehouse_allowed(center_name, row["warehouse_name"]):
                continue
            allowed_warehouse_ids.add(row["warehouse_id"])
            warehouses[(center_id, row["warehouse_id"])] = {
                "data_center_id": center_id,
                "data_center_name": center_name,
                "warehouse_id": row["warehouse_id"],
                "warehouse_name": row["warehouse_name"],
                "unit_power_limit_w": unit_power_limit_w(center_name),
            }
            warehouses[(center_id, row["warehouse_id"])][
                "theoretical_power_kw"
            ] = fixed_theoretical_power(
                warehouses[(center_id, row["warehouse_id"])]
            )
        site_warehouse_fixed_power = {
            warehouse_id: warehouse["theoretical_power_kw"]
            for (site_id, warehouse_id), warehouse in warehouses.items()
            if site_id == center_id
        }
        rows_by_date[date].extend(
            {
                **row,
                "theoretical_power_kw": site_warehouse_fixed_power[
                    row["warehouse_id"]
                ],
            }
            for row in slim.get("warehouse_rows", [])
            if row["warehouse_id"] in allowed_warehouse_ids
        )

    for site_key, path in sorted(detail_sources.items()):
        full = load_json(path)
        center_id = full["data_center_id"]
        site_names[center_id] = full["data_center_name"]
        cache_path = path.with_name(
            path.name.replace("_dashboard.json", "_source.json")
        )
        cache = load_json(cache_path) if cache_path.exists() else None
        if cache:
            for row in summary_warehouses({}, full, cache):
                if not warehouse_allowed(full["data_center_name"], row["warehouse_name"]):
                    continue
                warehouses[(center_id, row["warehouse_id"])] = {
                    "data_center_id": center_id,
                    "data_center_name": full["data_center_name"],
                    "warehouse_id": row["warehouse_id"],
                    "warehouse_name": row["warehouse_name"],
                    "unit_power_limit_w": unit_power_limit_w(
                        full["data_center_name"]
                    ),
                    "theoretical_power_kw": fixed_theoretical_power({
                        "data_center_name": full["data_center_name"],
                        "warehouse_name": row["warehouse_name"],
                    }),
                }
        for level in DETAIL_LEVELS:
            for row in full.get(level, []):
                key = (row["data_center_id"], row["hour"], row["warehouse_id"])
                details[key][level].append(sanitize_detail_row(row))
        detail_date = str(full.get("date") or "").replace("-", "")
        if not detail_date:
            machine_hours = [
                str(row.get("hour") or "")[:8]
                for row in full.get("machine_rows", [])
                if row.get("hour") is not None
            ]
            detail_date = min(machine_hours, default="")
        for warehouse_id, stats in machine_power_stats(
            full.get("machine_rows", [])
        ).items():
            machine_power_by_warehouse_day[
                (center_id, detail_date, warehouse_id)
            ] = stats

    lark_snapshots = load_lark_power_history(
        lark_history_dir, lark_power_path
    )
    lark_metadata = attach_lark_power(warehouses, lark_snapshots)
    meter_rows, meter_metadata = attach_supabase_power(
        warehouses, supabase_snapshot
    )
    meter_rows = [
        row for row in meter_rows
        if str(row["hour"])[:8] in allowed_date_keys
    ]
    meter_by_date = defaultdict(list)
    for row in meter_rows:
        meter_by_date[str(row["hour"])[:8]].append(row)
    if meter_metadata is not None:
        meter_metadata["coverage_by_date"] = {
            iso_date(date): {
                "record_count": len(rows),
                "hour_count": len({int(row["hour"]) for row in rows}),
                "warehouse_count": len({
                    row["warehouse_id"] for row in rows
                }),
            }
            for date, rows in sorted(meter_by_date.items())
        }

    row_keys = {
        (row["data_center_id"], row["hour"], row["warehouse_id"])
        for rows in rows_by_date.values() for row in rows
    }
    all_rows = [row for rows in rows_by_date.values() for row in rows]
    if len(row_keys) != len(all_rows):
        raise ValueError("Duplicate warehouse-hour rows across summaries")
    for date, rows in rows_by_date.items():
        for row in rows:
            warehouse_id = row["warehouse_id"]
            stats = machine_power_by_warehouse_day.get(
                (row["data_center_id"], date, warehouse_id)
            )
            if stats:
                row.update(stats)
            row["machine_data_available"] = (
                row.get("actual_power_kw") is not None
                or int(row.get("machine_count") or 0) > 0
            )

    rows_by_key = {
        (row["data_center_id"], row["hour"], row["warehouse_id"]): row
        for rows in rows_by_date.values() for row in rows
    }
    for meter_row in meter_rows:
        key = (
            meter_row["data_center_id"],
            meter_row["hour"],
            meter_row["warehouse_id"],
        )
        row = rows_by_key.get(key)
        if row:
            row.update({
                "meter_power_kw": meter_row["meter_power_kw"],
                "meter_recorded_at": meter_row.get("meter_recorded_at"),
                "meter_data_available": True,
            })
            continue
        date = str(meter_row["hour"])[:8]
        warehouse = warehouses[
            (meter_row["data_center_id"], meter_row["warehouse_id"])
        ]
        row = {
            **meter_row,
            "theoretical_power_kw": warehouse["theoretical_power_kw"],
            "actual_power_kw": None,
            "machine_count": 0,
            "template_count": 0,
            "model_count": 0,
            "work_mode_count": 0,
            "power_ratio_sample_count": 0,
            "power_ratio_overall_w_per_th": None,
            "meter_data_available": True,
            "machine_data_available": False,
        }
        rows_by_date[date].append(row)
        rows_by_key[key] = row

    all_rows = [row for rows in rows_by_date.values() for row in rows]
    row_keys = {
        (row["data_center_id"], row["hour"], row["warehouse_id"])
        for row in all_rows
    }
    if len(row_keys) != len(all_rows):
        raise ValueError("Duplicate warehouse-hour rows after meter merge")

    data_dir = destination / "data"
    days_dir = data_dir / "days"
    hours_dir = data_dir / "hours"
    details_dir = data_dir / "details"
    days_dir.mkdir(parents=True, exist_ok=True)
    hours_dir.mkdir(parents=True, exist_ok=True)
    details_dir.mkdir(parents=True, exist_ok=True)
    remove_children(
        data_dir,
        {
            "catalog.json", "days", "hours", "details", "lark_power.json",
            "lark_power_history", "model_levels.json", "supabase_power.json",
        },
    )

    day_files = set()
    hour_files = set()
    for date, rows in rows_by_date.items():
        date_payload = {
            "schema_version": "3.0",
            "date": iso_date(date),
            "timezone": DATA_TIMEZONE,
            "warehouse_rows": sorted(
                rows,
                key=lambda row: (
                    row["data_center_name"].lower(), row["hour"],
                    row["warehouse_name"],
                ),
            ),
        }
        name = f"{date}.json.gz"
        day_files.add(name)
        write_gzip_json(days_dir / name, date_payload)

        # Keep the full-day bundle for rolling imports, but let the browser
        # download only the selected site's rows.
        rows_by_site = defaultdict(list)
        for row in rows:
            rows_by_site[row["data_center_id"]].append(row)
        for center_id, site_rows in rows_by_site.items():
            site_payload = {
                "schema_version": "3.0",
                "date": iso_date(date),
                "timezone": DATA_TIMEZONE,
                "warehouse_rows": sorted(
                    site_rows,
                    key=lambda row: (
                        row["hour"], row["warehouse_name"],
                    ),
                ),
            }
            site_name = f"{center_id}-{date}.json.gz"
            day_files.add(site_name)
            write_gzip_json(days_dir / site_name, site_payload)

            rows_by_hour = defaultdict(list)
            for row in site_rows:
                rows_by_hour[int(row["hour"])].append(row)
            peaks = warehouse_daily_peaks(site_rows)
            site_meter_rows = [
                row for row in meter_by_date.get(date, [])
                if row["data_center_id"] == center_id
            ]
            site_warehouse_count = sum(
                1 for (site_id, _) in warehouses if site_id == center_id
            )
            summaries = hourly_summaries(
                site_rows, site_meter_rows, site_warehouse_count
            )
            compact_date = iso_date(date).replace("-", "")
            for hour, hour_rows in sorted(rows_by_hour.items()):
                hour_payload = {
                    "schema_version": "3.3",
                    "date": iso_date(date),
                    "hour": hour,
                    "timezone": DATA_TIMEZONE,
                    "warehouse_rows": sorted(
                        hour_rows, key=lambda row: row["warehouse_name"]
                    ),
                    "warehouse_peaks": peaks,
                    "hourly_summary": summaries,
                }
                hour_name = (
                    f"{center_id}-{compact_date}-{hour % 100:02d}.json.gz"
                )
                hour_files.add(hour_name)
                write_gzip_json(hours_dir / hour_name, hour_payload)

    bundles = defaultdict(lambda: {"hours": {}})
    for (center_id, hour, warehouse_id), payload in details.items():
        if (center_id, warehouse_id) not in warehouses:
            continue
        date = str(hour)[:8]
        bundle = bundles[(center_id, date, warehouse_id)]
        bundle.update({
            "schema_version": "3.0",
            "data_center_id": center_id,
            "data_center_name": site_names[center_id],
            "date": iso_date(date),
            "timezone": DATA_TIMEZONE,
            "warehouse_id": warehouse_id,
            "warehouse_name": warehouses[(center_id, warehouse_id)][
                "warehouse_name"
            ],
        })
        bundle["hours"][str(hour)] = payload

    detail_paths = set()
    for (center_id, date, warehouse_id), payload in bundles.items():
        # Day folders use the compact YYYYMMDD key, matching the frontend.
        metadata = {
            "schema_version": DETAIL_SCHEMA_VERSION,
            "data_center_id": payload["data_center_id"],
            "data_center_name": payload["data_center_name"],
            "date": payload["date"],
            "timezone": DATA_TIMEZONE,
            "warehouse_id": payload["warehouse_id"],
            "warehouse_name": payload["warehouse_name"],
        }
        summary_payload = {
            **metadata,
            "detail_kind": "summary",
            "hours": {
                hour: {
                    level: hour_payload[level]
                    for level in SUMMARY_DETAIL_LEVELS
                }
                for hour, hour_payload in payload["hours"].items()
            },
        }
        machine_payload = {
            **metadata,
            "detail_kind": "machines",
            "hours": {
                hour: {"machine_rows": hour_payload["machine_rows"]}
                for hour, hour_payload in payload["hours"].items()
            },
        }
        folder = Path(center_id) / str(date)
        summary_relative = folder / f"{warehouse_id}.summary.json.gz"
        machine_relative = folder / f"{warehouse_id}.machines.json.gz"
        detail_paths.update({
            summary_relative.as_posix(),
            machine_relative.as_posix(),
        })
        write_gzip_json(details_dir / summary_relative, summary_payload)
        write_gzip_json(details_dir / machine_relative, machine_payload)

    site_rows = []
    daily_summary = []
    for center_id, center_name in sorted(
        site_names.items(), key=lambda item: item[1].lower()
    ):
        site_warehouses = [
            row for (site_id, _), row in warehouses.items()
            if site_id == center_id
        ]
        site_lark_by_date = {
            date: site_lark_power(site_warehouses, lark_snapshots, date)
            for date in sorted(lark_snapshots)
        }
        site_dates = []
        site_daily = []
        hours_by_date = {}
        machine_hours_by_date = {}
        meter_hours_by_date = {}
        meter_warehouse_hours_by_date = {}
        warehouse_hours_by_date = {}
        for date in dates:
            rows = [
                row for row in rows_by_date[date]
                if row["data_center_id"] == center_id
            ]
            site_meter_rows = [
                row for row in meter_by_date.get(date, [])
                if row["data_center_id"] == center_id
            ]
            if not rows:
                continue
            site_dates.append(iso_date(date))
            machine_rows = [
                row for row in rows
                if row.get("machine_data_available")
                or row.get("actual_power_kw") is not None
                or int(row.get("machine_count") or 0) > 0
            ]
            meter_warehouse_hours = defaultdict(set)
            for row in site_meter_rows:
                meter_warehouse_hours[row["warehouse_id"]].add(row["hour"])
            meter_hours_by_date[iso_date(date)] = sorted({
                row["hour"] for row in site_meter_rows
            })
            meter_warehouse_hours_by_date[iso_date(date)] = {
                warehouse_id: sorted(values)
                for warehouse_id, values in sorted(
                    meter_warehouse_hours.items()
                )
            }
            hours = sorted({row["hour"] for row in rows})
            hours_by_date[iso_date(date)] = hours
            machine_hours_by_date[iso_date(date)] = sorted({
                row["hour"] for row in machine_rows
            })
            warehouse_hours = defaultdict(set)
            for row in machine_rows:
                warehouse_hours[row["warehouse_id"]].add(row["hour"])
            warehouse_hours_by_date[iso_date(date)] = {
                warehouse_id: sorted(values)
                for warehouse_id, values in sorted(warehouse_hours.items())
            }
            total = daily_totals(
                center_id, center_name, date, rows, len(site_warehouses),
                site_warehouses, meter_rows=site_meter_rows,
            )
            site_daily.append(total)
            daily_summary.append(total)
        site_rows.append({
            "data_center_id": center_id,
            "data_center_name": center_name,
            "warehouse_count": len(site_warehouses),
            "unit_power_limit_w": unit_power_limit_w(center_name),
            "theoretical_power_kw": sum(
                float(warehouse["theoretical_power_kw"])
                for warehouse in site_warehouses
            ),
            "warehouses_with_data": len({
                row["warehouse_id"] for row in all_rows
                if row["data_center_id"] == center_id
            }),
            "machine_warehouses_with_data": len({
                row["warehouse_id"] for row in all_rows
                if row["data_center_id"] == center_id
                and row.get("machine_data_available")
            }),
            "meter_warehouses_with_data": len({
                row["warehouse_id"] for row in meter_rows
                if row["data_center_id"] == center_id
            }),
            "available_dates": site_dates,
            "hours_by_date": hours_by_date,
            "machine_hours_by_date": machine_hours_by_date,
            "meter_hours_by_date": meter_hours_by_date,
            "meter_warehouse_hours_by_date": meter_warehouse_hours_by_date,
            "warehouse_hours_by_date": warehouse_hours_by_date,
            "daily_summary": site_daily,
            "lark_power_by_date": site_lark_by_date,
        })

    catalog = {
        "schema_version": "3.5",
        "purpose": "rolling_public_multisite_warehouse_hourly_dashboard",
        "timezone": DATA_TIMEZONE,
        "data_version": dt.datetime.now(dt.timezone.utc).isoformat(),
        "date_range": {
            "start": iso_date(dates[0]),
            "end": iso_date(dates[-1]),
            "days": len(dates),
        },
        "latest_date": iso_date(dates[-1]),
        "available_dates": [iso_date(date) for date in dates],
        "detail_dates": sorted({
            iso_date(date) for _, date, _ in bundles
        }),
        "exported_at": source_exported_at([
            *selected.values(),
            *detail_sources.values(),
            *([supabase_power_path] if supabase_power_path.exists() else []),
        ]),
        "lark_power": lark_metadata,
        "supabase_power": meter_metadata,
        "sites": site_rows,
        "warehouses": sorted(
            warehouses.values(),
            key=lambda row: (
                row["data_center_name"].lower(), row["warehouse_name"],
            ),
        ),
        "daily_summary": sorted(
            daily_summary,
            key=lambda row: (row["data_center_name"].lower(), row["date"]),
        ),
    }
    temporary = data_dir / "catalog.tmp"
    temporary.write_text(
        json.dumps(catalog, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    atomic_replace(temporary, data_dir / "catalog.json")

    remove_children(days_dir, day_files)
    remove_children(hours_dir, hour_files)
    expected_detail_dirs = {path.split("/", 1)[0] for path in detail_paths}
    remove_children(details_dir, expected_detail_dirs)
    if details_dir.exists():
        for site_dir in details_dir.iterdir():
            if not site_dir.is_dir():
                continue
            expected_dates = {
                path.split("/")[1] for path in detail_paths
                if path.startswith(site_dir.name + "/")
            }
            remove_children(site_dir, expected_dates)
            for date_dir in site_dir.iterdir():
                if not date_dir.is_dir():
                    continue
                expected_names = {
                    path.rsplit("/", 1)[1] for path in detail_paths
                    if path.startswith(f"{site_dir.name}/{date_dir.name}/")
                }
                remove_children(date_dir, expected_names)

    detail_date_labels = sorted({
        iso_date(date) for _, date, _ in bundles
    })
    print(
        f"Published {len(site_rows)} sites, {len(dates)} days, "
        f"{len(all_rows)} warehouse hours; details for {len(bundles)} "
        f"warehouse-days on {', '.join(detail_date_labels) or 'no dates'}; Lark-OM表 "
        f"{len(lark_snapshots)} dated snapshot(s) "
        f"to {destination.resolve()}"
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--summary-root", type=Path, default=Path("outputs/rolling")
    )
    parser.add_argument(
        "--detail-root", type=Path, default=Path("outputs/detail-cache")
    )
    parser.add_argument(
        "--detail-date",
        help=(
            "YYYYMMDD detail date; default includes every available "
            "detail date in the rolling range"
        ),
    )
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--end-date", help="YYYYMMDD; default latest available")
    parser.add_argument("--destination", type=Path, default=Path("dashboard"))
    parser.add_argument(
        "--lark-power",
        type=Path,
        help="Lark-OM表 power snapshot; defaults to DESTINATION/data/lark_power.json",
    )
    parser.add_argument(
        "--lark-history-dir",
        type=Path,
        help=(
            "Dated Lark-OM表 snapshots; defaults to "
            "DESTINATION/data/lark_power_history"
        ),
    )
    parser.add_argument(
        "--theoretical-power",
        type=Path,
        default=Path("inputs") / "矿箱理论功率.xlsx",
        help="Fixed workbook mapping every site warehouse to its rated power",
    )
    parser.add_argument(
        "--supabase-power",
        type=Path,
        help=(
            "Supabase meter snapshot; defaults to "
            "DESTINATION/data/supabase_power.json"
        ),
    )
    args = parser.parse_args()
    build(
        args.summary_root,
        args.destination,
        days=args.days,
        end_date=args.end_date,
        detail_root=args.detail_root,
        detail_date=args.detail_date,
        lark_power_path=args.lark_power,
        lark_history_dir=args.lark_history_dir,
        theoretical_power_path=args.theoretical_power,
        supabase_power_path=args.supabase_power,
    )


if __name__ == "__main__":
    main()
