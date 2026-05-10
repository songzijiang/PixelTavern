from __future__ import annotations

import sqlite3
import os
import logging
from datetime import date, timedelta

from config import DATA_DIR

logger = logging.getLogger(__name__)

DB_PATH = os.path.join(DATA_DIR, "pixel_tavern.db")
CALENDAR_START = date.fromisoformat(os.environ.get("CALENDAR_START", "1500-01-01"))
SECONDS_PER_DAY = int(os.environ.get("SECONDS_PER_DAY", "180"))
DOOR_X = 880
DOOR_Y = 180
DOOR_RADIUS = 55

INITIAL_NPC_STATES = {
    "bartender": {"x": 230, "y": 280, "facing": "front"},
    "warrior": {"x": DOOR_X, "y": DOOR_Y, "facing": "front", "away": True},
    "witch": {"x": DOOR_X, "y": DOOR_Y, "facing": "front", "away": True},
    "mysterious": {"x": DOOR_X, "y": DOOR_Y, "facing": "front", "away": True},
}

SIT_SPOTS = [
    {"x": 320, "y": 345, "facing": "front"},
    {"x": 320, "y": 475, "facing": "back"},
    {"x": 235, "y": 410, "facing": "right"},
    {"x": 405, "y": 410, "facing": "left"},
    {"x": 730, "y": 345, "facing": "front"},
    {"x": 730, "y": 475, "facing": "back"},
    {"x": 645, "y": 410, "facing": "right"},
    {"x": 815, "y": 410, "facing": "left"},
]


