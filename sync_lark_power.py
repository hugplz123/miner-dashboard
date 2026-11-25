"""Sync public warehouse power fields from the Lark-OM表 snapshot."""
import argparse
import datetime as dt
import json
import random
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path


DEFAULT_BASE_TOKEN = "XTdGbnElFaESn4s7UXrlNuSUgDg"
DEFAULT_TABLE_ID = "tblwSxBniWNTLzwD"
DEFAULT_VIEW_ID = "vewn9RGor2"
DEFAULT_PROFILE = "miner-dashboard"
DEFAULT_OUTPUT = Path("dashboard") / "data" / "lark_power.json"
DEFAULT_HISTORY_DIR = Path("dashboard") / "data" / "lark_power_history"
WAREHOUSE_NUMBER = re.compile(r"^C?0*(\d+)$", re.IGNORECASE)
CONTAINER_CODE = re.compile(r"^(?P<project>.+)-C0*(?P<number>\d+)$", re.IGNORECASE)
PROJECT_SITE = {
    "US-BLOSSOM-01": "Blossom01",
    "US-MAY-01": "May01",
    "US-NIMROD-01": "Nimrod01",
    "US-NIMROD-02": "Nimrod02",
    "US-WHITEOAK-01": "WhiteOak01",
}
RECORD_FIELDS = (
    "TDHash Site",
    "TDHash Warehouse",
    "矿箱编码 Container Code",
    "在架功率",
    "运行中 Running",
    "占位功率",
    "可用机位 Available",
    "机位总数 Total",
    "功率上限 Max Power (kW)",
)


