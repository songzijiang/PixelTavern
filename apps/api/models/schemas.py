from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class NPCStateSnapshot(BaseModel):
    key: str
    name: str
    personality: str
    current_action: str
    x: int
    y: int
    facing: str


class DialogueRecord(BaseModel):
    sec: int
    speaker: str
    line: str
    to: Optional[str] = None


class WorldTickRequest(BaseModel):
    tick: int
    current_topic: str = ""
    npc_states: list[NPCStateSnapshot]
    dialogue_history: list[DialogueRecord]
    occupied_chairs: dict[str, str]
    available_chairs: list[int]
    user_message: str = ""


class NPCAction(BaseModel):
    sec: int
    action: str
    duration_sec: Optional[float] = None
    line: Optional[str] = None
    to: Optional[str] = None
    x: Optional[int] = None
    y: Optional[int] = None
    emote: Optional[str] = None


class NPCTimeline(BaseModel):
    npc: str
    actions: list[NPCAction]


class CacheInfo(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    prompt_cache_hit_tokens: int = 0
    prompt_cache_miss_tokens: int = 0


class WorldTickResponse(BaseModel):
    tick: int
    topic: str = ""
    plan: list[NPCTimeline]
    cache: CacheInfo = Field(default_factory=CacheInfo)
    user_guidance: str = ""


class LLMSettings(BaseModel):
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    configured: bool = False
    daily_news_guidance_enabled: bool = False


class WorldPromptSettings(BaseModel):
    preset_key: str = ""
    story_background: str = ""
    story_theme: str = ""
    system_prompt: str = ""
    user_prompt: str = ""
    calendar_start: str = ""
    character_overrides: Optional[dict[str, str]] = None
    characters: Optional[list[dict]] = None
    relationship_prompt: Optional[str] = None


class CharacterDefinition(BaseModel):
    key: str
    name: str
    personality: str
    traits: list[str] = []
    speechStyle: str = ""
    folderName: str = ""
    appearance: str = "core"
    backgroundPrompt: str = ""
    relationships: str = ""
    startX: int = 400
    startY: int = 420
    readOnly: bool = False


class CharacterUpdate(BaseModel):
    name: Optional[str] = None
    personality: Optional[str] = None
    traits: Optional[list[str]] = None
    speechStyle: Optional[str] = None
    folderName: Optional[str] = None
    appearance: Optional[str] = None
    backgroundPrompt: Optional[str] = None
    relationships: Optional[str] = None
    startX: Optional[int] = None
    startY: Optional[int] = None


class CharacterCreate(BaseModel):
    key: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,32}$")
    folderName: str
    name: str
    personality: str
    traits: list[str] = []
    speechStyle: str = ""
    appearance: str = "core"
    backgroundPrompt: str = ""
    relationships: str = ""
    startX: int = 400
    startY: int = 420


class ImportRequest(BaseModel):
    data: dict


class ReplayQuery(BaseModel):
    from_segment: int
    to_segment: int
