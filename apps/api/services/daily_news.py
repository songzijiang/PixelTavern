import json
import logging
import os
from datetime import datetime
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import quote_plus
import xml.etree.ElementTree as ET

import httpx

from config import DATA_DIR

logger = logging.getLogger(__name__)

NEWS_STATE_FILE = os.path.join(DATA_DIR, "daily_news_guidance.json")
NEWS_TIMEOUT = 8
MAX_HEADLINES = 1

RSS_SOURCES = [
    "https://news.google.com/rss?hl=zh-CN&gl=CN&ceid=CN:zh-Hans",
    f"https://news.google.com/rss/search?q={quote_plus('今日 头条 OR 要闻')}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans",
]


def _today_key() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _load_json(path: str) -> dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_json(path: str, data: dict[str, Any]) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def is_daily_news_guidance_enabled() -> bool:
    from config import get_config_section
    settings = get_config_section("llm", {})
    return bool(settings.get("daily_news_guidance_enabled"))


def should_inject_daily_news() -> bool:
    state = _load_json(NEWS_STATE_FILE)
    return state.get("last_injected_date") != _today_key()


def get_daily_news_guidance_status() -> dict[str, Any]:
    state = _load_json(NEWS_STATE_FILE)
    pending = state.get("pending_manual_guidance") if isinstance(state.get("pending_manual_guidance"), dict) else {}
    return {
        "today": _today_key(),
        "sent_today": state.get("last_injected_date") == _today_key(),
        "last_injected_date": state.get("last_injected_date", ""),
        "last_injected_at": state.get("last_injected_at", ""),
        "segment": state.get("segment"),
        "headline_count": state.get("headline_count", 0),
        "guidance": state.get("guidance", ""),
        "headlines": state.get("headlines", []),
        "pending_manual": bool(pending),
        "pending_manual_created_at": pending.get("created_at", ""),
        "pending_manual_guidance": pending.get("guidance", ""),
    }


def mark_daily_news_injected(segment: int, headlines: list[str], guidance: str, source: str = "auto") -> None:
    state = _load_json(NEWS_STATE_FILE)
    state.pop("pending_manual_guidance", None)
    state.update(
        {
            "last_injected_date": _today_key(),
            "last_injected_at": datetime.now().isoformat(timespec="seconds"),
            "segment": segment,
            "headline_count": len(headlines),
            "headlines": headlines,
            "guidance": guidance,
            "source": source,
        }
    )
    _save_json(
        NEWS_STATE_FILE,
        state,
    )


def _clean_title(title: str) -> str:
    title = " ".join(title.split())
    if " - " in title:
        title = title.rsplit(" - ", 1)[0].strip()
    return title


def _item_date(item: ET.Element) -> str:
    raw = item.findtext("pubDate") or ""
    if not raw:
        return ""
    try:
        return parsedate_to_datetime(raw).strftime("%Y-%m-%d")
    except (TypeError, ValueError):
        return ""


async def fetch_daily_headlines() -> list[str]:
    headers = {
        "User-Agent": "PixelTavern/1.0 (+https://github.com/songzijiang/PixelTavern)",
        "Accept": "application/rss+xml, application/xml, text/xml",
    }
    seen: set[str] = set()
    headlines: list[str] = []

    async with httpx.AsyncClient(timeout=NEWS_TIMEOUT, follow_redirects=True, headers=headers) as client:
        for url in RSS_SOURCES:
            try:
                resp = await client.get(url)
                resp.raise_for_status()
                root = ET.fromstring(resp.text)
            except Exception as exc:
                logger.warning("今日要闻抓取失败: %s (%s)", url, exc)
                continue

            for item in root.findall(".//item"):
                title = _clean_title(item.findtext("title") or "")
                if not title or title in seen:
                    continue
                seen.add(title)

                pub_date = _item_date(item)
                if pub_date:
                    headlines.append(f"{pub_date}：{title}")
                else:
                    headlines.append(title)

                if len(headlines) >= MAX_HEADLINES:
                    return headlines

    return headlines


def format_daily_news_guidance(headlines: list[str]) -> str:
    today = _today_key()
    lines = "\n".join(f"{idx}. {headline}" for idx, headline in enumerate(headlines, start=1))
    return (
        f"【今日要闻引导】以下是启动本轮前搜索到的现实世界头条信息，"
        "可作为酒馆传闻、旅人闲谈或角色反应的灵感；不要照搬新闻播报腔，也不要声称角色能直接访问现代互联网。\n"
        f"{lines}\n"
        "请将这些信息转译为符合主题的内容，所有的输出内容请遵守相关法律法规，严谨输出任何可能涉及暴力、血腥、色情、政治敏感等内容的提示词，确保输出内容适合所有年龄段的读者。"
    )


async def build_daily_news_guidance_if_needed(segment: int) -> str:
    state = _load_json(NEWS_STATE_FILE)
    pending = state.get("pending_manual_guidance")
    if isinstance(pending, dict) and pending.get("guidance"):
        headlines = pending.get("headlines") if isinstance(pending.get("headlines"), list) else []
        guidance = str(pending["guidance"])
        mark_daily_news_injected(segment, headlines, guidance, source="manual")
        logger.info("手动今日要闻引导已注入: %s 条", len(headlines))
        return guidance

    if not is_daily_news_guidance_enabled() or not should_inject_daily_news():
        return ""

    headlines = await fetch_daily_headlines()
    if not headlines:
        logger.warning("今日要闻引导已开启，但未抓取到可用头条")
        return ""

    guidance = format_daily_news_guidance(headlines)
    mark_daily_news_injected(segment, headlines, guidance, source="auto")
    logger.info("今日要闻引导已注入: %s 条", len(headlines))
    return guidance


async def create_manual_daily_news_guidance() -> dict[str, Any]:
    headlines = await fetch_daily_headlines()
    if not headlines:
        return {"ok": False, "message": "未抓取到可用头条"}

    guidance = format_daily_news_guidance(headlines)
    state = _load_json(NEWS_STATE_FILE)
    state["pending_manual_guidance"] = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "headlines": headlines,
        "guidance": guidance,
    }
    _save_json(NEWS_STATE_FILE, state)
    return {
        "ok": True,
        "message": "已生成手动新闻引导，将在下一次 LLM 请求注入",
        "headline_count": len(headlines),
        "guidance": guidance,
        "headlines": headlines,
    }
