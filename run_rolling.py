"""Export yesterday and rebuild a seven-day static dashboard."""
import argparse
import datetime as dt
import gzip
import json
import shutil
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from build_dashboard import atomic_replace, build
from sample_export import DEFAULT_THEORETICAL_POWER_PATH, SITES, export


def parse_date(value):
    return dt.datetime.strptime(value, "%Y%m%d").date()


def recent_dates(end_date, days):
    return [
        end_date - dt.timedelta(days=offset)
        for offset in range(days - 1, -1, -1)
    ]


def clear_other_directories(root, keep):
    root = root.resolve()
    if not root.exists():
        return
    for child in root.iterdir():
        if child.name in keep or not child.is_dir():
            continue
        resolved = child.resolve()
        if root not in resolved.parents:
            raise ValueError(f"Refusing to remove path outside {root}: {resolved}")
        shutil.rmtree(resolved)


def download_published_assets(base_url, dates, destination):
    """Restore still-published days so the daily job only queries yesterday."""
    base_url = (base_url or "").rstrip("/")
    if not base_url:
        return

    data_dir = Path(destination) / "data"
    days_dir = data_dir / "days"
    days_dir.mkdir(parents=True, exist_ok=True)
    assets = [("catalog.json", data_dir / "catalog.json")]
    for date in dates:
        date_key = date.strftime("%Y%m%d")
        assets.extend([
            (
                f"days/{date_key}.json.gz",
                days_dir / f"{date_key}.json.gz",
            ),
            (
                f"days/{date_key}.json",
                days_dir / f"{date_key}.json",
            ),
        ])
    for relative, target in assets:
        url = f"{base_url}/data/{relative}"
        request = urllib.request.Request(
            url, headers={"User-Agent": "warehouse-dashboard-rolling/1.0"}
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                content = response.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                print(f"Published asset not found (skip): {url}", flush=True)
                continue
            raise
        temporary = target.with_suffix(target.suffix + ".tmp")
        temporary.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_bytes(content)
        atomic_replace(temporary, target)
        print(f"Restored {target.name}", flush=True)


def import_published_days(destination, summary_root, dates):
    """Convert published day bundles back into per-site summary sources."""
    data_dir = Path(destination) / "data"
    catalog_path = data_dir / "catalog.json"
    catalog = {}
    if catalog_path.exists():
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    catalog_warehouses = catalog.get("warehouses") or []

    for date in dates:
        date_key = date.strftime("%Y%m%d")
        gzip_path = data_dir / "days" / f"{date_key}.json.gz"
        plain_path = data_dir / "days" / f"{date_key}.json"
        if gzip_path.exists():
            with gzip.open(gzip_path, "rt", encoding="utf-8") as stream:
                payload = json.load(stream)
        elif plain_path.exists():
            payload = json.loads(plain_path.read_text(encoding="utf-8"))
        else:
            continue
        rows_by_site = {}
        for row in payload.get("warehouse_rows") or []:
            rows_by_site.setdefault(row["data_center_id"], []).append(row)

        for center_id, rows in rows_by_site.items():
            center_name = rows[0]["data_center_name"]
            site_key = next(
                (name for name, site_id in SITES.items() if site_id == center_id),
                center_name,
            )
            site_warehouses = [
                {
                    "warehouse_id": row["warehouse_id"],
                    "warehouse_name": row["warehouse_name"],
                }
                for row in catalog_warehouses
                if row.get("data_center_id") == center_id
            ]
            if not site_warehouses:
                seen = set()
                site_warehouses = []
                for row in rows:
                    if row["warehouse_id"] in seen:
                        continue
                    seen.add(row["warehouse_id"])
                    site_warehouses.append({
                        "warehouse_id": row["warehouse_id"],
                        "warehouse_name": row["warehouse_name"],
                    })

            target = (
                Path(summary_root) / date_key
                / f"{site_key.lower()}_{date_key}_warehouse_dashboard.json"
            )
            target.parent.mkdir(parents=True, exist_ok=True)
            slim = {
                "schema_version": "2.1",
                "data_center_id": center_id,
                "data_center_name": center_name,
                "date": payload.get("date"),
                "warehouses": site_warehouses,
                "warehouse_rows": rows,
            }
            target.write_text(
                json.dumps(slim, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
        print(f"Imported published day {date_key}", flush=True)


def run(config, end_date, days, summary_root, detail_root, destination,
        skip_existing=False, theoretical_power=DEFAULT_THEORETICAL_POWER_PATH,
        jobs=1, preserve_destination=False, published_base_url=None,
        refresh_latest=False):
    dates = recent_dates(end_date, days)
    date_keys = {date.strftime("%Y%m%d") for date in dates}
    latest_key = dates[-1].strftime("%Y%m%d")

    if published_base_url:
        download_published_assets(published_base_url, dates, destination)
    if preserve_destination:
        import_published_days(destination, summary_root, dates)

    tasks = []
    for date in dates:
        date_key = date.strftime("%Y%m%d")
        latest = date_key == latest_key
        for site in sorted(SITES):
            summary_path = (
                summary_root / date_key
                / f"{site.lower()}_{date_key}_warehouse_dashboard.json"
            )
            detail_path = (
                detail_root / date_key
                / f"{site.lower()}_{date_key}_dashboard.json"
            )
            if skip_existing and not (latest and refresh_latest) and (
                summary_path.exists()
            ) and (
                not latest or detail_path.exists()
            ):
                print(f"Reuse {site} {date_key}", flush=True)
                continue
            tasks.append((date_key, latest, site))

    def run_task(task):
        date_key, latest, site = task
        output_dir = detail_root / date_key if latest else summary_root / date_key
        export(
            config,
            date_key,
            output_dir,
            reuse=False,
            site=site,
            theoretical_power_path=theoretical_power,
            summary_only=not latest,
        )
        if latest:
            destination_dir = summary_root / date_key
            destination_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(
                output_dir
                / f"{site.lower()}_{date_key}_warehouse_dashboard.json",
                destination_dir
                / f"{site.lower()}_{date_key}_warehouse_dashboard.json",
            )
        return date_key, site

    if jobs <= 1:
        for task in tasks:
            run_task(task)
    else:
        with ThreadPoolExecutor(max_workers=jobs) as executor:
            pending = {executor.submit(run_task, task): task for task in tasks}
            try:
                for future in as_completed(pending):
                    date_key, site = future.result()
                    print(f"Completed {site} {date_key}", flush=True)
            except Exception:
                for future in pending:
                    future.cancel()
                raise

    build(
        summary_root,
        destination,
        days=days,
        end_date=latest_key,
        detail_root=detail_root,
        detail_date=latest_key,
    )
    clear_other_directories(summary_root, date_keys)
    clear_other_directories(detail_root, {latest_key})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--date",
        help="End date YYYYMMDD; defaults to yesterday in the configured timezone",
    )
    parser.add_argument(
        "--timezone-offset-hours", type=int, default=8,
        help="Timezone used to determine yesterday; default UTC+8",
    )
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument(
        "--config", default=r"..\功耗数据更新\config.toml",
        help="TOML config; if absent, DB_HOST/DB_PORT/DB_USER/DB_PASSWORD env vars are used",
    )
    parser.add_argument(
        "--summary-root", type=Path, default=Path("outputs/rolling")
    )
    parser.add_argument(
        "--detail-root", type=Path, default=Path("outputs/detail-cache")
    )
    parser.add_argument("--destination", type=Path, default=Path("dashboard"))
    parser.add_argument(
        "--theoretical-power",
        default=str(DEFAULT_THEORETICAL_POWER_PATH),
    )
    parser.add_argument(
        "--skip-existing", action="store_true",
        help="Reuse complete cached dates while bootstrapping",
    )
    parser.add_argument(
        "--refresh-latest", action="store_true",
        help="Re-export the latest date even when a cached copy exists",
    )
    parser.add_argument(
        "--jobs", type=int, default=1,
        help="Number of site/date exports to run concurrently",
    )
    parser.add_argument(
        "--preserve-destination", action="store_true",
        help="Import existing day bundles from the destination before exporting",
    )
    parser.add_argument(
        "--published-base-url",
        help="Download the currently published seven-day data before updating",
    )
    args = parser.parse_args()
    if args.days < 1:
        parser.error("--days must be at least 1")
    if args.jobs < 1:
        parser.error("--jobs must be at least 1")
    end_date = args.date or (
        dt.datetime.now(
            dt.timezone(dt.timedelta(hours=args.timezone_offset_hours))
        ).date() - dt.timedelta(days=1)
    ).strftime("%Y%m%d")
    run(
        Path(args.config),
        parse_date(end_date),
        args.days,
        Path(args.summary_root),
        Path(args.detail_root),
        Path(args.destination),
        args.skip_existing,
        Path(args.theoretical_power),
        args.jobs,
        args.preserve_destination,
        args.published_base_url,
        args.refresh_latest,
    )


if __name__ == "__main__":
    main()
