from __future__ import annotations

import io
import json
import logging
import os
import shutil
import zipfile
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from models.schemas import LLMSettings, WorldPromptSettings
from config import DEFAULT_BASE_URL, DEFAULT_API_KEY, DEFAULT_MODEL, DATA_DIR
from services.prompt_builder import (
    DEFAULT_PROMPT_PRESET_KEY,
    DEFAULT_PROMPT_PRESETS,
    DEFAULT_USER_PROMPT,
    SAFETY_AUDIT_PROMPT,
    build_system_prompt_from_data,
    characters_for_preset,
    clone_characters_for_custom_preset,
    get_calendar_start_iso,
    normalize_character_data,
    normalize_world_prompt_data,
    prompt_presets_for_api,
    _prompt_config_from_data,
    _load_custom_presets,
    _save_custom_presets,
    get_all_presets,
)
from services.llm_client import _get_config, chat_completions_url
from services.daily_news import create_manual_daily_news_guidance, get_daily_news_guidance_status

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/settings", tags=["settings"])

# Asset paths shared with characters router
APPS_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEB_ASSETS_DIR = os.path.join(APPS_DIR, "web", "public", "assets")
MANIFEST_FILE = os.path.join(WEB_ASSETS_DIR, "manifest.json")
IMPORTED_ASSETS_FILE = os.path.join(DATA_DIR, "imported_npc_assets.json")
DEFAULT_ASSET_FOLDERS = {"酒保", "勇士", "女巫", "诗人", "游侠", "神秘客"}

PROMPT_TOP_LEVEL_OVERRIDE_KEYS = (
    "story_background",
    "story_theme",
    "user_prompt",
    "calendar_start",
    "character_overrides",
    "characters",
    "relationship_prompt",
)


def _load_settings() -> dict:
    from config import get_config_section
    return get_config_section("llm", {})


def _save_settings(data: dict) -> None:
    from config import set_config_section
    set_config_section("llm", data)


@router.get("/llm")
async def get_llm_settings():
    data = _load_settings()
    configured = bool(data.get("base_url") and data.get("api_key") and data.get("model"))
    return LLMSettings(
        base_url=data.get("base_url", DEFAULT_BASE_URL),
        api_key="",
        model=data.get("model", DEFAULT_MODEL),
        configured=configured or bool(DEFAULT_API_KEY),
        daily_news_guidance_enabled=bool(data.get("daily_news_guidance_enabled")),
    )


@router.put("/llm")
async def update_llm_settings(settings: LLMSettings):
    data = _load_settings()
    if settings.base_url:
        data["base_url"] = settings.base_url
    if settings.api_key:
        data["api_key"] = settings.api_key
    if settings.model:
        data["model"] = settings.model
    data["daily_news_guidance_enabled"] = settings.daily_news_guidance_enabled
    _save_settings(data)
    return {"ok": True, "message": "已保存"}


@router.post("/llm/test")
async def test_llm_connection():
    base_url, api_key, model = _get_config()
    if not base_url or not model:
        return {"ok": False, "message": "LLM 配置不完整"}

    headers = {"Content-Type": "application/json"}
    if api_key and api_key != "ollama":
        headers["Authorization"] = f"Bearer {api_key}"

    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "Hi"}],
        "max_tokens": 16,
    }

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                chat_completions_url(base_url),
                headers=headers,
                json=payload,
            )
            resp.raise_for_status()
            return {"ok": True, "message": "LLM 连接正常"}
    except Exception as e:
        return {"ok": False, "message": str(e)[:100]}


@router.get("/daily-news-guidance")
async def get_daily_news_guidance():
    return get_daily_news_guidance_status()


@router.post("/daily-news-guidance/trigger")
async def trigger_daily_news_guidance():
    return await create_manual_daily_news_guidance()


# ---- World Prompt 配置 ----

def _load_prompt() -> dict:
    from config import get_config_section
    cfg = {}
    for k in ("preset_key", "map_prompt", "story_background", "story_theme",
              "user_prompt", "calendar_start", "character_overrides",
              "characters", "relationship_prompt", "custom_presets"):
        v = get_config_section(k)
        if v is not None:
            cfg[k] = v
    return normalize_world_prompt_data(cfg) if cfg else {}


