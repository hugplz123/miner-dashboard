"""Reconcile every exported drill-down level against the refreshed source cache."""
import csv
import json
from collections import Counter, defaultdict
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "output"
PREFIX = "nimrod01_20261029"
IDENTITIES = {
    "template": ("client_miner_template_id",),
    "model": ("client_miner_template_id", "model"),
    "work_mode": ("client_miner_template_id", "model", "work_mode"),
}


def read_csv(suffix):
    with (ROOT / f"{PREFIX}_{suffix}.csv").open(
        encoding="utf-8-sig", newline=""
    ) as stream:
        return list(csv.DictReader(stream))


def close(actual, expected):
    if expected is None:
        assert actual is None or actual == "", (actual, expected)
        return
    assert actual is not None and actual != ""
    assert abs(Decimal(str(actual)) - expected) <= max(
        Decimal("1e-10"), abs(expected) * Decimal("1e-12")
    ), (actual, expected)


cache = json.loads((ROOT / f"{PREFIX}_source.json").read_text(encoding="utf-8"))
raw = cache["rows"]
assert raw and "work_mode" in raw[0]
keys = [(r["data_center_id"], r["hour"], r["ip"]) for r in raw]
assert len(keys) == len(set(keys))
groups = defaultdict(list)
expected_levels = {level: Counter() for level in IDENTITIES}
for row in raw:
    warehouse_ids = {s.split("-")[0] for s in json.loads(row["worker_location"])}
    assert len(warehouse_ids) == 1
    warehouse_id = next(iter(warehouse_ids))
    warehouse_key = (row["data_center_id"], row["hour"], warehouse_id)
    groups[warehouse_key].append(row)
    for level, fields in IDENTITIES.items():
        identity = tuple(row.get(field) or "" for field in fields)
        expected_levels[level][warehouse_key + identity] += 1

summary = read_csv("warehouse_hourly")
details = read_csv("machine_hourly")
dashboard = json.loads((ROOT / f"{PREFIX}_dashboard.json").read_text(encoding="utf-8"))
assert dashboard["schema_version"] == "2.0"
assert len(summary) == len(groups) == len(dashboard["warehouse_rows"])
assert len(details) == len(raw) == len(dashboard["machine_rows"])
raw_by_id = {r["id"]: r for r in raw}
for row in details:
    original = raw_by_id[row["源记录ID"]]
    assert row["档位(work_mode)"] == (original["work_mode"] or "")
    close(row["平均算力(TH/s)"], Decimal(original["avg_hashrate"]) / Decimal(10**12))
    close(
        row["温度(°C)"],
        Decimal(original["temperature"]) if original["temperature"] is not None else None,
    )

actual_levels = {}
for level, fields in IDENTITIES.items():
    rows = read_csv(f"{level}_hourly")
    actual = Counter()
    for row in rows:
        base = (row["场地ID"], int(row["小时"]), row["矿箱ID"])
        identity = []
        if "client_miner_template_id" in fields:
            identity.append(row["算力组ID"])
        if "model" in fields:
            identity.append(row["型号"])
        if "work_mode" in fields:
            identity.append(row["档位(work_mode)"])
        key = base + tuple(identity)
        assert key not in actual
        actual[key] = int(row["矿机数量(去重IP)"])
    assert actual == expected_levels[level]
    actual_levels[level] = rows

valid_count = 0
for row in summary:
    key = (row["场地ID"], int(row["小时"]), row["矿箱ID"])
    machines = groups[key]
    actual_power_kw = sum(
        (Decimal(m["avg_power"]) for m in machines if m["avg_power"] is not None),
        Decimal(0),
    ) / Decimal(1000)
    close(row["实际功率(kW)"], actual_power_kw)
    assert Decimal(row["理论功率(kW)"]) > 0
    close(
        row["负载率"],
        actual_power_kw / Decimal(row["理论功率(kW)"]),
    )
    close(
        row["容量差额(kW)"],
        Decimal(row["理论功率(kW)"]) - actual_power_kw,
    )
    close(
        row["可填负荷(kW)"],
        max(Decimal(row["理论功率(kW)"]) - actual_power_kw, Decimal(0)),
    )
    assert int(row["矿机数量(去重IP)"]) == len(machines)
    assert int(row["算力组数量"]) == len({
        m["client_miner_template_id"] for m in machines
        if m["client_miner_template_id"]
    })
    pairs = [
        (Decimal(m["avg_power"]), Decimal(m["avg_hashrate"]) / Decimal(10**12))
        for m in machines
        if m["avg_power"] is not None and m["avg_hashrate"] is not None
        and Decimal(m["avg_power"]) > 0 and Decimal(m["avg_hashrate"]) > 0
    ]
    valid_count += len(pairs)
    ratios = [power / hashrate for power, hashrate in pairs]
    close(
        row["整体功耗比(W/TH)"],
        sum(p for p, h in pairs) / sum(h for p, h in pairs) if pairs else None,
    )
    close(row["最小单机功耗比(W/TH)"], min(ratios) if ratios else None)

assert len(read_csv("anomalies")) == len(raw) - valid_count
slim_dashboard = json.loads(
    (ROOT / f"{PREFIX}_warehouse_dashboard.json").read_text(encoding="utf-8")
)
assert slim_dashboard["schema_version"] == "2.1"
assert len(slim_dashboard["warehouse_rows"]) == len(summary)
assert "machine_rows" not in slim_dashboard
print(
    f"PASS: {len(summary)} warehouse, {len(actual_levels['template'])} template, "
    f"{len(actual_levels['model'])} model, {len(actual_levels['work_mode'])} work-mode, "
    f"{len(details)} machine rows"
)
