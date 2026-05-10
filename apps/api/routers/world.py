import json
import logging
from typing import Any

from fastapi import APIRouter
from pydantic import ValidationError

from models.schemas import CacheInfo, WorldTickRequest, WorldTickResponse
from services.prompt_builder import build_system_prompt, build_cycle_user_message
from services.llm_client import call_llm
from services.daily_news import build_daily_news_guidance_if_needed
from services import world_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/world", tags=["world"])


def _coerce_sec(value: Any, default: int = 2) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _normalize_talk_sequence(plan: list[dict]) -> int:
    """Ensure talk actions execute in the narrative order returned by the model."""
    if not isinstance(plan, list):
        return 0

    talks: list[dict[str, Any]] = []
    for timeline in plan:
        if not isinstance(timeline, dict):
            continue
        actions = timeline.get("actions")
        if not isinstance(actions, list):
            continue
        for action in actions:
            if isinstance(action, dict) and action.get("action") == "talk":
                talks.append(action)

    if not talks:
        return 0

    min_sec = 2
    max_sec = 28
    gap = 2 if min_sec + (len(talks) - 1) * 2 <= max_sec else 1
    prev_sec = min_sec - gap
    changed = 0

    for idx, action in enumerate(talks):
        old_sec = _coerce_sec(action.get("sec"), min_sec)
        remaining = len(talks) - idx - 1
        latest_allowed = max_sec - gap * remaining
        new_sec = min(max(old_sec, prev_sec + gap), latest_allowed)
        if new_sec != old_sec:
            changed += 1
        action["sec"] = new_sec
        prev_sec = new_sec

    for timeline in plan:
        actions = timeline.get("actions") if isinstance(timeline, dict) else None
        if isinstance(actions, list):
            actions.sort(key=lambda item: _coerce_sec(item.get("sec"), min_sec) if isinstance(item, dict) else min_sec)

    return changed


@router.post("/tick", response_model=WorldTickResponse)
async def world_tick(req: WorldTickRequest):
    """
    世界 Tick 端点。用多轮对话格式构建 messages 数组，
    历史周期 → user/assistant 对，当前周期只追加 user message。
    """
    # 0. 保存当前 NPC 状态快照，供前端启动恢复
    world_store.save_npc_snapshots(
        [{"key": s.key, "x": s.x, "y": s.y, "current_action": s.current_action, "facing": s.facing} for s in req.npc_states],
        req.occupied_chairs,
        segment=req.tick,
    )

    # 1. System prompt
    messages: list[dict] = [{"role": "system", "content": build_system_prompt()}]

    # 2. 已完成的周期 → user/assistant 对（前缀不变 → KV cache 命中）
    for cm in world_store.get_cycle_messages():
        messages.append({"role": "user", "content": cm["user_message"]})
        messages.append({"role": "assistant", "content": cm["assistant_response"]})

    # 3. 当前周期的 user message（用户引导集成在 prompt 内）
    daily_news_guidance = await build_daily_news_guidance_if_needed(req.tick)
    current_user_message = build_cycle_user_message(req, daily_news_guidance=daily_news_guidance)
    messages.append({"role": "user", "content": current_user_message})

    # KV cache 诊断
    past_msg_count = len(messages) - 2
    sys_hash = hash(messages[0]["content"]) & 0xFFFF
    has_guidance = bool(req.user_message.strip())
    has_daily_news = bool(daily_news_guidance)
    logger.info(
        f"World tick {req.tick}: {len(req.npc_states)} NPCs, {len(messages)} msgs "
        f"(历史 {past_msg_count} 条"
        f"{', 含用户引导' if has_guidance else ''}"
        f"{', 含今日要闻' if has_daily_news else ''}) | "
        f"system_hash=0x{sys_hash:04x}"
    )

    # 4. 用户引导持久化到事件（前端世界面板展示）
    combined_guidance = "\n\n".join(
        part for part in [req.user_message.strip(), daily_news_guidance.strip()] if part
    )

    if combined_guidance:
        world_store.save_plan_events(
            segment_start=req.tick * 30,
            plan=[],
            topic="",
            user_guidance=combined_guidance,
        )

    result, cache_info = await call_llm(messages)

    cache = CacheInfo(**cache_info) if cache_info else CacheInfo()

    if result and "plan" in result:
        try:
            adjusted_talks = _normalize_talk_sequence(result["plan"])
            if adjusted_talks:
                logger.info("World tick %s: adjusted %s talk sec values for causal order", req.tick, adjusted_talks)
            response = WorldTickResponse(
                tick=result.get("tick", req.tick),
                topic=result.get("topic", ""),
                plan=result["plan"],
                cache=cache,
                user_guidance=combined_guidance,
            )
            # 持久化事件到 DB
            world_store.save_plan_events(
                segment_start=req.tick * 30,
                plan=result["plan"],
                topic=result.get("topic", ""),
            )
            # 保存周期消息，供下一轮多轮对话使用
            world_store.save_cycle_message(
                segment=req.tick,
                user_message=current_user_message,
                assistant_response=json.dumps(result, ensure_ascii=False),
            )
            return response
        except ValidationError as exc:
            logger.warning("World tick %s: LLM plan schema invalid: %s", req.tick, exc)

    # Fallback：空计划
    logger.info(f"World tick {req.tick}: 使用空计划 (LLM 不可用)")
    return WorldTickResponse(tick=req.tick, plan=[], cache=cache, user_guidance=combined_guidance)