def _save_prompt(data: dict) -> None:
    from config import set_config_section
    normalized = normalize_world_prompt_data(data)
    for k in ("preset_key", "map_prompt", "story_background", "story_theme",
              "user_prompt", "calendar_start", "character_overrides",
              "characters", "relationship_prompt", "custom_presets"):
        if k in normalized:
            set_config_section(k, normalized[k])


def _clear_prompt_overrides(data: dict) -> None:
    """Keep global prompt state from shadowing the selected preset."""
    for key in PROMPT_TOP_LEVEL_OVERRIDE_KEYS:
        data.pop(key, None)


def _prompt_payload(data: dict, message: str = "World Prompt 已保存") -> dict:
    cfg = _prompt_config_from_data(data)
    has_top_level_override = any(
        data.get(key)
        for key in PROMPT_TOP_LEVEL_OVERRIDE_KEYS
        if key != "calendar_start"
    )
    return {
        "ok": True,
        "message": message,
        "preset_key": cfg["preset_key"],
        "presets": prompt_presets_for_api(),
        "story_background": cfg["story_background"],
        "story_theme": cfg["story_theme"],
        "map_prompt": cfg["map_prompt"],
        "system_prompt": build_system_prompt_from_data(data),
        "safety_prompt": SAFETY_AUDIT_PROMPT,
        "user_prompt": cfg["user_prompt"],
        "calendar_start": cfg["calendar_start"],
        "character_overrides": cfg.get("character_overrides", {}),
        "characters": cfg.get("characters", []),
        "relationship_prompt": cfg.get("relationship_prompt", ""),
        "is_custom": cfg["preset_key"] not in DEFAULT_PROMPT_PRESETS or has_top_level_override,
    }


def _resolve_preset_or_404(preset_key: str) -> str:
    key = str(preset_key or DEFAULT_PROMPT_PRESET_KEY).strip() or DEFAULT_PROMPT_PRESET_KEY
    if key not in get_all_presets():
        raise HTTPException(404, f"风格预设不存在: {key}")
    return key


def _clean_custom_characters(raw_characters: object, base_preset_key: str) -> list[dict]:
    # 显式传了空列表就保持空，不再从基础预设克隆
    if isinstance(raw_characters, list):
        source = raw_characters
    else:
        source = clone_characters_for_custom_preset(base_preset_key)
    return [
        normalize_character_data(item, read_only=False)
        for item in source
        if isinstance(item, dict) and str(item.get("key") or "").strip()
    ]


def _custom_preset_data(key: str, preset: dict, base_preset_key: str, existing: dict | None = None) -> dict:
    existing = existing if isinstance(existing, dict) else {}
    base_key = _resolve_preset_or_404(base_preset_key)
    base_cfg = _prompt_config_from_data({"preset_key": base_key})

    def text_field(field: str, fallback: str = "", allow_empty: bool = False) -> str:
        if field in preset:
            value = str(preset.get(field, "")).strip()
            return value if value or allow_empty else fallback
        if field in existing:
            return str(existing.get(field, "")).strip()
        return fallback

    characters_source = preset.get("characters") if "characters" in preset else existing.get("characters")
    return {
        "label": text_field("label", key)[:32],
        "description": text_field("description", "用户自定义风格", allow_empty=True)[:128],
        "story_background": text_field("story_background", allow_empty=True),
        "story_theme": text_field("story_theme", allow_empty=True),
        "user_prompt": text_field("user_prompt", DEFAULT_USER_PROMPT, allow_empty=True),
        "calendar_start": text_field("calendar_start", base_cfg["calendar_start"] or get_calendar_start_iso()),
        "character_overrides": preset.get("character_overrides")
        if isinstance(preset.get("character_overrides"), dict)
        else existing.get("character_overrides", {}),
        "characters": _clean_custom_characters(characters_source, base_key),
        "relationship_prompt": text_field("relationship_prompt", base_cfg.get("relationship_prompt", ""), allow_empty=True),
    }


@router.get("/safety-prompt")
async def get_safety_prompt():
    from config import get_config_section
    prompt = get_config_section("safety_prompt", "")
    if isinstance(prompt, str) and prompt.strip():
        return {"prompt": prompt}
    return {"prompt": SAFETY_AUDIT_PROMPT}


