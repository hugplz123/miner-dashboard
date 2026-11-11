"""Build a rolling, static dashboard from exported warehouse summaries."""
import argparse
import datetime as dt
import gzip
import json
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
DETAIL_LEVELS = ("template_rows", "model_rows", "work_mode_rows", "machine_rows")
PRIVATE_FIELDS = {"mac", "source_id", "worker_location"}
EXPECTED_HOURS_PER_DAY = 24
WAREHOUSE_NUMBER = re.compile(r"^C?0*(\d+)$", re.IGNORECASE)
WAREHOUSE_COUNT_OVERRIDES = {"nimrod02": 16}


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


def discover_detail_sources(root, detail_date):
    root = Path(root) if root else None
    selected = {}
    if root and root.exists():
        for path in root.rglob("*_dashboard.json"):
            if path.name.endswith("_warehouse_dashboard.json"):
                continue
            match = DETAIL_PATTERN.match(path.name)
            if not match or match.group("date") != str(detail_date):
                continue
            site = match.group("site")
            previous = selected.get(site)
            if previous is None or path.stat().st_mtime > previous.stat().st_mtime:
                selected[site] = path
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


def load_lark_power(path, expected_date=None):
    path = Path(path)
    if not path.exists():
        return None, {}, None
    snapshot = load_json(path)
    if snapshot.get("schema_version") != "1.0":
        raise ValueError(f"Unsupported Lark power schema in {path}")
    snapshot_date = str(
        snapshot.get("snapshot_date")
        or (iso_date(expected_date) if expected_date else "")
    ).strip()
    try:
        snapshot_date = dt.date.fromisoformat(snapshot_date).isoformat()
    except ValueError as exc:
        raise ValueError(
            f"Lark power snapshot {path} has no valid snapshot_date"
        ) from exc
    if expected_date and snapshot_date != iso_date(expected_date):
        raise ValueError(
            f"Lark snapshot date {snapshot_date} does not match {path.name}"
        )
    by_key = {}
    for record in snapshot.get("records") or []:
        key = (
            str(record.get("site") or "").strip().casefold(),
            int(record["warehouse_number"]),
        )
        if not key[0]:
            raise ValueError("Lark power record has no site")
        if key in by_key:
            raise ValueError(f"Duplicate Lark power record: {key}")
        by_key[key] = record
    if snapshot.get("record_count") != len(by_key):
        raise ValueError("Lark power record_count does not match records")
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


