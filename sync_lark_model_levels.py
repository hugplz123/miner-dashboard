"""Sync the Lark miner model/API-to-Level mapping used by the dashboard."""
import argparse
import datetime as dt
from pathlib import Path

from model_levels import (
    build_mapping_index,
    normalize_api_value,
    normalize_model_name,
)
from sync_lark_power import (
    find_lark_command,
    request_page,
    write_json_atomic,
)


DEFAULT_BASE_TOKEN = "ElFJbNGGGaVxLGsi0bhlYjp5gdh"
DEFAULT_TABLE_ID = "tblMgWKSaTOsx5Sw"
DEFAULT_VIEW_ID = "vewlsAt3oa"
DEFAULT_PROFILE = "miner-dashboard"
DEFAULT_OUTPUT = Path("dashboard") / "data" / "model_levels.json"


def text_value(value):
    if value is None:
        return ""
    if isinstance(value, list):
        return " ".join(
            item.get("text", "") if isinstance(item, dict) else str(item)
            for item in value
        ).strip()
    if isinstance(value, dict):
        return str(value.get("text") or value.get("name") or "").strip()
    return str(value).strip()


def public_record(item):
    fields = item.get("fields") or {}
    raw_model = text_value(fields.get("Model"))
    raw_api = text_value(fields.get("API字段"))
    model = normalize_model_name(raw_model)
    api = normalize_api_value(raw_api)
    level = text_value(fields.get("Level"))
    if not model or not api or not level:
        raise ValueError(
            f"Lark model record {item.get('record_id')} is incomplete: "
            f"model={raw_model!r}, api={raw_api!r}, level={level!r}"
        )
    return {
        "model": model,
        "raw_model": raw_model,
        "api_field": api,
        "raw_api_field": raw_api,
        "level": level,
        "brand": text_value(fields.get("Brand")) or None,
        "provider": text_value(fields.get("Provider")) or None,
        "sequence": text_value(fields.get("序号")) or None,
        "source_record_id": item.get("record_id"),
    }


def fetch_records(
    command,
    profile,
    base_token,
    table_id,
    view_id,
    retries,
    retry_base_delay,
):
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
        payload = request_page(
            command,
            profile,
            endpoint,
            params,
            retries,
            retry_base_delay,
        )
        data = payload.get("data") or {}
        records.extend(data.get("items") or [])
        if not data.get("has_more"):
            return records
        next_token = data.get("page_token")
        if not next_token or next_token == page_token:
            raise RuntimeError("Lark pagination stopped without a usable page token")
        page_token = next_token


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
    _, key_sources = build_mapping_index(records)
    duplicate_keys = [
        {
            "model": sources[0]["model"],
            "api_field": sources[0]["api_field"],
            "level": sources[0]["level"],
            "source_record_ids": [
                source.get("source_record_id") for source in sources
            ],
        }
        for sources in key_sources.values()
        if len(sources) > 1
    ]
    records.sort(
        key=lambda record: (
            record["model"].casefold(),
            record["api_field"].casefold(),
            record["level"].casefold(),
        )
    )
    payload = {
        "schema_version": "1.0",
        "source": "lark_bitable",
        "base_token": args.base_token,
        "table_id": args.table_id,
        "view_id": args.view_id,
        "synced_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "record_count": len(records),
        "unique_mapping_count": len(key_sources),
        "duplicate_keys": duplicate_keys,
        "records": records,
    }
    output = Path(args.output)
    write_json_atomic(output, payload)
    print(
        f"Synced {len(records)} Lark model-level records into "
        f"{len(key_sources)} unique mappings; latest={output.resolve()}"
    )
    if duplicate_keys:
        print(
            f"Warning: {len(duplicate_keys)} duplicate mapping keys were "
            "collapsed and recorded in the payload.",
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default=DEFAULT_PROFILE)
    parser.add_argument("--base-token", default=DEFAULT_BASE_TOKEN)
    parser.add_argument("--table-id", default=DEFAULT_TABLE_ID)
    parser.add_argument("--view-id", default=DEFAULT_VIEW_ID)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--lark-cli",
        help="Optional path to lark-cli.cmd or the Node CLI entry point",
    )
    parser.add_argument("--retries", type=int, default=6)
    parser.add_argument("--retry-base-delay", type=float, default=2.0)
    sync(parser.parse_args())


if __name__ == "__main__":
    main()