@router.put("/safety-prompt")
async def update_safety_prompt(data: dict):
    from config import set_config_section
    prompt = str(data.get("prompt", "")).strip()
    if not prompt:
        set_config_section("safety_prompt", "")
        return {"ok": True, "message": "已重置为系统默认安全审核词"}
    set_config_section("safety_prompt", prompt)
    return {"ok": True, "message": "安全提示词已保存"}


@router.get("/world-prompt")
async def get_world_prompt():
    data = _load_prompt()
    return _prompt_payload(data, "World Prompt 已加载")


@router.put("/world-prompt")
async def update_world_prompt(settings: WorldPromptSettings):
    data = _load_prompt()
    current_cfg = _prompt_config_from_data(data)
    old_preset_key = data.get("preset_key", DEFAULT_PROMPT_PRESET_KEY)
    new_preset_key = _resolve_preset_or_404(settings.preset_key or DEFAULT_PROMPT_PRESET_KEY)
    preset_changed = new_preset_key != old_preset_key
    submitted = settings.model_fields_set
    selection_only = "preset_key" in submitted and submitted.issubset({"preset_key"})

    data["preset_key"] = new_preset_key
    if "story_background" in submitted:
        data["story_background"] = settings.story_background
    elif preset_changed or selection_only:
        data.pop("story_background", None)

    if "story_theme" in submitted:
        data["story_theme"] = settings.story_theme
    elif preset_changed or selection_only:
        data.pop("story_theme", None)

    if "user_prompt" in submitted:
        data["user_prompt"] = settings.user_prompt
    elif preset_changed or selection_only:
        data.pop("user_prompt", None)

    if "calendar_start" in submitted and settings.calendar_start:
        data["calendar_start"] = settings.calendar_start
    elif preset_changed or selection_only:
        data.pop("calendar_start", None)
    data["map_prompt"] = data.get("map_prompt") or current_cfg["map_prompt"]
    if "system_prompt" in submitted and settings.system_prompt:
        data["system_prompt"] = settings.system_prompt
    elif "system_prompt" in submitted:
        data.pop("system_prompt", None)

    if settings.character_overrides is not None:
        data["character_overrides"] = settings.character_overrides
    elif preset_changed or selection_only:
        # 切换预设时清除旧的顶层覆盖，让预设自带角色数据生效
        data.pop("character_overrides", None)
        data.pop("characters", None)

    if settings.characters is not None:
        data["characters"] = settings.characters
    elif preset_changed or selection_only:
        data.pop("characters", None)

    if "relationship_prompt" in submitted and settings.relationship_prompt is not None:
        data["relationship_prompt"] = settings.relationship_prompt
    elif preset_changed or selection_only:
        data.pop("relationship_prompt", None)

    _save_prompt(data)
    return _prompt_payload(data)


@router.get("/world-prompt/defaults")
async def get_default_world_prompt():
    cfg = _prompt_config_from_data({})
    return {
        "preset_key": DEFAULT_PROMPT_PRESET_KEY,
        "presets": prompt_presets_for_api(),
        "story_background": cfg["story_background"],
        "story_theme": cfg["story_theme"],
        "system_prompt": build_system_prompt_from_data({}),
        "safety_prompt": SAFETY_AUDIT_PROMPT,
        "user_prompt": DEFAULT_USER_PROMPT,
        "calendar_start": cfg["calendar_start"],
        "character_overrides": {},
        "characters": characters_for_preset(DEFAULT_PROMPT_PRESET_KEY),
        "relationship_prompt": "",
    }


@router.post("/world-prompt/preview")
async def preview_world_prompt(settings: WorldPromptSettings):
    """根据当前编辑内容实时预览 System Prompt（不保存）。
    未提供的字段从当前配置读取，确保预览与实际 run 时一致。"""
    base = _load_prompt()
    preset_key = settings.preset_key or base.get("preset_key", DEFAULT_PROMPT_PRESET_KEY)
    data = {
        "preset_key": preset_key,
        "story_background": settings.story_background if settings.story_background is not None else base.get("story_background"),
        "story_theme": settings.story_theme if settings.story_theme is not None else base.get("story_theme"),
        "user_prompt": settings.user_prompt if settings.user_prompt is not None else base.get("user_prompt"),
        "character_overrides": settings.character_overrides if settings.character_overrides is not None else base.get("character_overrides"),
        "characters": settings.characters if settings.characters is not None else base.get("characters"),
        "relationship_prompt": settings.relationship_prompt if settings.relationship_prompt is not None else base.get("relationship_prompt"),
    }
    return {
        "system_prompt": build_system_prompt_from_data(data),
        "preset_key": preset_key,
        "characters": data["characters"],
    }


