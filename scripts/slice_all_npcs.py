"""将所有 NPC 精灵表（横向 5 帧）切分为稳定动画帧，生成动画配置。

设计目标：
1. 同一 NPC 的所有动画帧输出为统一画布尺寸；
2. 每帧内容按“底部居中”放入统一画布，匹配前端 NPC 的 origin(0.5, 1)；
3. 消除因逐帧透明边界变化引起的动画左右/上下闪烁。

用法: python scripts/slice_all_npcs.py
说明: 此文件的变更会触发仓库中的一次性素材重切工作流。
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("需要 Pillow: pip install Pillow")
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
OUTPUT = ROOT / "output"
WEB_ASSETS = ROOT / "apps" / "web" / "public" / "assets"
MANIFEST_PATH = WEB_ASSETS / "manifest.json"

FRAMES = 5
SCALE = 0.35
WHITE_THRESHOLD = 230
CANVAS_PADDING = 4

# 资产目录名 -> (文件前缀, web 目录名)
NPC_MAP = {
    # 6 个默认角色
    "勇士": ("勇士", "勇士"),
    "酒保": ("酒保", "酒保"),
    "诗人": ("诗人", "诗人"),
    "游侠": ("游侠", "游侠"),
    "神秘人": ("神秘客", "神秘客"),
    "女巫": ("女巫", "女巫"),
    # 24 个风格角色
    "任务狂战士": ("任务狂战士", "任务狂战士"),
    "佣兵酒保": ("佣兵酒保", "佣兵酒保"),
    "债务决斗家": ("债务决斗家", "债务决斗家"),
    "假面信使": ("假面信使", "假面信使"),
    "吵闹游吟者": ("吵闹游吟者", "吵闹游吟者"),
    "宫廷占星师": ("宫廷占星师", "宫廷占星师"),
    "宫廷护卫": ("宫廷护卫", "宫廷护卫"),
    "宫廷老管家": ("宫廷老管家", "宫廷老管家"),
    "广播说书人": ("广播说书人", "广播说书人"),
    "废土遗物商": ("废土遗物商", "废土遗物商"),
    "旧案调查员": ("旧案调查员", "旧案调查员"),
    "民俗学者": ("民俗学者", "民俗学者"),
    "沙路侦察兵": ("沙路侦察兵", "沙路侦察兵"),
    "流亡情报官": ("流亡情报官", "流亡情报官"),
    "炼金药师": ("炼金药师", "炼金药师"),
    "码头护卫": ("码头护卫", "码头护卫"),
    "码头歌者": ("码头歌者", "码头歌者"),
    "老佣兵顾问": ("老佣兵顾问", "老佣兵顾问"),
    "荒原机修师": ("荒原机修师", "荒原机修师"),
    "装甲酒车主": ("装甲酒车主", "装甲酒车主"),
    "走私向导": ("走私向导", "走私向导"),
    "车队护卫": ("车队护卫", "车队护卫"),
    "雾港巡夜人": ("雾港巡夜人", "雾港巡夜人"),
    "雾港酒保": ("雾港酒保", "雾港酒保"),
}

ACTION_NAMES = {
    "idel": "idle",
    "idle": "idle",
    "forward": "walk_front",
    "backward": "walk_back",
    "left": "walk_left",
    "right": "walk_right",
    "sit": "sit",
    "stand": "stand",
    "talk": "talk",
    "sneeze": "special",
}

LOOPING_ACTIONS = {
    "idle",
    "sit",
    "walk_front",
    "walk_back",
    "walk_left",
    "walk_right",
}

# 质心对齐：修正素材中角色水平位置逐帧漂移的问题。
# 对所有角色所有动作都启用；如果素材本身角色居中且稳定，对齐操作几乎无变化。
CENTROID_ALIGN_ENABLED = True


def remove_bg(img: Image.Image) -> Image.Image:
    """将近似白色像素变为透明。"""
    img = img.convert("RGBA")
    pixels = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            if a > 0 and r > WHITE_THRESHOLD and g > WHITE_THRESHOLD and b > WHITE_THRESHOLD:
                pixels[x, y] = (r, g, b, 0)
    return img


def process_sheet(filepath: Path, frames: int = FRAMES) -> list[Image.Image]:
    """处理一张横向精灵表：切帧（余数均匀分布） -> 去白底。"""
    img = Image.open(filepath)
    w, h = img.size
    fw = w // frames
    if fw <= 0:
        raise ValueError(f"非法精灵表宽度: {filepath}")

    remainder = w - fw * frames
    result: list[Image.Image] = []
    # 将余数像素从中间帧向两侧分配，避免只有末尾帧偏宽
    order = sorted(range(frames), key=lambda i: abs(i - (frames - 1) / 2))
    extra = [0] * frames
    for idx in range(remainder):
        extra[order[idx % frames]] += 1

    x = 0
    for i in range(frames):
        fw_i = fw + extra[i]
        frame = img.crop((x, 0, x + fw_i, h))
        result.append(remove_bg(frame))
        x += fw_i
    return result


def collect_frames(src_dir: Path) -> dict[str, list[Image.Image]]:
    all_frames: dict[str, list[Image.Image]] = {}
    for file in sorted(src_dir.glob("*.png")):
        action = ACTION_NAMES.get(file.stem)
        if action is None:
            continue
        all_frames[action] = process_sheet(file)
    return all_frames


def cropped_content(frame: Image.Image) -> Image.Image | None:
    bbox = frame.getbbox()
    if bbox is None:
        return None
    return frame.crop(bbox)


def global_canvas_size(all_frames: dict[str, list[Image.Image]]) -> tuple[int, int]:
    max_w = 1
    max_h = 1
    for frames in all_frames.values():
        for frame in frames:
            content = cropped_content(frame)
            if content is None:
                continue
            max_w = max(max_w, content.width)
            max_h = max(max_h, content.height)
    return max_w + CANVAS_PADDING * 2, max_h + CANVAS_PADDING * 2


def stabilize_frames_uniform(frames: list[Image.Image], canvas_w: int, canvas_h: int) -> list[Image.Image]:
    """用该动作全部帧的并集 bbox 统一裁切，以中位数底部对齐到 canvas 底边。

    并集 bbox 保证所有帧宽度和裁切区域一致 → 同动作内所有帧使用同一个 y_dst，
    避免逐帧对齐带来的垂直跳动。底部锚点取中位数而非最大值，防止单帧异常
    像素（如额外阴影）拉偏整个动作的高度；溢出帧最多底部被裁掉几个像素。"""
    boxes = [frame.getbbox() for frame in frames]
    valid = [b for b in boxes if b is not None]
    if not valid:
        return [Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0)) for _ in frames]

    union_left = min(b[0] for b in valid)
    union_top = min(b[1] for b in valid)
    union_right = max(b[2] for b in valid)
    union_bottom = max(b[3] for b in valid)
    union = (union_left, union_top, union_right, union_bottom)

    # 中位数内容底边：代表"真正的脚/底部"，不被单帧异常像素拉偏
    content_bottoms = sorted(b[3] - union_top for b in valid)
    median_bottom = content_bottoms[len(content_bottoms) // 2]
    y_dst = max(0, canvas_h - CANVAS_PADDING - median_bottom)

    result = []
    for i, frame in enumerate(frames):
        canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
        if boxes[i] is None:
            result.append(canvas)
            continue

        content = frame.crop(union)
        x = max(0, (canvas_w - content.width) // 2)
        canvas.alpha_composite(content, dest=(x, y_dst))
        result.append(canvas)
    return result


def alpha_centroid_x(frame: Image.Image) -> float | None:
    """返回 alpha 加权水平重心。垂直方向由底部对齐保证，这里只修水平漂移。"""
    rgba = frame.convert("RGBA")
    pixels = rgba.load()
    total = 0
    wx = 0.0
    for y in range(rgba.height):
        for x in range(rgba.width):
            alpha = pixels[x, y][3]
            if alpha:
                total += alpha
                wx += x * alpha
    if total == 0:
        return None
    return wx / total


def shift_canvas_x(frame: Image.Image, dx: int) -> Image.Image:
    if dx == 0:
        return frame
    shifted = Image.new("RGBA", frame.size, (0, 0, 0, 0))
    w = frame.width
    src_left = max(0, -dx)
    src_right = w + min(0, -dx) if dx < 0 else w - dx
    dst_x = max(0, dx)
    if src_right <= src_left:
        return shifted
    region = frame.crop((src_left, 0, src_right, frame.height))
    shifted.alpha_composite(region, dest=(dst_x, 0))
    return shifted


def align_centroids(frames: list[Image.Image]) -> list[Image.Image]:
    """水平质心对齐。垂直锚点由 stabilize_frames_uniform 的逐帧底部对齐保证。"""
    centroids = [c for f in frames if (c := alpha_centroid_x(f)) is not None]
    if not centroids:
        return frames
    target_x = sorted(centroids)[len(centroids) // 2]
    aligned: list[Image.Image] = []
    for frame in frames:
        current = frame
        for _ in range(4):
            cx = alpha_centroid_x(current)
            if cx is None:
                break
            dx = round(target_x - cx)
            if dx == 0:
                break
            current = shift_canvas_x(current, dx)
        aligned.append(current)
    return aligned


def resize_canvas(canvas: Image.Image) -> Image.Image:
    target_w = max(1, int(round(canvas.width * SCALE)))
    target_h = max(1, int(round(canvas.height * SCALE)))
    return canvas.resize((target_w, target_h), Image.LANCZOS)


def write_json_verified(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    with open(path, "wb") as f:
        f.truncate(0)
        f.write(text.encode("utf-8"))
    try:
        with open(path, encoding="utf-8") as f:
            json.load(f)
    except Exception:
        if path.exists():
            os.remove(path)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)


def process_npc(npc_name: str, prefix: str, web_dir_name: str) -> list[str]:
    src_dir = ASSETS / npc_name
    out_dir = OUTPUT / web_dir_name / "anim"
    out_dir.mkdir(parents=True, exist_ok=True)

    all_frames = collect_frames(src_dir)
    if not all_frames:
        print(f"  {npc_name}: 跳过 (未找到动作素材)")
        return []

    canvas_w, canvas_h = global_canvas_size(all_frames)
    animations: dict[str, dict] = {}
    manifest_images: list[str] = []
    saved_frames: list[Path] = []

    for action, raw_frames in all_frames.items():
        frame_keys: list[str] = []
        canvases = stabilize_frames_uniform(raw_frames, canvas_w, canvas_h)
        if CENTROID_ALIGN_ENABLED:
            canvases = align_centroids(canvases)
        for i, canvas in enumerate(canvases):
            canvas = resize_canvas(canvas)
            out_name = f"{prefix}_{action}_{i}.png"
            out_path = out_dir / out_name
            canvas.save(out_path, optimize=True)
            saved_frames.append(out_path)
            frame_keys.append(out_name)
            manifest_images.append(f"{web_dir_name}/anim/{out_name}")

        animations[action] = {
            "frames": frame_keys,
            "frameRate": 12,
            "repeat": -1 if action in LOOPING_ACTIONS else 0,
        }

    config = {
        "npc_key": web_dir_name,
        "animations": animations,
    }

    anim_json = out_dir / "animations.json"
    npc_json = out_dir.parent / f"{prefix}_animations.json"
    write_json_verified(anim_json, config)
    write_json_verified(npc_json, config)

    web_anim = WEB_ASSETS / web_dir_name / "anim"
    web_anim.mkdir(parents=True, exist_ok=True)
    for src_path in saved_frames:
        dst_path = web_anim / src_path.name
        if dst_path.exists():
            dst_path.unlink()
        shutil.copy2(src_path, dst_path)
    shutil.copy2(anim_json, web_anim / "animations.json")
    shutil.copy2(npc_json, WEB_ASSETS / web_dir_name / f"{prefix}_animations.json")

    print(
        f"  {npc_name}: {len(animations)} 动画, "
        f"{len(saved_frames)} 帧, 统一原始画布 {canvas_w}×{canvas_h} → {web_anim}"
    )
    return manifest_images


def update_manifest(new_images: list[str]) -> None:
    if MANIFEST_PATH.exists():
        with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
            manifest = json.load(f)
    else:
        manifest = {"generatedAt": "", "images": []}

    existing = set(manifest.get("images", []))
    for img in new_images:
        if img not in existing:
            manifest.setdefault("images", []).append(img)
            existing.add(img)

    manifest["images"] = sorted(manifest.get("images", []))
    manifest["generatedAt"] = datetime.now(timezone.utc).isoformat()

    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"\nManifest: 共 {len(manifest['images'])} 张图片")


def main() -> None:
    all_new: list[str] = []
    for npc, (prefix, web_dir_name) in NPC_MAP.items():
        if not (ASSETS / npc).exists():
            print(f"  {npc}: 跳过 (无素材)")
            continue
        all_new.extend(process_npc(npc, prefix, web_dir_name))

    update_manifest(all_new)
    print("\n全部完成！")


if __name__ == "__main__":
    main()
