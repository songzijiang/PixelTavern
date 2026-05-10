import json
import logging
import os
import asyncio
from typing import Optional

import httpx

from config import (
    DEFAULT_BASE_URL,
    DEFAULT_API_KEY,
    DEFAULT_MODEL,
    WORLD_BASE_URL,
    WORLD_API_KEY,
    WORLD_MODEL,
    LLM_TIMEOUT,
    DATA_DIR,
)

logger = logging.getLogger(__name__)

MAX_RETRIES = int(os.environ.get("LLM_MAX_RETRIES", "3"))
RETRY_BASE_DELAY = float(os.environ.get("LLM_RETRY_DELAY", "1.5"))  # 秒


def _load_saved() -> dict:
    from config import get_config_section
    return get_config_section("llm", {})


def _get_config() -> tuple[str, str, str]:
    """获取 LLM 配置。优先级：环境变量 > 保存的配置 > 默认值。"""
    saved = _load_saved()

    base = WORLD_BASE_URL or saved.get("base_url") or DEFAULT_BASE_URL
    key = WORLD_API_KEY or saved.get("api_key") or DEFAULT_API_KEY
    model = WORLD_MODEL or saved.get("model") or DEFAULT_MODEL
    return base, key, model


def chat_completions_url(base_url: str) -> str:
    """Build an OpenAI-compatible chat completions URL without duplicating /v1."""
    base = base_url.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    if base.endswith("/v1"):
        return f"{base}/chat/completions"
    return f"{base}/v1/chat/completions"


def _parse_llm_response(content: str) -> Optional[dict]:
    """尝试从 LLM 返回内容中解析 JSON。返回 None 表示解析失败（调用方可记录日志）。"""
    content = content.strip()

    if content.startswith("```"):
        lines = content.split("\n")
        if len(lines) > 1:
            content = "\n".join(lines[1:])
        else:
            content = ""
    if content.endswith("```"):
        content = content[:-3].strip()

    brace_idx = content.find("{")
    if brace_idx > 0:
        content = content[brace_idx:]

    try:
        return json.loads(content)
    except json.JSONDecodeError as e:
        logger.debug(f"LLM JSON 解析失败 (前200字符): {content[:200]!r} | error: {e}")
        return None


async def _single_llm_call(
    client: httpx.AsyncClient,
    base_url: str,
    api_key: str,
    model: str,
    messages: list[dict],
) -> tuple[Optional[str], Optional[str], dict]:
    """单次 LLM 调用。返回 (content, error_message, cache_info)。"""
    headers = {"Content-Type": "application/json"}
    if api_key and api_key != "ollama":
        headers["Authorization"] = f"Bearer {api_key}"

    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.8,
        "max_tokens": 4096,
        "stream": False,

        "response_format": {"type": "json_object"},
        # "thinking": {"type": "disabled"}
    }

    api_url = chat_completions_url(base_url)
    cache_info: dict = {}

    try:
        resp = await client.post(api_url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
        content = data["choices"][0]["message"]["content"]

        usage = data.get("usage", {})
        cache_info = {
            "prompt_tokens": usage.get("prompt_tokens", 0),
            "completion_tokens": usage.get("completion_tokens", 0),
            "prompt_cache_hit_tokens": usage.get("prompt_cache_hit_tokens", 0),
            "prompt_cache_miss_tokens": usage.get("prompt_cache_miss_tokens", 0),
        }
        return content, None, cache_info
    except httpx.TimeoutException:
        return None, f"LLM 调用超时 ({model} @ {base_url})", cache_info
    except httpx.HTTPStatusError as e:
        detail = ""
        try:
            detail = e.response.text[:500]
        except Exception:
            pass
        logger.error(f"LLM HTTP {e.response.status_code}: {detail}")
        return None, f"LLM HTTP {e.response.status_code}: {detail[:200]}", cache_info
    except Exception as e:
        logger.error(f"LLM 调用异常: {type(e).__name__}: {e}")
        return None, f"{type(e).__name__}: {str(e)[:200]}", cache_info


async def call_llm(messages: list[dict]) -> tuple[Optional[dict], dict]:
    """
    调用 LLM 获取世界计划。带重试机制。
    返回 (解析后的 JSON 或 None, cache_info)。
    """
    base_url, api_key, model = _get_config()

    empty_cache: dict = {}
    if not base_url or not model:
        logger.warning("LLM 配置不完整，跳过调用")
        return None, empty_cache

    last_error = None
    latest_cache: dict = {}

    async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
        for attempt in range(1, MAX_RETRIES + 1):
            content, error, cache_info = await _single_llm_call(
                client, base_url, api_key, model, messages,
            )
            latest_cache = cache_info

            if error:
                last_error = error
                logger.warning(f"LLM 调用失败 (第 {attempt}/{MAX_RETRIES} 次): {error}")
                if attempt < MAX_RETRIES:
                    await asyncio.sleep(RETRY_BASE_DELAY * attempt)
                continue

            result = _parse_llm_response(content)

            if result and "plan" in result:
                hit = cache_info.get("prompt_cache_hit_tokens", 0)
                miss = cache_info.get("prompt_cache_miss_tokens", 0)
                total = hit + miss
                rate = f"{hit}/{total} ({hit * 100 // total:.0f}%)" if total > 0 else "n/a"
                logger.info(f"LLM KV cache 命中: {rate}")
                return result, cache_info

            logger.warning(
                f"LLM 返回格式无效 (第 {attempt}/{MAX_RETRIES} 次): "
                f"{content[:150] if content else '(空)'}"
            )
            last_error = f"JSON 解析失败: {content[:100] if content else '(空)'}"

            if attempt < MAX_RETRIES:
                # 在最后一条 user message 后追加格式修正要求
                messages.append({
                    "role": "user",
                    "content": "【重要】你上一次的回复不是有效的 JSON 格式。请严格只输出 JSON，不要添加任何 markdown 标记或额外说明文字。",
                })
                await asyncio.sleep(RETRY_BASE_DELAY * attempt)

    logger.error(f"LLM 调用最终失败 ({model} @ {base_url}): {last_error}")
    return None, latest_cache