# ---- 素材辅助 ----

def _load_imported_asset_folders() -> set[str]:
    folders: set[str] = set()
    if os.path.isfile(IMPORTED_ASSETS_FILE):
        try:
            with open(IMPORTED_ASSETS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            items = data.get("folders", data if isinstance(data, list) else [])
            if isinstance(items, list):
                folders.update(str(f).strip() for f in items if str(f).strip())
        except (OSError, json.JSONDecodeError):
            pass
    return folders


def _register_imported_asset(folder: str) -> None:
    folders = _load_imported_asset_folders()
    folders.add(folder)
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(IMPORTED_ASSETS_FILE, "w", encoding="utf-8") as f:
        json.dump({"folders": sorted(folders)}, f, ensure_ascii=False, indent=2)


def _rebuild_manifest() -> None:
    if not os.path.isdir(WEB_ASSETS_DIR):
        return
    images: list[str] = []
    animations: list[str] = []
    for root, _dirs, files in os.walk(WEB_ASSETS_DIR):
        for file in files:
            rel = os.path.relpath(os.path.join(root, file), WEB_ASSETS_DIR).replace("\\", "/")
            if file.endswith(".png"):
                images.append(rel)
            elif file.endswith("_animations.json") or file == "witch_animations.json":
                animations.append(rel)
    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "images": sorted(images),
        "animations": sorted(animations),
    }
    os.makedirs(os.path.dirname(MANIFEST_FILE), exist_ok=True)
    with open(MANIFEST_FILE, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)


def _dlc_asset_folders() -> set[str]:
    folders: set[str] = set()
    for preset_key in DEFAULT_PROMPT_PRESETS:
        if preset_key == DEFAULT_PROMPT_PRESET_KEY:
            continue
        for character in characters_for_preset(preset_key):
            folder = str(character.get("folderName") or "").strip()
            if folder:
                folders.add(folder)
    return folders


def _builtin_asset_folders() -> set[str]:
    return DEFAULT_ASSET_FOLDERS | _dlc_asset_folders()


def _is_user_imported_asset(folder: str) -> bool:
    return folder in _load_imported_asset_folders() and folder not in _builtin_asset_folders()


# ---- 世界编辑 导出 / 导入 (zip) ----

@router.get("/world-prompt/export")
async def export_world_prompt():
    """导出世界编辑全部数据为 zip：风格、Prompt、角色、用户导入素材。"""
    data = _load_prompt()
    cfg = _prompt_config_from_data(data)
    preset_key = cfg["preset_key"]
    characters = characters_for_preset(preset_key)
    imported_folders = _load_imported_asset_folders()

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        prompt_export = {
            "preset_key": preset_key,
            "story_background": cfg["story_background"],
            "story_theme": cfg["story_theme"],
            "user_prompt": cfg["user_prompt"],
            "calendar_start": cfg["calendar_start"],
            "custom_presets": data.get("custom_presets", {}),
        }
        zf.writestr("prompt.json", json.dumps(prompt_export, ensure_ascii=False, indent=2))
        zf.writestr("characters.json", json.dumps(characters, ensure_ascii=False, indent=2))

        asset_count = 0
        for character in characters:
            folder = str(character.get("folderName") or "").strip()
            if not folder or folder not in imported_folders:
                continue
            if not _is_user_imported_asset(folder):
                continue
            asset_dir = os.path.join(WEB_ASSETS_DIR, folder)
            if not os.path.isdir(asset_dir):
                continue
            for root, _dirs, files in os.walk(asset_dir):
                for file in files:
                    filepath = os.path.join(root, file)
                    arcname = os.path.join("assets", folder, os.path.relpath(filepath, asset_dir)).replace("\\", "/")
                    zf.write(filepath, arcname)
                    asset_count += 1
        logger.info("导出世界编辑 zip: preset=%s, characters=%d, assets=%d", preset_key, len(characters), asset_count)

    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=pixel_tavern_world_edit.zip"},
    )