def field_text(value):
    """Read text from the scalar or rich-text shapes returned by Lark."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ("text", "name", "value", "link"):
            text = field_text(value.get(key))
            if text:
                return text
        return ""
    if isinstance(value, (list, tuple)):
        return "".join(field_text(item) for item in value).strip()
    return str(value).strip()


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


def retryable_lark_error(payload, detail):
    error = payload.get("error") or {}
    code = error.get("code")
    subtype = str(error.get("subtype") or "").lower()
    message = str(error.get("message") or detail).lower()
    return (
        code == 429
        or subtype == "rate_limit"
        or bool(error.get("retryable"))
        or "rate limited" in message
        or "http 429" in message
    )


def retryable_cli_failure(detail):
    message = str(detail or "").lower()
    return any(
        marker in message
        for marker in (
            "timed out",
            "timeout",
            "econnreset",
            "etimedout",
            "socket hang up",
            "fetch failed",
            "network error",
            "temporarily unavailable",
            "http 429",
            "http 500",
            "http 502",
            "http 503",
            "http 504",
        )
    )


def request_page(
    command,
    profile,
    endpoint,
    params,
    retries,
    retry_base_delay,
):
    """Request one Lark API page for the model-level mapping sync."""
    for attempt in range(retries + 1):
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
        detail = (process.stderr or process.stdout or "").strip()
        try:
            payload = json.loads(process.stdout)
        except json.JSONDecodeError as exc:
            if attempt < retries and (
                process.returncode == 0 or retryable_cli_failure(detail)
            ):
                delay = retry_base_delay * (2 ** attempt)
                delay *= 1 + random.uniform(0, 0.2)
                time.sleep(delay)
                continue
            message = detail[:2000] or "stdout was empty"
            raise RuntimeError(
                "Lark-OM表 CLI did not return valid JSON "
                f"(exit code {process.returncode}): {message}"
            ) from exc

        if process.returncode == 0 and payload.get("ok"):
            return payload

        if attempt < retries and retryable_lark_error(payload, detail):
            delay = min(60, retry_base_delay * (2 ** attempt))
            delay *= 1 + random.uniform(0, 0.2)
            print(
                "Lark-OM表 rate limit reached; retrying in "
                f"{delay:.1f}s ({attempt + 1}/{retries})",
                flush=True,
            )
            time.sleep(delay)
            continue

        error = payload.get("error") or payload
        raise RuntimeError(
            "Lark-OM表 API request failed with exit code "
            f"{process.returncode}: {error}"
        )
    raise RuntimeError("Lark-OM表 API request exhausted its retry budget")


def fetch_records(
    command,
    profile,
    base_token,
    table_id,
    view_id,
    retries,
    retry_base_delay,
):
    records = []
    with tempfile.TemporaryDirectory(prefix="miner-lark-power-") as temp_dir:
        offset = 0
        while True:
            output = Path(temp_dir) / f"records-{offset}.ndjson"
            manifest_path = output.with_suffix(".manifest.json")
            arguments = [
                *command,
                "--profile", profile,
                "base", "+record-list",
                "--base-token", base_token,
                "--table-id", table_id,
                "--view-id", view_id,
                "--limit", "2000",
                "--format", "ndjson",
                "--output", str(output),
                "--overwrite",
                "--as", "user",
            ]
            if offset:
                arguments.extend(["--offset", str(offset)])
            for field in RECORD_FIELDS:
                arguments.extend(["--field-id", field])

            for attempt in range(retries + 1):
                if output.exists():
                    output.unlink()
                if manifest_path.exists():
                    manifest_path.unlink()
                process = subprocess.run(
                    arguments,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=False,
                )
                detail = (process.stderr or process.stdout or "").strip()
                payload = {}
                try:
                    parsed = json.loads(process.stdout)
                    if isinstance(parsed, dict):
                        payload = parsed
                except json.JSONDecodeError:
                    pass

                if process.returncode == 0 and output.exists():
                    break
                if attempt < retries and (
                    retryable_cli_failure(detail)
                    or retryable_lark_error(payload, detail)
                ):
                    delay = min(60, retry_base_delay * (2 ** attempt))
                    delay *= 1 + random.uniform(0, 0.2)
                    print(
                        "Lark-OM表 read failed; retrying in "
                        f"{delay:.1f}s ({attempt + 1}/{retries})",
                        flush=True,
                    )
                    time.sleep(delay)
                    continue
                error = payload.get("error") or payload or detail[:2000]
                raise RuntimeError(
                    "Lark-OM表 record-list failed with exit code "
                    f"{process.returncode}: {error}"
                )
            else:
                raise RuntimeError(
                    "Lark-OM表 record-list exhausted its retry budget"
                )

            if not manifest_path.exists():
                raise RuntimeError(
                    "Lark-OM表 record-list did not create its manifest"
                )
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            with output.open(encoding="utf-8") as stream:
                records.extend(
                    json.loads(line)
                    for line in stream
                    if line.strip()
                )
            if not manifest.get("has_more"):
                break
            next_offset = manifest.get("next_offset")
            if not isinstance(next_offset, int) or next_offset <= offset:
                raise RuntimeError(
                    "Lark-OM表 pagination stopped without a usable next_offset"
                )
            offset = next_offset
    return records


def public_record(item):
    fields = item.get("fields")
    if not isinstance(fields, dict):
        fields = item
    site = field_text(fields.get("TDHash Site"))
    if site not in PROJECT_SITE.values():
        raise ValueError(
            "Lark-OM表 record "
            f"{item.get('record_id')} has unknown site {site!r}"
        )
    warehouse_number = normalize_warehouse_number(
        field_text(fields.get("TDHash Warehouse"))
    )
    container_code = field_text(
        fields.get("矿箱编码 Container Code")
    ).upper()
    match = CONTAINER_CODE.fullmatch(container_code)
    if not match:
        raise ValueError(
            "Lark-OM表 record "
            f"{item.get('record_id')} has unsupported container code "
            f"{container_code!r}"
        )
    code_project = match.group("project").upper()
    expected_project = next(
        project
        for project, project_site in PROJECT_SITE.items()
        if project_site == site
    )
    if code_project != expected_project:
        raise ValueError(
            "Lark-OM表 record "
            f"{item.get('record_id')} has mismatched site {site!r} "
            f"and container code {container_code!r}"
        )
    if int(match.group("number")) != warehouse_number:
        raise ValueError(
            "Lark-OM表 record "
            f"{item.get('record_id')} has mismatched warehouse "
            f"{warehouse_number!r} and container code {container_code!r}"
        )
    return {
        "site": site,
        "warehouse_number": warehouse_number,
        "container_code": container_code,
        "mounted_power_kw": number_or_none(fields.get("在架功率")),
        "mounted_machine_count": integer_or_none(
            fields.get("运行中 Running")
        ),
        "reserved_power_kw": number_or_none(fields.get("占位功率")),
        "occupied_slots": integer_or_none(
            fields.get("可用机位 Available")
        ),
        "total_slots": integer_or_none(fields.get("机位总数 Total")),
        "power_limit_kw": number_or_none(
            fields.get("功率上限 Max Power (kW)")
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
        args.retries,
        args.retry_base_delay,
    )
    records = [public_record(item) for item in items]
    keys = set()
    for record in records:
        key = (record["site"].casefold(), record["warehouse_number"])
        if key in keys:
            raise ValueError(f"Duplicate Lark-OM表 warehouse key: {key}")
        keys.add(key)
    records.sort(
        key=lambda record: (
            record["site"].casefold(), record["warehouse_number"]
        )
    )
    snapshot_date = parse_snapshot_date(args.snapshot_date)
    payload = {
        "schema_version": "1.0",
        "record_schema": "capacity_v3",
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
        f"Synced {len(records)} Lark-OM表 power records from "
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
        help="Directory for dated Lark-OM表 snapshots (YYYYMMDD.json)",
    )
    parser.add_argument(
        "--snapshot-date",
        help="Snapshot business date in YYYY-MM-DD; defaults to today",
    )
    parser.add_argument(
        "--lark-cli",
        help="Optional path to lark-cli.cmd or the Node CLI entry point",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=6,
        help="Retries for transient Lark-OM表 API errors; defaults to 6",
    )
    parser.add_argument(
        "--retry-base-delay",
        type=float,
        default=2.0,
        help="Initial retry delay in seconds; defaults to 2",
    )
    sync(parser.parse_args())


if __name__ == "__main__":
    main()
