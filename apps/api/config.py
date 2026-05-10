import os
import sys
import json
import logging
from pathlib import Path
from logging.handlers import RotatingFileHandler

DATA_DIR = os.environ.get(
    "PIXELTAVERN_DATA_DIR",
    os.path.join(Path.home(), ".pixeltavern", "data"),
)
os.makedirs(DATA_DIR, exist_ok=True)
DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{DATA_DIR}/pixel_tavern.db")

# 默认 LLM 配置（DeepSeek）
DEFAULT_BASE_URL = os.environ.get("OPENAI_COMPATIBLE_BASE_URL", "https://api.deepseek.com")
DEFAULT_API_KEY = os.environ.get("OPENAI_COMPATIBLE_API_KEY", "")
DEFAULT_MODEL = os.environ.get("OPENAI_COMPATIBLE_MODEL", "deepseek-v4-flash")

# 世界模型配置（可独立设置）
WORLD_BASE_URL = os.environ.get("WORLD_MODEL_BASE_URL", "")
WORLD_API_KEY = os.environ.get("WORLD_MODEL_API_KEY", "")
WORLD_MODEL = os.environ.get("WORLD_MODEL", "")

# 请求超时
LLM_TIMEOUT = int(os.environ.get("LLM_TIMEOUT", "90"))

LOG_FILE = os.path.join(DATA_DIR, "pixel_tavern.log")

# ---- 统一配置文件 ----
CONFIG_FILE = os.path.join(DATA_DIR, "pixel_tavern.json")

_DEFAULT_CONFIG = {
    "server": {"host": "0.0.0.0", "port": 8000},
    "llm": {},
    "safety_prompt": "",
    "preset_key": "",
    "map_prompt": "",
    "story_background": "",
    "story_theme": "",
    "user_prompt": "",
    "calendar_start": "",
    "character_overrides": {},
    "characters": [],
    "relationship_prompt": "",
    "custom_presets": {},
    "collisions": {"zones": [], "props": []},
}

_LEGACY_FILES = [
    "llm_settings.json",
    "world_prompt.json",
    "safety_prompt.json",
    "collisions.json",
]


def _load_config() -> dict:
    """加载统一配置文件，不存在则返回空 dict。"""
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_config(data: dict) -> None:
    """保存统一配置文件。"""
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _migrate_if_needed() -> None:
    """如果旧版多文件存在而统一配置不存在，迁移合并后删除旧文件。"""
    if os.path.isfile(CONFIG_FILE):
        return
    migrated = dict(_DEFAULT_CONFIG)

    for fname in _LEGACY_FILES:
        path = os.path.join(DATA_DIR, fname)
        try:
            with open(path, "r", encoding="utf-8") as f:
                old = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            continue

        if fname == "llm_settings.json":
            if isinstance(old, dict):
                migrated["llm"] = old
        elif fname == "safety_prompt.json":
            if isinstance(old.get("prompt"), str) and old["prompt"].strip():
                migrated["safety_prompt"] = old["prompt"].strip()
        elif fname == "world_prompt.json":
            for k in ("preset_key", "map_prompt", "story_background", "story_theme",
                      "user_prompt", "calendar_start", "character_overrides",
                      "characters", "relationship_prompt", "custom_presets"):
                if k in old:
                    migrated[k] = old[k]
        elif fname == "collisions.json":
            if isinstance(old.get("zones"), list) or isinstance(old.get("props"), list):
                migrated["collisions"] = {"zones": old.get("zones", []), "props": old.get("props", [])}

    _save_config(migrated)

    # 旧文件重命名为 .bak
    for fname in _LEGACY_FILES:
        path = os.path.join(DATA_DIR, fname)
        if os.path.isfile(path):
            try:
                os.rename(path, path + ".bak")
            except OSError:
                pass


# 模块加载时自动迁移
try:
    _migrate_if_needed()
except Exception:
    pass  # 迁移失败不影响启动，后续操作会创建新配置


def get_config_section(key: str, default=None):
    """读取统一配置的某个 section。"""
    cfg = _load_config()
    if not cfg:
        cfg = dict(_DEFAULT_CONFIG)
    return cfg.get(key, default)


def set_config_section(key: str, value) -> None:
    """写入统一配置的某个 section 并保存。"""
    cfg = _load_config()
    if not cfg:
        cfg = dict(_DEFAULT_CONFIG)
    cfg[key] = value
    _save_config(cfg)


def get_server_host() -> str:
    return str(get_config_section("server", {}).get("host", "0.0.0.0"))


def get_server_port() -> int:
    return int(get_config_section("server", {}).get("port", 8000))


# ---- 日志 ----

def setup_logging():
    os.makedirs(DATA_DIR, exist_ok=True)

    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

    root = logging.getLogger()
    if root.handlers:
        return

    root.setLevel(logging.INFO)

    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    console = logging.StreamHandler()
    console.setFormatter(fmt)
    root.addHandler(console)

    try:
        file_h = RotatingFileHandler(LOG_FILE, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
        file_h.setFormatter(fmt)
        root.addHandler(file_h)
    except Exception:
        pass