def daily_totals(site_id, site_name, date, rows, warehouse_count):
    valid_power = numeric_sum(rows, "power_ratio_valid_power_sum_w")
    valid_hashrate = numeric_sum(rows, "power_ratio_valid_hashrate_sum_ths")
    theoretical_by_warehouse = {}
    for row in rows:
        warehouse_id = row["warehouse_id"]
        theoretical = row.get("theoretical_power_kw")
        if theoretical is not None:
            theoretical_by_warehouse.setdefault(warehouse_id, theoretical)
    hours = sorted({int(row["hour"]) for row in rows})
    warehouse_hours = defaultdict(set)
    for row in rows:
        warehouse_hours[row["warehouse_id"]].add(int(row["hour"]))
    warehouse_hour_counts = {
        warehouse_id: len(values)
        for warehouse_id, values in sorted(warehouse_hours.items())
    }
    complete_warehouse_count = sum(
        count == EXPECTED_HOURS_PER_DAY
        for count in warehouse_hour_counts.values()
    )
    return {
        "data_center_id": site_id,
        "data_center_name": site_name,
        "date": iso_date(date),
        "hours": hours,
        "hours_with_data": len(hours),
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
        "actual_power_kw": numeric_sum(rows, "actual_power_kw"),
        "theoretical_power_kw": numeric_sum(rows, "theoretical_power_kw"),
        "configured_theoretical_power_kw": sum(
            theoretical_by_warehouse.values()
        ),
        "available_capacity_kw": numeric_sum(rows, "available_capacity_kw"),
        "power_ratio_valid_power_sum_w": valid_power,
        "power_ratio_valid_hashrate_sum_ths": valid_hashrate,
        "power_ratio_overall_w_per_th": (
            valid_power / valid_hashrate if valid_hashrate > 0 else None
        ),
    }


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
          detail_date=None, lark_power_path=None, lark_history_dir=None):
    """Build all static assets. Raises if discovery or validation fails."""
    summary_root = Path(summary_root)
    destination = Path(destination)
    lark_power_path = (
        Path(lark_power_path) if lark_power_path
        else destination / "data" / "lark_power.json"
    )
    lark_history_dir = (
        Path(lark_history_dir) if lark_history_dir
        else destination / "data" / "lark_power_history"
    )
    dates, selected = discover_summary_sources(summary_root, days, end_date)
    detail_date = str(detail_date or dates[-1]).replace("-", "")
    detail_sources = discover_detail_sources(detail_root, detail_date)

    site_names = {}
    warehouses = {}
    rows_by_date = defaultdict(list)
    details = defaultdict(
        lambda: {"template_rows": [], "model_rows": [], "work_mode_rows": [],
                 "machine_rows": []}
    )
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
            }
        rows_by_date[date].extend(
            row for row in slim.get("warehouse_rows", [])
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
                }
        for level in DETAIL_LEVELS:
            for row in full.get(level, []):
                key = (row["data_center_id"], row["hour"], row["warehouse_id"])
                details[key][level].append(sanitize_detail_row(row))

    lark_snapshots = load_lark_power_history(
        lark_history_dir, lark_power_path
    )
    lark_metadata = attach_lark_power(warehouses, lark_snapshots)

    row_keys = {
        (row["data_center_id"], row["hour"], row["warehouse_id"])
        for rows in rows_by_date.values() for row in rows
    }
    all_rows = [row for rows in rows_by_date.values() for row in rows]
    if len(row_keys) != len(all_rows):
        raise ValueError("Duplicate warehouse-hour rows across summaries")

    data_dir = destination / "data"
    days_dir = data_dir / "days"
    details_dir = data_dir / "details"
    days_dir.mkdir(parents=True, exist_ok=True)
    details_dir.mkdir(parents=True, exist_ok=True)
    remove_children(
        data_dir,
        {
            "catalog.json", "days", "details", "lark_power.json",
            "lark_power_history",
        },
    )

    day_files = set()
    for date, rows in rows_by_date.items():
        date_payload = {
            "schema_version": "3.0",
            "date": iso_date(date),
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
            "warehouse_id": warehouse_id,
            "warehouse_name": warehouses[(center_id, warehouse_id)][
                "warehouse_name"
            ],
        })
        bundle["hours"][str(hour)] = payload

    detail_paths = set()
    for (center_id, date, warehouse_id), payload in bundles.items():
        # Day folders use the compact YYYYMMDD key, matching the frontend.
        relative = Path(center_id) / str(date) / f"{warehouse_id}.json.gz"
        detail_paths.add(relative.as_posix())
        write_gzip_json(details_dir / relative, payload)

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
        warehouse_hours_by_date = {}
        for date in dates:
            rows = [
                row for row in rows_by_date[date]
                if row["data_center_id"] == center_id
            ]
            if not rows:
                continue
            site_dates.append(iso_date(date))
            hours = sorted({row["hour"] for row in rows})
            hours_by_date[iso_date(date)] = hours
            warehouse_hours = defaultdict(set)
            for row in rows:
                warehouse_hours[row["warehouse_id"]].add(row["hour"])
            warehouse_hours_by_date[iso_date(date)] = {
                warehouse_id: sorted(values)
                for warehouse_id, values in sorted(warehouse_hours.items())
            }
            total = daily_totals(
                center_id, center_name, date, rows, len(site_warehouses)
            )
            site_daily.append(total)
            daily_summary.append(total)
        site_rows.append({
            "data_center_id": center_id,
            "data_center_name": center_name,
            "warehouse_count": len(site_warehouses),
            "warehouses_with_data": len({
                row["warehouse_id"] for row in all_rows
                if row["data_center_id"] == center_id
            }),
            "available_dates": site_dates,
            "hours_by_date": hours_by_date,
            "warehouse_hours_by_date": warehouse_hours_by_date,
            "daily_summary": site_daily,
            "lark_power_by_date": site_lark_by_date,
        })

    catalog = {
        "schema_version": "3.2",
        "purpose": "rolling_public_multisite_warehouse_hourly_dashboard",
        "date_range": {
            "start": iso_date(dates[0]),
            "end": iso_date(dates[-1]),
            "days": len(dates),
        },
        "latest_date": iso_date(dates[-1]),
        "available_dates": [iso_date(date) for date in dates],
        "detail_dates": sorted({iso_date(detail_date)}) if bundles else [],
        "exported_at": source_exported_at([
            *selected.values(),
            *detail_sources.values(),
        ]),
        "lark_power": lark_metadata,
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

    print(
        f"Published {len(site_rows)} sites, {len(dates)} days, "
        f"{len(all_rows)} warehouse hours; details for {len(bundles)} "
        f"warehouse-days on {iso_date(detail_date)}; Lark "
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
    parser.add_argument("--detail-date", help="YYYYMMDD detail date; default latest")
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--end-date", help="YYYYMMDD; default latest available")
    parser.add_argument("--destination", type=Path, default=Path("dashboard"))
    parser.add_argument(
        "--lark-power",
        type=Path,
        help="Lark power snapshot; defaults to DESTINATION/data/lark_power.json",
    )
    parser.add_argument(
        "--lark-history-dir",
        type=Path,
        help=(
            "Dated Lark snapshots; defaults to "
            "DESTINATION/data/lark_power_history"
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
    )


if __name__ == "__main__":
    main()