def _connect() -> sqlite3.Connection:
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS world_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tick INTEGER NOT NULL,
                segment INTEGER NOT NULL,
                npc TEXT NOT NULL DEFAULT '',
                type TEXT NOT NULL,
                line TEXT,
                to_npc TEXT,
                emote TEXT,
                topic TEXT
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_tick ON world_events(tick)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_npc ON world_events(npc)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS cycle_messages (
                segment INTEGER PRIMARY KEY,
                user_message TEXT NOT NULL,
                assistant_response TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS npc_snapshot (
                npc_key TEXT PRIMARY KEY,
                x INTEGER NOT NULL DEFAULT 0,
                y INTEGER NOT NULL DEFAULT 0,
                action TEXT NOT NULL DEFAULT 'idle',
                facing TEXT NOT NULL DEFAULT 'front',
                sitting_at INTEGER DEFAULT -1
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS npc_segment_snapshot (
                segment INTEGER NOT NULL,
                npc_key TEXT NOT NULL,
                x INTEGER NOT NULL DEFAULT 0,
                y INTEGER NOT NULL DEFAULT 0,
                action TEXT NOT NULL DEFAULT 'idle',
                facing TEXT NOT NULL DEFAULT 'front',
                sitting_at INTEGER DEFAULT -1,
                PRIMARY KEY (segment, npc_key)
            )
        """)


def save_plan_events(segment_start: int, plan: list, topic: str = "", user_guidance: str = ""):
    """从 LLM 返回的 plan 中提取 talk/emote 事件写入 DB。
    segment_start 为绝对 tick（段起点），每个动作的绝对 tick = segment_start + sec。"""
    segment = segment_start // 30
    rows: list[tuple] = []

    if topic:
        rows.append((segment_start, segment, "", "topic", None, None, None, topic))
    if user_guidance:
        rows.append((segment_start, segment, "", "user_event", user_guidance, None, None, None))

    for tl in plan:
        npc_key = tl.get("npc", "")
        for a in tl.get("actions", []):
            atype = a.get("action", "")
            abs_tick = segment_start + a.get("sec", 0)
            if atype == "talk" and a.get("line"):
                rows.append((abs_tick, segment, npc_key, "talk", a["line"], a.get("to"), None, None))
            elif atype == "emote" and a.get("emote"):
                rows.append((abs_tick, segment, npc_key, "emote", None, None, a["emote"], None))

    if not rows:
        return

    try:
        with _connect() as conn:
            conn.executemany(
                "INSERT INTO world_events (tick, segment, npc, type, line, to_npc, emote, topic) VALUES (?,?,?,?,?,?,?,?)",
                rows,
            )
        logger.info(f"保存 {len(rows)} 条事件到段 {segment}（tick {segment_start}）")
    except Exception as e:
        logger.error(f"保存事件失败: {e}", exc_info=True)


def get_dialogues(limit: int = 80) -> list[dict]:
    """获取最近对话，返回 [{sec, speaker, line, to}]。"""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT tick, npc, line, to_npc FROM world_events WHERE type='talk' ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [{"sec": r["tick"], "speaker": r["npc"], "line": r["line"], "to": r["to_npc"]} for r in reversed(rows)]


def save_cycle_message(segment: int, user_message: str, assistant_response: str):
    """保存每个周期的 user prompt 和 LLM 响应，用于多轮对话重建。"""
    try:
        with _connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO cycle_messages (segment, user_message, assistant_response) VALUES (?,?,?)",
                (segment, user_message, assistant_response),
            )
    except Exception as e:
        logger.error(f"保存 cycle message 失败 (segment={segment}): {e}", exc_info=True)


def get_cycle_messages() -> list[dict]:
    """返回所有保存的周期消息，按 segment 升序。
    每条: {segment, user_message, assistant_response}。"""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT segment, user_message, assistant_response FROM cycle_messages ORDER BY segment ASC"
        ).fetchall()
    return [{"segment": r["segment"], "user_message": r["user_message"], "assistant_response": r["assistant_response"]} for r in rows]


def get_recent_topic() -> str:
    with _connect() as conn:
        row = conn.execute(
            "SELECT topic FROM world_events WHERE type='topic' ORDER BY id DESC LIMIT 1"
        ).fetchone()
    return row["topic"] if row else ""


def migrate_old_events_to_cycle_messages():
    """将旧 world_events 数据迁移到 cycle_messages 表。
    旧格式缺少原始 user_message 和 assistant_response，
    用对话摘要 + 占位 plan 重建，保留历史上下文。"""
    with _connect() as conn:
        old_events = conn.execute("SELECT COUNT(*) FROM world_events").fetchone()[0]
        old_messages = conn.execute("SELECT COUNT(*) FROM cycle_messages").fetchone()[0]
        if old_events == 0 or old_messages > 0:
            return 0

        logger.info("开始迁移 %d 条旧 world_events → cycle_messages...", old_events)

        # 按 segment 分组
        topic_rows = conn.execute(
            "SELECT segment, topic FROM world_events WHERE type='topic' ORDER BY segment ASC"
        ).fetchall()
        talk_rows = conn.execute(
            "SELECT segment, tick, npc, line, to_npc FROM world_events WHERE type='talk' ORDER BY segment ASC, tick ASC"
        ).fetchall()

    cycles: dict[int, dict] = {}
    for r in topic_rows:
        cycles[r["segment"]] = {"topic": r["topic"], "dialogues": []}
    for r in talk_rows:
        seg = r["segment"]
        if seg not in cycles:
            cycles[seg] = {"topic": "", "dialogues": []}
        cycles[seg]["dialogues"].append({
            "speaker": r["npc"],
            "line": r["line"],
            "to": r["to_npc"],
        })

    count = 0
    for seg in sorted(cycles):
        c = cycles[seg]
        dialogue_str = "\n".join(
            f"- {d['speaker']}{' → ' + d['to'] if d.get('to') else ''}: \"{d['line']}\""
            for d in c["dialogues"]
        ) or "(无对话)"

        user_message = (
            f"【第 {seg} 周期】（已归档 — 仅对话摘要）\n\n"
            f"话题：{c['topic'] or '(无主题)'}\n\n"
            f"对话：\n{dialogue_str}"
        )

        import json as _json
        assistant_response = _json.dumps(
            {"tick": seg, "topic": c["topic"], "plan": [], "_migrated": True},
            ensure_ascii=False,
        )

        try:
            with _connect() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO cycle_messages (segment, user_message, assistant_response) VALUES (?,?,?)",
                    (seg, user_message, assistant_response),
                )
            count += 1
        except Exception as e:
            logger.error("迁移 segment %d 失败: %s", seg, e)

    logger.info("迁移完成：%d 个周期写入 cycle_messages", count)
    return count


def get_memories(limit: int = 50) -> dict:
    """返回按 NPC 分组的最近记忆。"""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT tick, npc, type, line, to_npc, emote FROM world_events WHERE type IN ('talk','emote') ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    groups: dict[str, list[dict]] = {}
    for r in reversed(rows):
        groups.setdefault(r["npc"], []).append({
            "tick": r["tick"],
            "type": r["type"],
            "line": r["line"],
            "to": r["to_npc"],
            "emote": r["emote"],
        })
    return groups


def get_last_tick() -> int:
    with _connect() as conn:
        row = conn.execute("SELECT MAX(tick) as mt FROM world_events").fetchone()
    return row["mt"] or 0


def get_total_events() -> int:
    with _connect() as conn:
        row = conn.execute("SELECT COUNT(*) as cnt FROM world_events").fetchone()
    return row["cnt"]


def get_segment_summaries() -> list[dict]:
    """返回按每 30-tick 段分组的话题摘要，给前端历史重建用。"""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT segment, topic FROM world_events WHERE type='topic' ORDER BY id DESC LIMIT 50"
        ).fetchall()
    seen: set[int] = set()
    result: list[dict] = []
    for r in rows:
        seg = r["segment"]
        if seg not in seen:
            seen.add(seg)
            result.append({"segment": seg, "topic": r["topic"]})
    result.sort(key=lambda x: x["segment"])
    return result


def format_calendar(tick: int) -> str:
    SEGMENT = 30
    ROUNDS = 6
    total_rounds = tick // SEGMENT
    days = total_rounds // ROUNDS
    round_in_day = total_rounds % ROUNDS
    hour = round_in_day * 4
    try:
        from services.prompt_builder import get_calendar_start_date
        start = get_calendar_start_date()
    except Exception:
        start = CALENDAR_START
    d = start + timedelta(days=days)
    return f"{d.year}年{d.month:02d}月{d.day:02d}日 {hour:02d}:00"


def save_npc_snapshots(states: list[dict], occupied_chairs: dict[str, str], segment: int | None = None):
    """保存 NPC 位置/动作/朝向快照，用于启动恢复和历史段起点恢复。"""
    rows: list[tuple] = []
    for s in states:
        sitting_at = -1
        if s.get("current_action", "").startswith("sitting_at_chair_"):
            try:
                sitting_at = int(s["current_action"].rsplit("_", 1)[-1])
            except ValueError:
                pass
        rows.append((s["key"], s["x"], s["y"], s.get("current_action", "idle"), s.get("facing", "front"), sitting_at))
    try:
        with _connect() as conn:
            conn.execute("DELETE FROM npc_snapshot")
            conn.executemany(
                "INSERT OR REPLACE INTO npc_snapshot (npc_key, x, y, action, facing, sitting_at) VALUES (?,?,?,?,?,?)",
                rows,
            )
            if segment is not None:
                conn.execute("DELETE FROM npc_segment_snapshot WHERE segment=?", (segment,))
                conn.executemany(
                    "INSERT OR REPLACE INTO npc_segment_snapshot (segment, npc_key, x, y, action, facing, sitting_at) VALUES (?,?,?,?,?,?,?)",
                    [(segment, *row) for row in rows],
                )
    except Exception as e:
        logger.error(f"保存 NPC 快照失败: {e}")


def get_all_user_events() -> list[dict]:
    """返回所有用户事件（type='user_event'）。"""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT segment, tick, line FROM world_events WHERE type='user_event' ORDER BY tick ASC"
        ).fetchall()
    return [{"segment": r["segment"], "tick": r["tick"], "message": r["line"]} for r in rows]


def get_last_npc_states() -> list[dict]:
    """返回所有 NPC 的最后已知状态。"""
    with _connect() as conn:
        rows = conn.execute("SELECT npc_key, x, y, action, facing, sitting_at FROM npc_snapshot").fetchall()
    return [{"key": r["npc_key"], "x": r["x"], "y": r["y"], "action": r["action"], "facing": r["facing"], "sitting_at": r["sitting_at"]} for r in rows]


def get_events_for_segments(from_segment: int, to_segment: int) -> list[dict]:
    """返回指定段范围的重播数据。
    每条: {segment, topic, plan: list[NPCTimeline], user_events: [{tick, message}]}。"""
    import json as _json
    with _connect() as conn:
        msgs = conn.execute(
            "SELECT segment, user_message, assistant_response FROM cycle_messages WHERE segment BETWEEN ? AND ? ORDER BY segment ASC",
            (from_segment, to_segment),
        ).fetchall()

        topic_rows = conn.execute(
            "SELECT segment, topic FROM world_events WHERE type='topic' AND segment BETWEEN ? AND ? ORDER BY segment ASC",
            (from_segment, to_segment),
        ).fetchall()
        topic_map: dict[int, str] = {}
        for r in topic_rows:
            topic_map[r["segment"]] = r["topic"]

        user_rows = conn.execute(
            "SELECT segment, tick, line FROM world_events WHERE type='user_event' AND segment BETWEEN ? AND ? ORDER BY tick ASC",
            (from_segment, to_segment),
        ).fetchall()
        user_map: dict[int, list[dict]] = {}
        for r in user_rows:
            user_map.setdefault(r["segment"], []).append({"tick": r["tick"], "message": r["line"]})

    result: list[dict] = []
    for m in msgs:
        seg = m["segment"]
        plan = []
        try:
            data = _json.loads(m["assistant_response"])
            plan = data.get("plan", [])
        except (_json.JSONDecodeError, TypeError):
            pass
        result.append({
            "segment": seg,
            "topic": topic_map.get(seg, ""),
            "plan": plan,
            "user_events": user_map.get(seg, []),
        })
    return result


def get_npc_snapshot_for_replay(before_segment: int) -> list[dict]:
    """返回指定重播段的起点 NPC 快照。优先使用逐段快照，旧数据则从计划粗略重建。"""
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT npc_key, x, y, action, facing, sitting_at
            FROM npc_segment_snapshot
            WHERE segment=?
            ORDER BY npc_key
            """,
            (before_segment,),
        ).fetchall()
    if rows:
        return [{"key": r["npc_key"], "x": r["x"], "y": r["y"], "action": r["action"], "facing": r["facing"], "sitting_at": r["sitting_at"]} for r in rows]
    return _rebuild_npc_snapshot_before_segment(before_segment)


def _rebuild_npc_snapshot_before_segment(before_segment: int) -> list[dict]:
    """为旧记录兜底：从默认初始状态和已存 plan 推演到目标段起点。"""
    import json as _json

    states = {
        key: {
            "key": key,
            "x": value["x"],
            "y": value["y"],
            "action": "standing_behind_counter" if key == "bartender" else ("away_from_tavern" if value.get("away") else "idle"),
            "facing": value["facing"],
            "sitting_at": -1,
        }
        for key, value in INITIAL_NPC_STATES.items()
    }

    if before_segment <= 0:
        return list(states.values())

    with _connect() as conn:
        rows = conn.execute(
            "SELECT segment, assistant_response FROM cycle_messages WHERE segment < ? ORDER BY segment ASC",
            (before_segment,),
        ).fetchall()

    for row in rows:
        try:
            data = _json.loads(row["assistant_response"])
        except (_json.JSONDecodeError, TypeError):
            continue
        actions: list[tuple[int, str, dict]] = []
        for timeline in data.get("plan", []):
            npc_key = timeline.get("npc", "")
            if npc_key not in states:
                continue
            for action in timeline.get("actions", []):
                actions.append((int(action.get("sec", 0)), npc_key, action))
        actions.sort(key=lambda item: item[0])
        for _, npc_key, action in actions:
            _apply_action_to_snapshot(states, npc_key, action)

    return list(states.values())


def _apply_action_to_snapshot(states: dict[str, dict], npc_key: str, action: dict) -> None:
    state = states[npc_key]
    action_type = action.get("action")
    if action_type == "walk_to" and action.get("x") is not None and action.get("y") is not None:
        old_x, old_y = state["x"], state["y"]
        x, y = int(round(action["x"])), int(round(action["y"]))
        state["x"], state["y"] = x, y
        state["facing"] = _facing_from_delta(x - old_x, y - old_y)
        state["sitting_at"] = -1
        if npc_key != "bartender" and ((x - DOOR_X) ** 2 + (y - DOOR_Y) ** 2) ** 0.5 < DOOR_RADIUS:
            state["action"] = "away_from_tavern"
            state["x"], state["y"] = DOOR_X, DOOR_Y
        else:
            state["action"] = "idle"
    elif action_type == "sit" and action.get("x") is not None and action.get("y") is not None:
        x, y = int(round(action["x"])), int(round(action["y"]))
        chair_idx = _chair_index_at(x, y)
        state["x"], state["y"] = x, y
        state["sitting_at"] = chair_idx
        if chair_idx >= 0:
            state["action"] = f"sitting_at_chair_{chair_idx}"
            state["facing"] = SIT_SPOTS[chair_idx]["facing"]
        else:
            state["action"] = "idle"
    elif action_type == "stand" or action_type == "idle":
        state["action"] = "standing_behind_counter" if npc_key == "bartender" else "idle"
        state["sitting_at"] = -1
    elif action_type == "leave_tavern" and npc_key != "bartender":
        state["x"], state["y"] = DOOR_X, DOOR_Y
        state["action"] = "away_from_tavern"
        state["sitting_at"] = -1
    elif action_type == "emote" and action.get("emote") == "sleepy" and state["action"] != "away_from_tavern":
        state["action"] = "dozing_in_corner"
        state["sitting_at"] = -1


def _chair_index_at(x: int, y: int) -> int:
    for idx, spot in enumerate(SIT_SPOTS):
        if abs(spot["x"] - x) < 10 and abs(spot["y"] - y) < 10:
            return idx
    return -1


def _facing_from_delta(dx: int, dy: int) -> str:
    if abs(dx) >= abs(dy):
        return "right" if dx > 0 else "left"
    return "front" if dy > 0 else "back"


def export_all() -> dict:
    """导出全部世界数据为 JSON 字典。包含完整 messages 上下文（system prompt + 所有 cycle_messages）。"""
    from datetime import datetime, timezone
    from services.prompt_builder import _load_custom_prompts, _prompt_config_from_data, build_system_prompt_from_data

    with _connect() as conn:
        events = [dict(r) for r in conn.execute("SELECT * FROM world_events ORDER BY id ASC").fetchall()]
        cycles = [dict(r) for r in conn.execute("SELECT segment, user_message, assistant_response FROM cycle_messages ORDER BY segment ASC").fetchall()]
        snapshots = [dict(r) for r in conn.execute("SELECT * FROM npc_snapshot").fetchall()]
        segment_snapshots = [dict(r) for r in conn.execute("SELECT * FROM npc_segment_snapshot ORDER BY segment ASC, npc_key ASC").fetchall()]
    last_tick = get_last_tick()

    # 导出当前使用的 prompt 设置与最终拼接后的 system prompt。
    custom = _load_custom_prompts()
    prompt_settings = _prompt_config_from_data(custom)
    system_prompt = build_system_prompt_from_data(custom)
    user_prompt = prompt_settings["user_prompt"]

    return {
        "version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "last_tick": last_tick,
        "calendar": format_calendar(last_tick),
        "calendar_start": prompt_settings["calendar_start"],
        "prompt_settings": prompt_settings,
        "system_prompt": system_prompt,
        "user_prompt": user_prompt,
        "world_events": events,
        "cycle_messages": cycles,
        "npc_snapshot": snapshots,
        "npc_segment_snapshot": segment_snapshots,
    }


def import_all(data: dict) -> int:
    """导入世界数据 —— 全量替换。清空后导入，恢复 system/user prompt。返回写入行数。"""
    if data.get("version") != 1:
        raise ValueError(f"不支持的导出版本: {data.get('version')}")

    required = ("world_events", "cycle_messages", "npc_snapshot")
    for key in required:
        if key not in data:
            raise ValueError(f"缺少必需字段: {key}")

    clear_all()

    # 恢复 prompt 设置。安全审核块不从导入文件恢复，由后端固定拼接。
    prompt_settings = data.get("prompt_settings")
    sp = data.get("system_prompt")
    up = data.get("user_prompt")
    if isinstance(prompt_settings, dict) or sp or up or data.get("calendar_start"):
        from config import set_config_section
        from services.prompt_builder import normalize_world_prompt_data
        to_save = dict(prompt_settings) if isinstance(prompt_settings, dict) else {}
        if sp and "system_prompt" not in to_save:
            to_save["system_prompt"] = sp
        if up and "user_prompt" not in to_save:
            to_save["user_prompt"] = up
        if data.get("calendar_start") and "calendar_start" not in to_save:
            to_save["calendar_start"] = data["calendar_start"]
        try:
            normalized = normalize_world_prompt_data(to_save)
            for k in ("preset_key", "map_prompt", "story_background", "story_theme",
                      "user_prompt", "calendar_start", "character_overrides",
                      "characters", "relationship_prompt", "custom_presets",
                      "system_prompt"):
                if k in normalized:
                    set_config_section(k, normalized[k])
        except Exception:
            pass

    count = 0
    with _connect() as conn:
        for row in data.get("world_events", []):
            conn.execute(
                "INSERT INTO world_events (id, tick, segment, npc, type, line, to_npc, emote, topic) VALUES (?,?,?,?,?,?,?,?,?)",
                (row["id"], row["tick"], row["segment"], row["npc"], row["type"], row.get("line"), row.get("to_npc"), row.get("emote"), row.get("topic")),
            )
            count += 1

        for row in data.get("cycle_messages", []):
            conn.execute(
                "INSERT INTO cycle_messages (segment, user_message, assistant_response) VALUES (?,?,?)",
                (row["segment"], row["user_message"], row["assistant_response"]),
            )
            count += 1

        for row in data.get("npc_snapshot", []):
            conn.execute(
                "INSERT OR REPLACE INTO npc_snapshot (npc_key, x, y, action, facing, sitting_at) VALUES (?,?,?,?,?,?)",
                (row["npc_key"], row["x"], row["y"], row["action"], row["facing"], row["sitting_at"]),
            )
            count += 1

        for row in data.get("npc_segment_snapshot", []):
            conn.execute(
                "INSERT OR REPLACE INTO npc_segment_snapshot (segment, npc_key, x, y, action, facing, sitting_at) VALUES (?,?,?,?,?,?,?)",
                (row["segment"], row["npc_key"], row["x"], row["y"], row["action"], row["facing"], row["sitting_at"]),
            )
            count += 1

    logger.info("导入完成: 全量替换, 写入 %d 行", count)
    return count


def clear_all():
    with _connect() as conn:
        conn.execute("DELETE FROM world_events")
        conn.execute("DELETE FROM cycle_messages")
        conn.execute("DELETE FROM npc_snapshot")
        conn.execute("DELETE FROM npc_segment_snapshot")
