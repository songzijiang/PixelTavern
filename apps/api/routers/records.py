import json
import logging

from fastapi import APIRouter, HTTPException, Query

from models.schemas import ImportRequest
from services import world_store
from services.prompt_builder import get_calendar_start_iso, sync_world_prompt_map_from_scene_edit

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/world", tags=["records"])


@router.get("/dialogues")
async def get_dialogues(limit: int = Query(default=80, ge=1, le=500)):
    """获取最近对话记录，给前端做 LLM 上下文。"""
    return world_store.get_dialogues(limit)


@router.get("/memories")
async def get_memories(limit: int = Query(default=50, ge=1, le=200)):
    """获取按 NPC 分组的最近记忆。"""
    return world_store.get_memories(limit)


@router.get("/state")
async def get_state():
    """返回世界当前状态 + 每个已完成段落的 plan 详情。"""
    tick = world_store.get_last_tick()
    segments: list[dict] = []

    cm_list = world_store.get_cycle_messages()
    cm_map = {c["segment"]: c for c in cm_list}

    # topic 映射（来自 world_events）
    topic_map: dict[int, str] = {}
    for s in world_store.get_segment_summaries():
        topic_map[s["segment"]] = s["topic"]

    # 用户事件映射
    user_map: dict[int, list[dict]] = {}
    for r in world_store.get_all_user_events():
        user_map.setdefault(r["segment"], []).append({"tick": r["tick"], "message": r["message"]})

    # 以 cycle_messages 为基准构建 segment 列表（确保不遗漏任何段）
    for seg in sorted(cm_map.keys()):
        plan = None
        try:
            data = json.loads(cm_map[seg]["assistant_response"])
            plan = data.get("plan")
        except json.JSONDecodeError:
            pass
        segments.append({
            "segment": seg,
            "topic": topic_map.get(seg, ""),
            "plan": plan,
            "user_events": user_map.get(seg, []),
        })

    return {
        "last_tick": tick,
        "total_events": world_store.get_total_events(),
        "calendar": world_store.format_calendar(tick),
        "calendar_start": get_calendar_start_iso(),
        "topic": world_store.get_recent_topic(),
        "segments": segments,
        "npc_states": world_store.get_last_npc_states(),
    }


@router.get("/replay")
async def get_replay_data(
    from_segment: int = Query(ge=0),
    to_segment: int = Query(ge=0),
):
    """获取指定段范围的重播数据。"""
    segments = world_store.get_events_for_segments(from_segment, to_segment)
    npc_snapshot = world_store.get_npc_snapshot_for_replay(from_segment)
    return {"segments": segments, "npc_snapshot": npc_snapshot}


@router.get("/export")
async def export_data():
    """导出全部世界数据为 JSON。"""
    return world_store.export_all()


@router.post("/import")
async def import_data(req: ImportRequest):
    """导入世界数据，全量替换当前数据。"""
    try:
        count = world_store.import_all(req.data)
        return {"ok": True, "imported": count}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/collisions")
async def get_collisions():
    """读取碰撞区配置。"""
    from config import get_config_section
    return get_config_section("collisions", {"zones": [], "props": []})


@router.put("/collisions")
async def save_collisions(body: dict):
    """保存碰撞区配置。"""
    from config import set_config_section
    zones = body.get("zones") if isinstance(body.get("zones"), list) else []
    props = body.get("props") if isinstance(body.get("props"), list) else []
    set_config_section("collisions", {"zones": zones, "props": props})
    sync_world_prompt_map_from_scene_edit(body)
    return {"ok": True}


@router.delete("/collisions")
async def delete_collisions():
    """重置碰撞区/素材编辑数据。"""
    from config import set_config_section
    set_config_section("collisions", {"zones": [], "props": []})
    return {"ok": True}


@router.delete("/records")
async def clear_records():
    """清空全部世界记录。"""
    world_store.clear_all()
    return {"ok": True}