@router.post("/world-prompt/import")
async def import_world_prompt(request: Request):
    """从 zip 导入世界编辑全部数据。素材文件夹重名时跳过素材但仍导入配置。"""
    try:
        form = await request.form()
    except Exception as exc:
        raise HTTPException(400, f"无法解析上传表单: {exc}") from exc

    upload = form.get("file")
    if upload is None or not hasattr(upload, "read"):
        raise HTTPException(400, "请上传 zip 文件")

    content = await upload.read()
    buf = io.BytesIO(content)

    conflicts: list[str] = []
    prompt_data: dict | None = None
    characters_data: list | None = None
    asset_folders_in_zip: set[str] = set()

    with zipfile.ZipFile(buf, "r") as zf:
        # 先扫描素材冲突
        for name in zf.namelist():
            parts = name.rstrip("/").split("/")
            if len(parts) >= 2 and parts[0] == "assets":
                folder = parts[1]
                if folder and folder not in asset_folders_in_zip:
                    asset_folders_in_zip.add(folder)
                    if os.path.exists(os.path.join(WEB_ASSETS_DIR, folder)):
                        conflicts.append(folder)

        if "prompt.json" in zf.namelist():
            prompt_data = json.loads(zf.read("prompt.json").decode("utf-8"))

        if "characters.json" in zf.namelist():
            characters_data = json.loads(zf.read("characters.json").decode("utf-8"))

        # 无冲突时才导入素材
        imported_count = 0
        if not conflicts:
            assets_root = os.path.abspath(WEB_ASSETS_DIR)
            for name in zf.namelist():
                if name.startswith("assets/") and not name.endswith("/"):
                    rel = name[len("assets/"):]
                    # 防御 zip-slip：拒绝含 ".." 的路径
                    if ".." in rel.split("/"):
                        logger.warning("导入跳过可疑路径: %s", name)
                        continue
                    target_path = os.path.abspath(os.path.join(WEB_ASSETS_DIR, rel))
                    if os.path.commonpath([assets_root, target_path]) != assets_root:
                        logger.warning("导入跳过越界路径: %s → %s", name, target_path)
                        continue
                    os.makedirs(os.path.dirname(target_path), exist_ok=True)
                    with open(target_path, "wb") as f:
                        f.write(zf.read(name))
                    imported_count += 1
            for folder in asset_folders_in_zip:
                _register_imported_asset(folder)
            logger.info("导入世界编辑素材: %d 文件, %d 文件夹", imported_count, len(asset_folders_in_zip))

    # 先导入 prompt 配置（不含 custom_presets，它会由角色导入步骤处理）
    preset_key = ""
    if prompt_data:
        current = _load_prompt()
        for key in ("preset_key", "story_background", "story_theme", "user_prompt", "calendar_start"):
            if key in prompt_data and prompt_data[key]:
                current[key] = prompt_data[key]
        preset_key = str(prompt_data.get("preset_key") or current.get("preset_key", DEFAULT_PROMPT_PRESET_KEY))
        current["preset_key"] = preset_key
        _save_prompt(current)

    # 再导入角色定义（写入 custom_presets，不会被 prompt 导入覆盖）
    if characters_data and preset_key:
        custom = _load_custom_presets()
        # 确保该预设存在于 custom_presets 中（否则 characters API 会拒绝编辑）
        if preset_key not in custom:
            custom[preset_key] = {
                "label": preset_key,
                "description": "导入的世界编辑风格",
                "story_background": prompt_data.get("story_background", "") if prompt_data else "",
                "story_theme": prompt_data.get("story_theme", "") if prompt_data else "",
                "characters": [],
            }
        custom[preset_key]["characters"] = [
            normalize_character_data(item, read_only=False)
            for item in characters_data
            if isinstance(item, dict)
        ]
        _save_custom_presets(custom)

    # 最后合并 prompt_data 中的 custom_presets（保留刚导入的角色）
    if prompt_data and prompt_data.get("custom_presets"):
        current = _load_prompt()
        merged = dict(prompt_data["custom_presets"])
        # 保留已导入的角色数据，不被旧的覆盖
        if preset_key and preset_key in merged and characters_data:
            merged[preset_key]["characters"] = [
                normalize_character_data(item, read_only=False)
                for item in characters_data
                if isinstance(item, dict)
            ]
        current["custom_presets"] = merged
        _save_prompt(current)

    _rebuild_manifest()

    if conflicts:
        return {
            "ok": True,
            "conflicts": conflicts,
            "message": f"素材文件夹重名: {', '.join(conflicts)}。已导入提示词和角色配置，素材未导入。",
        }

    return {"ok": True, "message": "世界编辑数据已完整导入，刷新页面后生效。"}


