"""Sync hourly warehouse meter power from Supabase into a static JSON file."""
import argparse
import datetime as dt
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path


SCHEMA_VERSION = "1.0"
TABLE = "power_meter_readings"
DEFAULT_ENV_PATH = Path("supabase.local.env")
DEFAULT_OUTPUT_PATH = Path("dashboard") / "data" / "supabase_power.json"
PAGE_SIZE = 1000
MAX_PAGES = 100
WAREHOUSE_NUMBER = re.compile(r"^C?0*(\d+)$", re.IGNORECASE)
ISO_FRACTION = re.compile(
    r"^(?P<prefix>.*\.)(?P<fraction>\d+)(?P<suffix>Z|[+-]\d{2}:\d{2})$"
)
CANONICAL_SITES = {
    "nimrod01": "Nimrod01",
    "nimrod02": "Nimrod02",
    "whiteoak01": "WhiteOak01",
    "may01": "May01",
    "blossom01": "Blossom01",
    "koye01": "Koye01",
}


def parse_date(value):
    return dt.datetime.strptime(str(value), "%Y%m%d").date()


def recent_dates(end_date, days):
    return [
        end_date - dt.timedelta(days=offset)
        for offset in range(days - 1, -1, -1)
    ]


def load_env(path):
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(
            f"Supabase environment file not found: {path}"
        )
    values = {}
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        name, value = line.split("=", 1)
        values[name.strip()] = value.strip().strip("\"'")
    missing = [
        name for name in ("SUPABASE_URL", "SUPABASE_KEY")
        if not values.get(name)
    ]
    if missing:
        raise ValueError(
            "Missing Supabase settings in "
            f"{path}: {', '.join(missing)}"
        )
    return values["SUPABASE_URL"].rstrip("/"), values["SUPABASE_KEY"]


def canonical_site(value):
    text = str(value or "").strip()
    if not text:
        raise ValueError("power_meter_readings.site_id is empty")
    normalized = re.sub(r"[\s_-]+", "", text).casefold()
    return CANONICAL_SITES.get(normalized, text)


def normalize_warehouse(value):
    text = str(value or "").strip()
    match = WAREHOUSE_NUMBER.fullmatch(text)
    if not match:
        raise ValueError(
            f"Unsupported power_meter_readings.container_name: {value!r}"
        )
    return f"C{int(match.group(1)):02d}"


def parse_timestamp(value, field):
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"power_meter_readings.{field} is empty")
    fraction = ISO_FRACTION.fullmatch(text)
    if fraction:
        text = (
            fraction.group("prefix")
            + fraction.group("fraction")[:6].ljust(6, "0")
            + fraction.group("suffix")
        )
    parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def hour_integer(value):
    return int(value.strftime("%Y%m%d%H"))


