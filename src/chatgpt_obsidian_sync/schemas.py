from pydantic import AliasChoices, BaseModel, Field, field_validator


class AssetRefIn(BaseModel):
    kind: str = "image"
    local_relative_path: str = Field(min_length=1)


class MessageIn(BaseModel):
    id: str = Field(validation_alias=AliasChoices("id", "message_id"), min_length=1)
    conversation_id: str | None = Field(default=None)
    role: str = Field(min_length=1)
    content: str = Field(default="", validation_alias=AliasChoices("content", "text"))
    position: int = Field(default=0, validation_alias=AliasChoices("position", "order_index"), ge=0)
    assets: list[AssetRefIn] = Field(default_factory=list)

    @field_validator("role")
    @classmethod
    def normalize_role(cls, value: str) -> str:
        role = value.strip().lower()
        if role in {"user", "assistant", "system"}:
            return role
        return "assistant"


class ConversationIn(BaseModel):
    conversation_id: str = Field(min_length=1)
    title: str = Field(default="Untitled Chat", min_length=1)
    messages: list[MessageIn]
    source: str = "extension-content-realtime"
    is_partial_snapshot: bool = True


class AssetUploadIn(BaseModel):
    conversation_id: str = Field(min_length=1)
    title: str = Field(default="Untitled Chat", min_length=1)
    message_id: str = Field(min_length=1)
    source_url: str = ""
    mime_type: str = "application/octet-stream"
    base64_data: str = Field(min_length=1)
    suggested_ext: str = ""


class SaveResult(BaseModel):
    saved: int
    skipped: int