def _current_preset_key() -> str:
    from config import get_config_section
    key = str(get_config_section("preset_key") or DEFAULT_PROMPT_PRESET_KEY)
    return key if key in get_all_presets() else DEFAULT_PROMPT_PRESET_KEY


# ---- 自定义风格预设 ----

@router.post("/world-prompt/presets")
async def create_custom_preset(preset: dict):
    """保存自定义风格预设。body: {key, label, description, story_background, story_theme, character_overrides?, relationship_prompt?}"""
    key = str(preset.get("key", "")).strip()
    if not key or not key.replace("_", "").replace("-", "").isalnum():
        raise HTTPException(400, "预设 key 无效（仅允许字母、数字、下划线、连字符）")
    if key in DEFAULT_PROMPT_PRESETS:
        raise HTTPException(403, "不能覆盖内置风格预设")

    custom = _load_custom_presets()
    if key in custom:
        raise HTTPException(409, "同名自定义风格已存在，请换一个名称")

    base_key = str(preset.get("base_preset_key") or preset.get("preset_key") or _load_prompt().get("preset_key", DEFAULT_PROMPT_PRESET_KEY))
    custom[key] = _custom_preset_data(key, preset, base_key)
    _save_custom_presets(custom)

    # 自动切换到新风格
    data = _load_prompt()
    data["preset_key"] = key
    _clear_prompt_overrides(data)
    _save_prompt(data)

    return _prompt_payload(_load_prompt(), f"已保存自定义风格「{custom[key]['label']}」并自动切换")


@router.put("/world-prompt/presets/{key}")
async def update_custom_preset(key: str, preset: dict):
    """更新自定义风格预设。"""
    custom = _load_custom_presets()
    if key not in custom:
        raise HTTPException(404, "预设不存在")
    if key in DEFAULT_PROMPT_PRESETS:
        raise HTTPException(403, "不能覆盖内置风格预设")

    custom[key] = _custom_preset_data(key, preset, key, custom[key])
    _save_custom_presets(custom)

    data = _load_prompt()
    data["preset_key"] = key
    _clear_prompt_overrides(data)
    _save_prompt(data)
    return _prompt_payload(_load_prompt(), f"已更新自定义风格「{custom[key]['label']}」")


@router.put("/world-prompt/presets/{key}/rename")
async def rename_custom_preset(key: str, body: dict):
    """重命名自定义风格预设。body: {label: string}"""
    if key in DEFAULT_PROMPT_PRESETS:
        raise HTTPException(403, "不能重命名内置风格预设")
    custom = _load_custom_presets()
    if key not in custom:
        raise HTTPException(404, "预设不存在")

    new_label = str(body.get("label", "")).strip()
    if not new_label:
        raise HTTPException(400, "风格名称不能为空")
    if len(new_label) > 32:
        raise HTTPException(400, "风格名称不能超过32个字符")

    old_label = custom[key].get("label", key)
    custom[key]["label"] = new_label
    _save_custom_presets(custom)
    return _prompt_payload(_load_prompt(), f"已将「{old_label}」重命名为「{new_label}」")


@router.delete("/world-prompt/presets/{key}")
async def delete_custom_preset(key: str):
    """删除自定义风格预设。"""
    if key in DEFAULT_PROMPT_PRESETS:
        raise HTTPException(403, "不能删除内置风格预设")
    custom = _load_custom_presets()
    if key not in custom:
        raise HTTPException(404, "预设不存在")

    label = custom[key].get("label", key)
    del custom[key]
    _save_custom_presets(custom)

    # 如果当前使用的是被删除的风格，切换到第一个可用风格
    data = _load_prompt()
    if data.get("preset_key") == key:
        all_presets = prompt_presets_for_api()
        first_key = all_presets[0]["key"] if all_presets else DEFAULT_PROMPT_PRESET_KEY
        data["preset_key"] = first_key
        _clear_prompt_overrides(data)
        _save_prompt(data)

    return _prompt_payload(_load_prompt(), f"已删除自定义风格「{label}」")