def fetch_page(base_url, key, start, end_exclusive, offset):
    endpoint = f"{base_url}/rest/v1/{TABLE}"
    query = urllib.parse.urlencode([
        (
            "select",
            "site_id,container_name,hour_bucket,recorded_at,"
            "total_active_power",
        ),
        ("hour_bucket", f"gte.{start.isoformat()}"),
        ("hour_bucket", f"lt.{end_exclusive.isoformat()}"),
        ("order", "hour_bucket.asc,recorded_at.asc"),
        ("limit", PAGE_SIZE),
        ("offset", offset),
    ])
    request = urllib.request.Request(
        f"{endpoint}?{query}",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "User-Agent": "warehouse-dashboard-supabase-sync/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        payload = json.load(response)
    if not isinstance(payload, list):
        raise ValueError(
            f"Unexpected Supabase response for {TABLE}: {type(payload).__name__}"
        )
    return payload


def fetch_rows(base_url, key, start, end_exclusive):
    rows = []
    for page in range(MAX_PAGES):
        offset = page * PAGE_SIZE
        batch = fetch_page(base_url, key, start, end_exclusive, offset)
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            return rows
    raise RuntimeError(
        f"Supabase result exceeded {MAX_PAGES * PAGE_SIZE} rows; narrow the range"
    )


def deduplicate_rows(raw_rows, start, end_exclusive):
    by_key = {}
    closest_distance_by_key = {}
    ignored = 0
    invalid_power = 0
    for raw in raw_rows:
        if raw.get("total_active_power") is None:
            invalid_power += 1
            continue
        try:
            bucket = parse_timestamp(raw.get("hour_bucket"), "hour_bucket")
            recorded_at = parse_timestamp(
                raw.get("recorded_at"), "recorded_at"
            )
            if not start <= bucket < end_exclusive:
                ignored += 1
                continue
            power = float(raw["total_active_power"])
            if power < 0:
                raise ValueError("total_active_power is negative")
            site = canonical_site(raw.get("site_id"))
            warehouse_name = normalize_warehouse(
                raw.get("container_name")
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(
                "Invalid power_meter_readings row: "
                f"{raw!r}"
            ) from exc
        record = {
            "site": site,
            "warehouse_name": warehouse_name,
            "hour": hour_integer(bucket),
            "meter_power_kw": round(power, 6),
            "recorded_at": recorded_at.isoformat(),
        }
        key_tuple = (site.casefold(), record["hour"], warehouse_name)
        previous = by_key.get(key_tuple)
        distance = abs((recorded_at - bucket).total_seconds())
        previous_distance = closest_distance_by_key.get(key_tuple)
        # The hourly value is the sample nearest the start of the bucket.
        same_distance_but_earlier = (
            previous is not None
            and distance == previous_distance
            and recorded_at
            < parse_timestamp(previous["recorded_at"], "recorded_at")
        )
        if (
            previous is None
            or distance < previous_distance
            or same_distance_but_earlier
        ):
            by_key[key_tuple] = record
            closest_distance_by_key[key_tuple] = distance
    records = sorted(
        by_key.values(),
        key=lambda item: (
            item["site"].casefold(), item["hour"], item["warehouse_name"]
        ),
    )
    return records, ignored, invalid_power


def coverage_summary(records, dates):
    by_site = defaultdict(list)
    for record in records:
        by_site[record["site"]].append(record)
    sites = []
    for site, site_records in sorted(
        by_site.items(), key=lambda item: item[0].casefold()
    ):
        hours = sorted({record["hour"] for record in site_records})
        warehouses = sorted({
            record["warehouse_name"] for record in site_records
        })
        sites.append({
            "site": site,
            "record_count": len(site_records),
            "hour_count": len(hours),
            "warehouse_count": len(warehouses),
            "first_hour": hours[0],
            "last_hour": hours[-1],
            "warehouses": warehouses,
        })
    return {
        "start_date": dates[0].isoformat(),
        "end_date": dates[-1].isoformat(),
        "sites": sites,
    }


def write_atomic(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    temporary.replace(path)


def sync(
    end_date,
    days=7,
    env_path=DEFAULT_ENV_PATH,
    output_path=DEFAULT_OUTPUT_PATH,
):
    if days < 1:
        raise ValueError("days must be at least 1")
    dates = recent_dates(end_date, days)
    start = dt.datetime.combine(
        dates[0], dt.time.min, tzinfo=dt.timezone.utc
    )
    end_exclusive = dt.datetime.combine(
        dates[-1] + dt.timedelta(days=1),
        dt.time.min,
        tzinfo=dt.timezone.utc,
    )
    base_url, key = load_env(env_path)
    raw_rows = fetch_rows(base_url, key, start, end_exclusive)
    records, ignored, invalid_power = deduplicate_rows(
        raw_rows, start, end_exclusive
    )
    if not records:
        raise ValueError(
            "Supabase returned no usable power meter rows for "
            f"{dates[0].isoformat()} through {dates[-1].isoformat()} UTC"
        )
    payload = {
        "schema_version": SCHEMA_VERSION,
        "source": "supabase_power_meter",
        "table": f"public.{TABLE}",
        "timezone": "UTC+0",
        "synced_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "date_range": {
            "start": dates[0].isoformat(),
            "end": dates[-1].isoformat(),
        },
        "raw_record_count": len(raw_rows),
        "record_count": len(records),
        "ignored_out_of_range_count": ignored,
        "invalid_power_count": invalid_power,
        "duplicate_count": max(
            0, len(raw_rows) - ignored - invalid_power - len(records)
        ),
        "coverage": coverage_summary(records, dates),
        "records": records,
    }
    write_atomic(output_path, payload)
    return payload


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--end",
        help="Inclusive UTC end date YYYYMMDD; defaults to yesterday UTC",
    )
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument(
        "--env", type=Path, default=DEFAULT_ENV_PATH,
        help="Local Supabase environment file",
    )
    parser.add_argument(
        "--output", type=Path, default=DEFAULT_OUTPUT_PATH,
        help="Static JSON consumed by build_dashboard.py",
    )
    args = parser.parse_args()
    end_date = (
        parse_date(args.end)
        if args.end
        else dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=1)
    )
    payload = sync(
        end_date,
        days=args.days,
        env_path=args.env,
        output_path=args.output,
    )
    sites = ", ".join(
        f"{item['site']} {item['record_count']}"
        for item in payload["coverage"]["sites"]
    )
    print(
        f"Synced {payload['record_count']} hourly meter records "
        f"({payload['raw_record_count']} raw, "
        f"{payload['duplicate_count']} duplicate) for {sites} "
        f"to {Path(args.output).resolve()}"
    )


if __name__ == "__main__":
    main()
