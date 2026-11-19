"""Canonical miner model names and Lark model/API-to-Level mapping."""
import json
import re
import unicodedata
from pathlib import Path


DEFAULT_MODEL_LEVELS_PATH = Path("dashboard") / "data" / "model_levels.json"
PARENTHETICAL_SUFFIX = re.compile(r"\s*\([^()]*\)\s*$")
FIRMWARE_SUFFIX = re.compile(r"_[A-Z]{2}\d+\s*$", re.IGNORECASE)
A15_FIRMWARE_SUFFIX = re.compile(
    r"^(A15 Pro|A15 XP|A15x|15XP|15x|15)-\d{2,3}$",
    re.IGNORECASE,
)
MODEL_ALIASES = {
    "15": "A15",
    "15x": "A15Pro",
    "a15x": "A15Pro",
    "a15 pro": "A15Pro",
    "a15pro": "A15Pro",
    "15xp": "A15 XP",
    "a15xp": "A15 XP",
}
MISSING_MODEL_LEVEL = "未提供型号"
MISSING_API_LEVEL = "未提供 API 字段"
UNMAPPED_LEVEL_TEMPLATE = "未匹配 Level (API: {api})"


def normalize_model_name(value):
    """Return the dashboard model name without known vendor/firmware suffixes."""
    text = " ".join(str(value or "").strip().split())
    if not text:
        return ""
    text = PARENTHETICAL_SUFFIX.sub("", text).strip()
    text = FIRMWARE_SUFFIX.sub("", text).strip()
    text = A15_FIRMWARE_SUFFIX.sub(r"\1", text)
    return MODEL_ALIASES.get(text.casefold(), text)


def normalize_api_value(value):
    """Normalize whitespace and glyph width in the database work_mode/API value."""
    text = unicodedata.normalize("NFKC", str(value or ""))
    return " ".join(text.strip().split())


def mapping_key(model, api):
    return (
        normalize_model_name(model).casefold(),
        normalize_api_value(api).casefold(),
    )


def build_mapping_index(records):
    """Build a unique (model, API) lookup and reject conflicting Levels."""
    index = {}
    key_sources = {}
    for record in records:
        model = normalize_model_name(record.get("model"))
        api = normalize_api_value(record.get("api_field"))
        level = str(record.get("level") or "").strip()
        if not model or not api or not level:
            raise ValueError(
                "Model-level record requires model, api_field and level: "
                f"{record!r}"
            )
        key = mapping_key(model, api)
        existing = index.get(key)
        if existing and existing["level"] != level:
            raise ValueError(
                "Conflicting Lark model-level mapping for "
                f"{model!r} + {api!r}: "
                f"{existing['level']!r} vs {level!r}"
            )
        if existing:
            key_sources[key].append(record)
            continue
        index[key] = record
        key_sources[key] = [record]
    return index, key_sources


def load_model_level_mapping(path=DEFAULT_MODEL_LEVELS_PATH):
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(
            "Model-level mapping was not found. Run "
            f"python sync_lark_model_levels.py first: {path}"
        )
    payload = json.loads(path.read_text(encoding="utf-8"))
    records = payload.get("records") or []
    if not records:
        raise ValueError(f"Model-level mapping has no records: {path}")
    index, _ = build_mapping_index(records)
    return index


def resolve_model_level(raw_model, raw_api, mapping):
    """Return canonical model, display Level and mapping status."""
    model = normalize_model_name(raw_model)
    api = normalize_api_value(raw_api)
    if not model:
        return model, MISSING_MODEL_LEVEL, "missing_model"
    if not api:
        return model, MISSING_API_LEVEL, "missing_api"
    record = mapping.get(mapping_key(model, api))
    if record:
        return model, str(record["level"]).strip(), "mapped"
    return model, UNMAPPED_LEVEL_TEMPLATE.format(api=api), "unmapped"
