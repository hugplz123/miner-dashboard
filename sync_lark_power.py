"""Sync public warehouse power fields from the Lark Bitable snapshot."""
import argparse
import datetime as dt
import json
import re
import shutil
import subprocess
from pathlib import Path


DEFAULT_BASE_TOKEN = "VuLLbn5bNaIWkoswngWlyEOygof"
DEFAULT_TABLE_ID = "tblNq169SbT5aD2N"
DEFAULT_VIEW_ID = "vewUWFcYgO"
DEFAULT_PROFILE = "miner-dashboard"
DEFAULT_OUTPUT = Path("dashboard") / "data" / "lark_power.json"
DEFAULT_HISTORY_DIR = Path("dashboard") / "data" / "lark_power_history"
WAREHOUSE_NUMBER = re.compile(r"^C?0*(\d+)$", re.IGNORECASE)


def number_or_none(value):
    if value is None or value == "":
        return None
    try:
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def integer_or_none(value):
    number = number_or_none(value)
    return int(number) if number is not None else None


def normalize_warehouse_number(value):
    text = str(value or "").strip()
    match = WAREHOUSE_NUMBER.fullmatch(text)
    if not match:
        raise ValueError(f"Unsupported warehouse number: {value!r}")
    return int(match.group(1))


def find_lark_command(explicit=None):
    candidates = []
    if explicit:
        candidates.append(Path(explicit))
    for name in ("lark-cli.cmd", "lark-cli"):
        resolved = shutil.which(name)
        if resolved:
            candidates.append(Path(resolved))

    for candidate in candidates:
        if not candidate.exists():
            continue
        wrapper_dir = candidate.parent
        node = wrapper_dir / "node.exe"
        run_js = (
            wrapper_dir / "node_modules" / "@larksuite" / "cli"
            / "scripts" / "run.js"
        )
        if node.exists() and run_js.exists():
            return [str(node), str(run_js)]
        if candidate.suffix.lower() == ".ps1":
            return [
                "powershell.exe", "-NoProfile", "-NonInteractive",
                "-ExecutionPolicy", "Bypass", "-File", str(candidate),
            ]
        return [str(candidate)]
    raise FileNotFoundError(
        "lark-cli was not found. Install it or pass --lark-cli."
    )


def fetch_records(command, profile, base_token, table_id, view_id):
    endpoint = (
        f"/open-apis/bitable/v1/apps/{base_token}"
        f"/tables/{table_id}/records"
    )
    records = []
    page_token = None
    while True:
        params = {"page_size": 100, "view_id": view_id}
        if page_token:
            params["page_token"] = page_token
        process = subprocess.run(
            [
                *command,
                "--profile", profile,
                "api", "GET", endpoint,
                "--params", json.dumps(params, separators=(",", ":")),
                "--as", "bot",
                "--json",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        if process.returncode != 0:
            detail = (process.stderr or process.stdout or "").strip()
            raise RuntimeError(
                f"Lark API request failed with exit code "
                f"{process.returncode}: {detail}"
            )
        try:
            payload = json.loads(process.stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError("Lark CLI did not return valid JSON") from exc
        if not payload.get("ok"):
            error = payload.get("error") or payload
            raise RuntimeError(f"Lark API rejected the request: {error}")

        data = payload.get("data") or {}
        page_items = data.get("items") or []
        records.extend(page_items)
        if not data.get("has_more"):
            return records
        next_token = data.get("page_token")
        if not next_token or next_token == page_token:
            raise RuntimeError("Lark pagination stopped without a usable page token")
        page_token = next_token


def public_record(item):
    fields = item.get("fields") or {}
    site = str(fields.get("场地") or "").strip()
    if not site:
        raise ValueError(f"Lark record {item.get('record_id')} has no site")
    warehouse_number = normalize_warehouse_number(fields.get("矿箱编号"))
    return {
        "site": site,
        "warehouse_number": warehouse_number,
        "mounted_power_kw": number_or_none(fields.get("在架功率 kW")),
        "reserved_power_kw": number_or_none(fields.get("占位功率 kW")),
        "unit_theoretical_power_kw": number_or_none(
            fields.get("单机理论平均功率 kW")
        ),
        "power_limit_kw": number_or_none(fields.get("功率上限 kW")),
        "mounted_machine_count": integer_or_none(
            fields.get("在架机器数量")
        ),
        "occupied_slots": integer_or_none(fields.get("已占用机位")),
        "total_slots": integer_or_none(fields.get("机位总数")),
        "vacant_slots": integer_or_none(fields.get("空余机位")),
        "offline_machine_count": integer_or_none(
            fields.get("下架机器数量")
        ),
    }


def parse_snapshot_date(value):
    if not value:
        return dt.date.today().isoformat()
    try:
        return dt.date.fromisoformat(str(value)).isoformat()
    except ValueError as exc:
        raise ValueError(
            f"Invalid snapshot date {value!r}; expected YYYY-MM-DD"
        ) from exc


def write_json_atomic(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temporary.replace(path)


def sync(args):
    command = find_lark_command(args.lark_cli)
    items = fetch_records(
        command,
        args.profile,
        args.base_token,
        args.table_id,
        args.view_id,
    )
    records = [public_record(item) for item in items]
    keys = set()
    for record in records:
        key = (record["site"].casefold(), record["warehouse_number"])
        if key in keys:
            raise ValueError(f"Duplicate Lark warehouse key: {key}")
        keys.add(key)
    records.sort(
        key=lambda record: (
            record["site"].casefold(), record["warehouse_number"]
        )
    )
    snapshot_date = parse_snapshot_date(args.snapshot_date)
    payload = {
        "schema_version": "1.0",
        "source": "lark_bitable",
        "base_token": args.base_token,
        "table_id": args.table_id,
        "view_id": args.view_id,
        "snapshot_date": snapshot_date,
        "synced_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "record_count": len(records),
        "records": records,
    }
    output = Path(args.output)
    history_path = (
        Path(args.history_dir)
        / f"{snapshot_date.replace('-', '')}.json"
    )
    write_json_atomic(output, payload)
    write_json_atomic(history_path, payload)
    sites = sorted({record["site"] for record in records})
    print(
        f"Synced {len(records)} Lark power records from "
        f"{len(sites)} sites for {snapshot_date}; latest={output.resolve()} "
        f"history={history_path.resolve()}"
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default=DEFAULT_PROFILE)
    parser.add_argument("--base-token", default=DEFAULT_BASE_TOKEN)
    parser.add_argument("--table-id", default=DEFAULT_TABLE_ID)
    parser.add_argument("--view-id", default=DEFAULT_VIEW_ID)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--history-dir",
        type=Path,
        default=DEFAULT_HISTORY_DIR,
        help="Directory for dated Lark snapshots (YYYYMMDD.json)",
    )
    parser.add_argument(
        "--snapshot-date",
        help="Snapshot business date in YYYY-MM-DD; defaults to today",
    )
    parser.add_argument(
        "--lark-cli",
        help="Optional path to lark-cli.cmd or the Node CLI entry point",
    )
    sync(parser.parse_args())


if __name__ == "__main__":
    main()
