from __future__ import annotations

from collections import Counter
import json
import logging
import os
import re
import shutil
import zipfile
from datetime import datetime, timezone
from io import BytesIO
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from starlette.responses import FileResponse

from models.schemas import CharacterUpdate, CharacterCreate
from config import DATA_DIR
from services.prompt_builder import (
    DEFAULT_PROMPT_PRESET_KEY,
    DEFAULT_PROMPT_PRESETS,
    characters_for_preset,
    clone_characters_for_custom_preset,
    normalize_character_data,
    _load_custom_presets,
    _save_custom_presets,
    get_all_presets,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/characters", tags=["characters"])

APPS_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROJECT_ROOT = os.path.dirname(APPS_DIR)
WEB_ASSETS_DIR = os.path.join(APPS_DIR, "web", "public", "assets")
MANIFEST_FILE = os.path.join(WEB_ASSETS_DIR, "manifest.json")
ASSET_TEMPLATE_DIR = os.path.join(PROJECT_ROOT, "assets", "template")
ASSET_TEMPLATE_ZIP = os.path.join(DATA_DIR, "npc_asset_template.zip")

LEGACY_CHARS_FILE = os.path.join(DATA_DIR, "custom_characters.json")
IMPORTED_ASSETS_FILE = os.path.join(DATA_DIR, "imported_npc_assets.json")
LEGACY_PAGE_IMPORTED_FOLDERS = {"测试角色", "测试角色2", "测试角色3"}
DEFAULT_ASSET_FOLDERS = {"酒保", "勇士", "女巫", "诗人", "游侠", "神秘客"}
IMPORT_ACTIONS = [
    ("idle", "闲置"),
    ("walk_front", "前走"),
    ("walk_back", "后走"),
    ("walk_left", "左走"),
    ("walk_right", "右走"),
    ("sit", "坐下"),
    ("stand", "起立"),
    ("talk", "说话"),
    ("special", "特殊"),
]
IMPORT_FRAME_COUNT = 5
IMPORT_CANVAS_W = 150
IMPORT_CANVAS_H = 210
IMPORT_CANVAS_PADDING = 4
IMPORT_ALPHA_THRESHOLD = 16
IMPORT_BG_DISTANCE = 48


def _current_preset_key() -> str:
    from config import get_config_section
    key = str(get_config_section("preset_key") or DEFAULT_PROMPT_PRESET_KEY)
    return key if key in get_all_presets() else DEFAULT_PROMPT_PRESET_KEY


def _resolve_preset_key(preset_key: Optional[str]) -> str:
    key = str(preset_key or _current_preset_key())
    return key if key in get_all_presets() else DEFAULT_PROMPT_PRESET_KEY


def _asset_folders() -> list[str]:
    if not os.path.isdir(WEB_ASSETS_DIR):
        return []
    folders = []
    for name in os.listdir(WEB_ASSETS_DIR):
        full = os.path.join(WEB_ASSETS_DIR, name)
        if not os.path.isdir(full):
            continue
        anim_dir = os.path.join(full, "anim")
        if os.path.isfile(os.path.join(anim_dir, "animations.json")) or os.path.isfile(os.path.join(full, f"{name}_animations.json")):
            folders.append(name)
    return sorted(folders)


def _builtin_asset_folders() -> set[str]:
    return DEFAULT_ASSET_FOLDERS | _dlc_asset_folders()


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


def _asset_type(folder_name: str) -> tuple[str, str]:
    if _is_user_imported_asset(folder_name):
        return "imported", "用户导入"
    if folder_name in DEFAULT_ASSET_FOLDERS:
        return "default", "默认角色"
    if folder_name in _dlc_asset_folders():
        return "dlc", "DLC角色"
    return "system", "系统素材"


def _asset_sort_rank(asset_type: str) -> int:
    return {
        "imported": 0,
        "dlc": 1,
        "system": 2,
        "default": 3,
    }.get(asset_type, 2)


def _load_imported_asset_folders() -> set[str]:
    imported: set[str] = set()
    has_registry = os.path.isfile(IMPORTED_ASSETS_FILE)
    if has_registry:
        try:
            with open(IMPORTED_ASSETS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            folders = data.get("folders", data if isinstance(data, list) else [])
            if isinstance(folders, list):
                imported.update(str(folder).strip() for folder in folders if str(folder).strip())
        except (OSError, json.JSONDecodeError):
            logger.warning("读取用户导入素材登记失败: %s", IMPORTED_ASSETS_FILE)

    if not has_registry:
        imported.update(
            folder for folder in LEGACY_PAGE_IMPORTED_FOLDERS
            if os.path.isdir(os.path.join(WEB_ASSETS_DIR, folder))
        )

    return imported


def _save_imported_asset_folders(folders: set[str]) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(IMPORTED_ASSETS_FILE, "w", encoding="utf-8") as f:
        json.dump({"folders": sorted(folders)}, f, ensure_ascii=False, indent=2)


def _register_imported_asset(folder_name: str) -> None:
    folders = _load_imported_asset_folders()
    folders.add(folder_name)
    _save_imported_asset_folders(folders)


def _unregister_imported_asset(folder_name: str) -> None:
    folders = _load_imported_asset_folders()
    folders.discard(folder_name)
    _save_imported_asset_folders(folders)


def _is_user_imported_asset(folder_name: str) -> bool:
    return folder_name in _load_imported_asset_folders() and folder_name not in _builtin_asset_folders()


def _resolve_asset_folder_or_404(folder_name: str) -> tuple[str, str]:
    raw = str(folder_name or "").strip()
    folder = _sanitize_folder_name(raw)
    if not folder or folder != raw:
        raise HTTPException(400, "素材名称无效")
    target = os.path.abspath(os.path.join(WEB_ASSETS_DIR, folder))
    root = os.path.abspath(WEB_ASSETS_DIR)
    if os.path.commonpath([root, target]) != root:
        raise HTTPException(400, "素材路径无效")
    if not os.path.isdir(target):
        raise HTTPException(404, "素材不存在")
    return folder, target


def _character_asset_usages(folder_name: str) -> list[str]:
    usages: list[str] = []
    for preset_key, preset in _load_custom_presets().items():
        characters = preset.get("characters")
        if not isinstance(characters, list):
            continue
        label = str(preset.get("label") or preset_key)
        for character in characters:
            if not isinstance(character, dict):
                continue
            if character.get("folderName") == folder_name:
                usages.append(f"{label}/{character.get('name') or character.get('key') or folder_name}")
    return usages


def _ensure_editable_preset(preset_key: str) -> tuple[str, dict, dict]:
    key = _resolve_preset_key(preset_key)
    if key in DEFAULT_PROMPT_PRESETS:
        raise HTTPException(403, "系统内置风格的角色不可编辑，请先在提示词页另存为自定义风格")
    custom = _load_custom_presets()
    if key not in custom:
        raise HTTPException(404, "自定义风格不存在")
    if not isinstance(custom[key].get("characters"), list) or not custom[key]["characters"]:
        custom[key]["characters"] = clone_characters_for_custom_preset(key)
    return key, custom, custom[key]


def _save_custom_character_roster(custom: dict, preset_key: str, characters: list[dict]) -> None:
    custom[preset_key]["characters"] = [normalize_character_data(item, read_only=False) for item in characters]
    _save_custom_presets(custom)


def _validate_asset_folder(folder_name: str) -> None:
    if folder_name not in _asset_folders():
        raise HTTPException(400, f"folderName 必须是已存在的 NPC 素材之一: {_asset_folders()}")


@router.get("")
async def list_characters(preset_key: Optional[str] = Query(default=None)):
    """返回当前风格绑定的角色阵容。内置风格只读，自定义风格可编辑。"""
    key = _resolve_preset_key(preset_key)
    is_builtin = key in DEFAULT_PROMPT_PRESETS
    return {
        "preset_key": key,
        "is_builtin": is_builtin,
        "characters": characters_for_preset(key),
        "assets": list_assets()["assets"],
    }


@router.get("/assets")
def list_assets():
    """列出所有可用于 NPC 的人物素材。"""
    assets = []
    for folder in _asset_folders():
        imported = _is_user_imported_asset(folder)
        asset_type, asset_label = _asset_type(folder)
        idle_preview = f"{folder}/anim/{folder}_idle_0.png"
        static_preview = f"{folder}/{folder}_001.png"
        preview_rel = idle_preview if os.path.isfile(os.path.join(WEB_ASSETS_DIR, idle_preview)) else static_preview
        frame_count = 0
        anim_dir = os.path.join(WEB_ASSETS_DIR, folder, "anim")
        if os.path.isdir(anim_dir):
            frame_count = len([name for name in os.listdir(anim_dir) if name.endswith(".png")])
        assets.append({
            "folderName": folder,
            "label": folder,
            "preview": f"/assets/{preview_rel.replace(os.sep, '/')}",
            "frameCount": frame_count,
            "imported": imported,
            "assetType": asset_type,
            "assetLabel": asset_label,
        })
    assets.sort(key=lambda item: (_asset_sort_rank(str(item["assetType"])), item["label"]))
    return {"assets": assets, "requiredActions": [{"key": key, "label": label} for key, label in IMPORT_ACTIONS]}


@router.get("/assets/template")
def download_asset_template():
    """下载 NPC 动作素材模板。"""
    if not os.path.isdir(ASSET_TEMPLATE_DIR):
        raise HTTPException(404, "素材模板目录不存在")

    os.makedirs(DATA_DIR, exist_ok=True)
    with zipfile.ZipFile(ASSET_TEMPLATE_ZIP, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name in sorted(os.listdir(ASSET_TEMPLATE_DIR)):
            path = os.path.join(ASSET_TEMPLATE_DIR, name)
            if os.path.isfile(path):
                zf.write(path, arcname=name)

    return FileResponse(
        ASSET_TEMPLATE_ZIP,
        media_type="application/zip",
        filename="pixel_tavern_npc_asset_template.zip",
    )


@router.post("/assets/import")
async def import_asset(request: Request):
    """导入 9 张横向 5 帧动作图，裁剪后生成 NPC 动画素材。"""
    try:
        from PIL import Image
    except ImportError as exc:
        raise HTTPException(500, "缺少 Pillow，请先安装 requirements.txt 中的 pillow") from exc

    try:
        form = await request.form()
    except AssertionError as exc:
        if "multipart" in str(exc).lower():
            logger.exception("解析 NPC 素材上传表单失败：缺少 python-multipart")
            raise HTTPException(
                500,
                "后端缺少 python-multipart，请在当前 Python 环境安装 apps/api/requirements.txt 后重启后端",
            ) from exc
        raise
    except Exception as exc:
        logger.exception("解析 NPC 素材上传表单失败")
        raise HTTPException(400, f"无法解析上传表单: {exc}") from exc

    raw_folder = str(form.get("folderName") or "").strip()
    folder = _sanitize_folder_name(raw_folder)
    if not folder:
        raise HTTPException(400, "素材名称不能为空")
    if folder in _asset_folders() or os.path.exists(os.path.join(WEB_ASSETS_DIR, folder)):
        raise HTTPException(400, "同名 NPC 素材已存在，请换一个名称")

    files = {}
    for action, label in IMPORT_ACTIONS:
        upload = form.get(action)
        if upload is None or not hasattr(upload, "read"):
            raise HTTPException(400, f"缺少动作图: {label} ({action})")
        files[action] = upload

    folder_dir = os.path.join(WEB_ASSETS_DIR, folder)
    anim_dir = os.path.join(folder_dir, "anim")
    os.makedirs(anim_dir, exist_ok=True)

    animations = {}
    saved_images: list[str] = []
    first_frames: dict[str, Image.Image] = {}
    try:
        frames_by_action = {}
        for action, _label in IMPORT_ACTIONS:
            content = await files[action].read()
            source = Image.open(BytesIO(content)).convert("RGBA")
            frames_by_action[action] = [
                _clean_import_frame(_normalize_import_source_frame(frame))
                for frame in _split_action_frames(source, frame_count=IMPORT_FRAME_COUNT)
            ]

        prepared_frames = _stabilize_import_frames(frames_by_action)

        for action, _label in IMPORT_ACTIONS:
            frames = prepared_frames[action]
            frame_files = []
            for idx, frame in enumerate(frames):
                filename = f"{folder}_{action}_{idx}.png"
                frame.save(os.path.join(anim_dir, filename), optimize=True)
                frame_files.append(filename)
                saved_images.append(f"{folder}/anim/{filename}")
                if idx == 0:
                    first_frames[action] = frame.copy()
            animations[action] = {
                "frames": frame_files,
                "frameRate": 12,
                "repeat": -1 if action in {"idle", "walk_front", "walk_back", "walk_left", "walk_right", "sit"} else 0,
            }

        static_sources = {
            "001": "walk_front",
            "002": "walk_back",
            "003": "walk_left",
            "004": "walk_right",
        }
        for suffix, action in static_sources.items():
            filename = f"{folder}_{suffix}.png"
            first_frames[action].save(os.path.join(folder_dir, filename), optimize=True)
            saved_images.append(f"{folder}/{filename}")

        anim_config = {"npc_key": folder, "animations": animations}
        for path in (
            os.path.join(anim_dir, "animations.json"),
            os.path.join(folder_dir, f"{folder}_animations.json"),
        ):
            with open(path, "w", encoding="utf-8") as f:
                json.dump(anim_config, f, ensure_ascii=False, indent=2)

        _update_manifest(saved_images)
        _register_imported_asset(folder)
        logger.info("导入 NPC 素材: %s", folder)
        return {"ok": True, "folderName": folder, "message": "NPC 素材已导入，刷新页面后即可在角色创建中使用"}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, f"素材处理失败: {exc}") from exc


@router.post("/assets/reprocess-imported")
def reprocess_imported_assets():
    """使用当前导入清理算法重处理全部用户导入素材。"""
    processed: list[str] = []
    skipped: list[str] = []
    for folder in _asset_folders():
        if not _is_user_imported_asset(folder):
            continue
        try:
            _reprocess_existing_asset_folder(folder)
            processed.append(folder)
        except Exception as exc:
            logger.exception("重处理 NPC 素材失败: %s", folder)
            skipped.append(f"{folder}: {exc}")
    return {"ok": True, "processed": processed, "skipped": skipped}


@router.post("/assets/{folder_name}/reprocess")
def reprocess_asset(folder_name: str):
    folder, _target = _resolve_asset_folder_or_404(folder_name)
    if not _is_user_imported_asset(folder):
        raise HTTPException(403, "系统内置素材不可重处理")
    _reprocess_existing_asset_folder(folder)
    return {"ok": True, "folderName": folder, "message": "素材已使用当前算法重新处理"}


@router.delete("/assets")
def delete_asset(folderName: str = Query(..., min_length=1)):
    return _delete_asset(folderName)


@router.delete("/assets/{folder_name}")
def delete_asset_by_path(folder_name: str):
    return _delete_asset(folder_name)


def _delete_asset(folder_name: str):
    folder, target = _resolve_asset_folder_or_404(folder_name)
    if not _is_user_imported_asset(folder):
        raise HTTPException(403, "系统内置素材不可删除")

    shutil.rmtree(target)
    _remove_asset_from_manifest(folder)
    _unregister_imported_asset(folder)
    logger.info("删除用户导入 NPC 素材: %s", folder)
    return {"ok": True, "folderName": folder, "message": f"已删除素材「{folder}」"}


@router.put("/{key}")
async def update_character(key: str, req: CharacterUpdate, preset_key: Optional[str] = Query(default=None)):
    preset, custom, preset_data = _ensure_editable_preset(preset_key or "")
    characters = characters_for_preset(preset, read_only=False)
    idx = next((i for i, item in enumerate(characters) if item["key"] == key), -1)
    if idx < 0:
        raise HTTPException(404, "角色不存在")

    updates = req.model_dump(exclude_none=True)
    if "folderName" in updates:
        _validate_asset_folder(str(updates["folderName"]))
    characters[idx].update(updates)
    characters[idx] = normalize_character_data(characters[idx], key, read_only=False)
    _save_custom_character_roster(custom, preset, characters)
    return {"ok": True, "character": characters[idx]}


@router.post("")
async def create_character(req: CharacterCreate, preset_key: Optional[str] = Query(default=None)):
    preset, custom, preset_data = _ensure_editable_preset(preset_key or "")
    _validate_asset_folder(req.folderName)
    characters = characters_for_preset(preset, read_only=False)
    if any(item["key"] == req.key for item in characters):
        raise HTTPException(400, f"角色 key '{req.key}' 已存在")
    data = normalize_character_data(req.model_dump(), req.key, read_only=False)
    characters.append(data)
    _save_custom_character_roster(custom, preset, characters)
    logger.info("创建风格角色: %s/%s (%s)", preset, req.key, req.name)
    return {"ok": True, "character": data}


@router.delete("/{key}")
async def delete_character(key: str, preset_key: Optional[str] = Query(default=None)):
    preset, custom, preset_data = _ensure_editable_preset(preset_key or "")
    characters = characters_for_preset(preset, read_only=False)
    next_chars = [item for item in characters if item["key"] != key]
    if len(next_chars) == len(characters):
        raise HTTPException(404, "角色不存在")
    _save_custom_character_roster(custom, preset, next_chars)
    return {"ok": True}


def _sanitize_folder_name(value: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", value).strip(" ._")
    return cleaned[:32]


def _split_action_frames(image, frame_count: int):
    if image.width < frame_count:
        raise ValueError("动作图宽度不足，需为横向 5 帧图")
    return [
        image.crop((
            round(image.width * i / frame_count),
            0,
            round(image.width * (i + 1) / frame_count),
            image.height,
        ))
        for i in range(frame_count)
    ]


def _normalize_import_source_frame(frame):
    """Scale each source cell to the final import canvas before pixel cleanup.

    Imported sheets can be very large. Doing flood-fill and component analysis on
    the final 150x210 canvas keeps uploads responsive while preserving the same
    bottom-center runtime anchor used by NPC sprites.
    """
    from PIL import Image

    frame = frame.convert("RGBA")
    scale = min(IMPORT_CANVAS_W / frame.width, IMPORT_CANVAS_H / frame.height)
    target_w = max(1, round(frame.width * scale))
    target_h = max(1, round(frame.height * scale))
    resized = frame.resize((target_w, target_h), _resample_filter())
    canvas = Image.new("RGBA", (IMPORT_CANVAS_W, IMPORT_CANVAS_H), (0, 0, 0, 0))
    x = max(0, (IMPORT_CANVAS_W - target_w) // 2)
    y = max(0, IMPORT_CANVAS_H - target_h)
    canvas.alpha_composite(resized, dest=(x, y))
    return canvas


def _alpha_bbox(frame):
    return frame.getchannel("A").getbbox()


def _detect_edge_background(image) -> tuple[int, int, int] | None:
    rgba = image.convert("RGBA")
    pixels = rgba.load()
    width, height = rgba.size
    border = max(1, min(4, width // 12, height // 12))
    buckets: Counter[tuple[int, int, int]] = Counter()
    sums: dict[tuple[int, int, int], list[int]] = {}

    def add_pixel(x: int, y: int) -> None:
        r, g, b, a = pixels[x, y]
        if a < IMPORT_ALPHA_THRESHOLD:
            return
        key = (r // 16, g // 16, b // 16)
        buckets[key] += 1
        sums.setdefault(key, [0, 0, 0, 0])
        sums[key][0] += r
        sums[key][1] += g
        sums[key][2] += b
        sums[key][3] += 1

    for y in range(height):
        for x in range(border):
            add_pixel(x, y)
            add_pixel(width - 1 - x, y)
    for y in range(border):
        for x in range(width):
            add_pixel(x, y)
            add_pixel(x, height - 1 - y)

    if not buckets:
        return None
    key, _count = buckets.most_common(1)[0]
    total = sums[key][3]
    if total <= 0:
        return None
    return (
        round(sums[key][0] / total),
        round(sums[key][1] / total),
        round(sums[key][2] / total),
    )


def _rgb_distance_sq(rgb: tuple[int, int, int], bg: tuple[int, int, int]) -> int:
    return sum((rgb[i] - bg[i]) ** 2 for i in range(3))


def _is_green_screen(r: int, g: int, b: int) -> bool:
    max_rb = max(r, b)
    return (
        (g > 185 and r < 145 and b < 145 and g - max_rb > 52)
        or (g > 145 and r < 90 and b < 90 and g - max_rb > 68)
    )


def _is_neutral_light_background(r: int, g: int, b: int) -> bool:
    max_rgb = max(r, g, b)
    min_rgb = min(r, g, b)
    avg = (r + g + b) / 3
    return (avg > 238 and max_rgb - min_rgb < 58) or (avg > 226 and max_rgb - min_rgb < 30)


def _is_background_like(r: int, g: int, b: int, a: int, bg: tuple[int, int, int] | None) -> bool:
    if a < IMPORT_ALPHA_THRESHOLD:
        return True
    if _is_green_screen(r, g, b) or _is_neutral_light_background(r, g, b):
        return True
    if bg is None:
        return False
    max_bg = max(bg)
    min_bg = min(bg)
    distance = IMPORT_BG_DISTANCE + (12 if max_bg > 220 and max_bg - min_bg < 48 else 0)
    return _rgb_distance_sq((r, g, b), bg) <= distance * distance


def _clean_import_frame(frame):
    """Remove border-connected background and tiny speckles while preserving opaque pixel-art edges."""
    rgba = frame.convert("RGBA")
    bg = _detect_edge_background(rgba)
    pixels = rgba.load()
    width, height = rgba.size
    visited = bytearray(width * height)
    q: deque[tuple[int, int]] = deque()

    def try_add(x: int, y: int) -> None:
        idx = y * width + x
        if visited[idx]:
            return
        r, g, b, a = pixels[x, y]
        if not _is_background_like(r, g, b, a, bg):
            return
        visited[idx] = 1
        q.append((x, y))

    for x in range(width):
        try_add(x, 0)
        try_add(x, height - 1)
    for y in range(height):
        try_add(0, y)
        try_add(width - 1, y)

    while q:
        x, y = q.popleft()
        for nx in (x - 1, x, x + 1):
            for ny in (y - 1, y, y + 1):
                if nx == x and ny == y:
                    continue
                if nx < 0 or ny < 0 or nx >= width or ny >= height:
                    continue
                try_add(nx, ny)

    for y in range(height):
        for x in range(width):
            idx = y * width + x
            r, g, b, a = pixels[x, y]
            if visited[idx] or a < IMPORT_ALPHA_THRESHOLD:
                pixels[x, y] = (r, g, b, 0)

    _remove_strict_edge_fringe(rgba, bg)
    _remove_small_alpha_components(rgba)
    return rgba


def _remove_strict_edge_fringe(image, bg: tuple[int, int, int] | None) -> None:
    if bg is None:
        return
    pixels = image.load()
    width, height = image.size
    to_clear: list[tuple[int, int]] = []

    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a < IMPORT_ALPHA_THRESHOLD:
                continue
            if _rgb_distance_sq((r, g, b), bg) > 24 * 24 and not _is_green_screen(r, g, b):
                continue
            has_transparent_neighbor = False
            for nx in (x - 1, x, x + 1):
                for ny in (y - 1, y, y + 1):
                    if nx < 0 or ny < 0 or nx >= width or ny >= height or (nx == x and ny == y):
                        continue
                    if pixels[nx, ny][3] < IMPORT_ALPHA_THRESHOLD:
                        has_transparent_neighbor = True
                        break
                if has_transparent_neighbor:
                    break
            if has_transparent_neighbor:
                to_clear.append((x, y))

    for x, y in to_clear:
        r, g, b, _a = pixels[x, y]
        pixels[x, y] = (r, g, b, 0)


def _remove_small_alpha_components(image) -> None:
    pixels = image.load()
    width, height = image.size
    visited = bytearray(width * height)
    components: list[list[tuple[int, int]]] = []

    for sy in range(height):
        for sx in range(width):
            start = sy * width + sx
            if visited[start] or pixels[sx, sy][3] < IMPORT_ALPHA_THRESHOLD:
                continue

            visited[start] = 1
            q: deque[tuple[int, int]] = deque([(sx, sy)])
            points: list[tuple[int, int]] = []
            while q:
                x, y = q.popleft()
                points.append((x, y))
                for nx in (x - 1, x, x + 1):
                    for ny in (y - 1, y, y + 1):
                        if nx < 0 or ny < 0 or nx >= width or ny >= height or (nx == x and ny == y):
                            continue
                        idx = ny * width + nx
                        if visited[idx] or pixels[nx, ny][3] < IMPORT_ALPHA_THRESHOLD:
                            continue
                        visited[idx] = 1
                        q.append((nx, ny))
            components.append(points)

    if not components:
        return
    largest = max(len(component) for component in components)
    min_area = max(8, min(48, largest // 250))
    for component in components:
        if len(component) >= min_area:
            continue
        for x, y in component:
            r, g, b, _a = pixels[x, y]
            pixels[x, y] = (r, g, b, 0)


def _resample_filter():
    from PIL import Image

    return Image.Resampling.LANCZOS if hasattr(Image, "Resampling") else Image.LANCZOS


def _snap_alpha(image) -> None:
    pixels = image.load()
    width, height = image.size
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a < 24:
                pixels[x, y] = (r, g, b, 0)
            elif a > 244:
                pixels[x, y] = (r, g, b, 255)


def _stabilize_import_frames(frames_by_action: dict[str, list]):
    """Crop each frame to its own alpha bbox, then place every frame in a shared-size
    intermediate canvas (bottom-centre aligned) before scaling to the final import
    canvas.  Using per-frame bboxes avoids drift that a union bbox would introduce
    when different source sheets position the character differently within the
    frame — the intermediate canvas of constant dimensions guarantees that every
    frame ends up at the same scale and the same bottom-centre anchor."""
    from PIL import Image

    all_frames = [frame for frames in frames_by_action.values() for frame in frames]
    boxes = [box for frame in all_frames if (box := _alpha_bbox(frame)) is not None]
    if not boxes:
        raise ValueError("所有动作图都没有可识别的人物前景")

    max_content_w = max(box[2] - box[0] for box in boxes)
    max_content_h = max(box[3] - box[1] for box in boxes)

    inter_w = max_content_w + IMPORT_CANVAS_PADDING * 2
    inter_h = max_content_h + IMPORT_CANVAS_PADDING * 2

    scale = min(
        (IMPORT_CANVAS_W - IMPORT_CANVAS_PADDING * 2) / inter_w,
        (IMPORT_CANVAS_H - IMPORT_CANVAS_PADDING * 2) / inter_h,
        1.0,
    )

    result = {}
    for action, frames in frames_by_action.items():
        stable_frames = []
        for frame in frames:
            box = _alpha_bbox(frame)
            if box is None:
                stable_frames.append(Image.new("RGBA", (IMPORT_CANVAS_W, IMPORT_CANVAS_H), (0, 0, 0, 0)))
                continue

            content = frame.crop(box)
            inter = Image.new("RGBA", (inter_w, inter_h), (0, 0, 0, 0))
            cx = max(0, (inter_w - content.width) // 2)
            cy = max(0, inter_h - IMPORT_CANVAS_PADDING - content.height)
            inter.alpha_composite(content, dest=(cx, cy))

            _snap_alpha(inter)
            stable_frames.append(_place_resized_crop_on_canvas(inter, scale))
        result[action] = stable_frames
    return result


def _place_resized_crop_on_canvas(crop, scale: float):
    from PIL import Image

    scale = max(0.01, scale)
    target_w = max(1, round(crop.width * scale))
    target_h = max(1, round(crop.height * scale))
    resized = crop.resize((target_w, target_h), _resample_filter())
    _snap_alpha(resized)

    canvas = Image.new("RGBA", (IMPORT_CANVAS_W, IMPORT_CANVAS_H), (0, 0, 0, 0))
    x = max(0, (IMPORT_CANVAS_W - target_w) // 2)
    y = max(0, IMPORT_CANVAS_H - IMPORT_CANVAS_PADDING - target_h)
    canvas.alpha_composite(resized, dest=(x, y))
    return canvas


def _reprocess_existing_asset_folder(folder: str) -> None:
    from PIL import Image

    folder_dir = os.path.join(WEB_ASSETS_DIR, folder)
    anim_dir = os.path.join(folder_dir, "anim")
    if not os.path.isdir(anim_dir):
        raise ValueError("缺少 anim 目录")

    frames_by_action = {}
    for action, _label in IMPORT_ACTIONS:
        frames = []
        for idx in range(IMPORT_FRAME_COUNT):
            path = os.path.join(anim_dir, f"{folder}_{action}_{idx}.png")
            if not os.path.isfile(path):
                raise ValueError(f"缺少帧文件: {folder}_{action}_{idx}.png")
            frames.append(_clean_import_frame(Image.open(path).convert("RGBA")))
        frames_by_action[action] = frames

    prepared_frames = _stabilize_import_frames(frames_by_action)
    for action, _label in IMPORT_ACTIONS:
        for idx, frame in enumerate(prepared_frames[action]):
            frame.save(os.path.join(anim_dir, f"{folder}_{action}_{idx}.png"), optimize=True)

    static_sources = {
        "001": "walk_front",
        "002": "walk_back",
        "003": "walk_left",
        "004": "walk_right",
    }
    for suffix, action in static_sources.items():
        prepared_frames[action][0].save(os.path.join(folder_dir, f"{folder}_{suffix}.png"), optimize=True)


def _crop_frames_union(frames: list):
    cleaned = [_white_to_alpha(frame) for frame in frames]
    boxes = [frame.getchannel("A").getbbox() for frame in cleaned]
    boxes = [box for box in boxes if box]
    if not boxes:
        return cleaned
    left = max(0, min(box[0] for box in boxes) - 2)
    top = max(0, min(box[1] for box in boxes) - 2)
    right = min(cleaned[0].width, max(box[2] for box in boxes) + 2)
    bottom = min(cleaned[0].height, max(box[3] for box in boxes) + 2)
    return [frame.crop((left, top, right, bottom)) for frame in cleaned]


def _white_to_alpha(image):
    image = image.convert("RGBA")
    pixels = []
    for r, g, b, a in image.getdata():
        if a == 0 or (r >= 245 and g >= 245 and b >= 245):
            pixels.append((r, g, b, 0))
        else:
            pixels.append((r, g, b, a))
    image.putdata(pixels)
    return image


def _update_manifest(new_images: list[str]) -> None:
    try:
        with open(MANIFEST_FILE, "r", encoding="utf-8") as f:
            manifest = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        manifest = {"images": []}
    images = set(str(item).replace("\\", "/") for item in manifest.get("images", []))
    images.update(path.replace("\\", "/") for path in new_images)
    animations = set(str(item).replace("\\", "/") for item in manifest.get("animations", []))
    for path in new_images:
        folder = path.split("/", 1)[0]
        if folder:
            animations.add(f"{folder}/{folder}_animations.json")
    manifest["generatedAt"] = datetime.now(timezone.utc).isoformat()
    manifest["images"] = sorted(images)
    manifest["animations"] = sorted(animations)
    os.makedirs(os.path.dirname(MANIFEST_FILE), exist_ok=True)
    with open(MANIFEST_FILE, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)


def _remove_asset_from_manifest(folder: str) -> None:
    try:
        with open(MANIFEST_FILE, "r", encoding="utf-8") as f:
            manifest = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return

    prefix = f"{folder}/"
    manifest["images"] = [
        path for path in manifest.get("images", [])
        if not str(path).replace("\\", "/").startswith(prefix)
    ]
    manifest["animations"] = [
        path for path in manifest.get("animations", [])
        if not str(path).replace("\\", "/").startswith(prefix)
    ]
    manifest["generatedAt"] = datetime.now(timezone.utc).isoformat()
    with open(MANIFEST_FILE, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
