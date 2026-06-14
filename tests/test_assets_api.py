import base64

from fastapi.testclient import TestClient

from chatgpt_obsidian_sync.app import create_app


PNG_1X1 = base64.b64encode(
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"
    b"\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4"
    b"\x89\x00\x00\x00\nIDATx\x9cc\xf8\x0f\x00\x01\x01"
    b"\x01\x00\x18\xdd\x8d\xb0\x00\x00\x00\x00IEND\xaeB`\x82"
).decode("ascii")


def test_post_asset_saves_base64_png_and_dedupes(sample_config, tmp_path):
    client = TestClient(create_app(sample_config, config_path=tmp_path / "config.json"))

    payload = {
        "conversation_id": "conv-img",
        "title": "Image Chat",
        "message_id": "msg-1",
        "source_url": "data:image/png;base64,redacted",
        "mime_type": "image/png",
        "base64_data": PNG_1X1,
        "suggested_ext": ".png",
    }

    first = client.post("/api/assets", json=payload)
    second = client.post("/api/assets", json=payload)

    assert first.status_code == 200
    assert first.json()["ok"] is True
    assert first.json()["local_relative_path"].startswith("assets/img-")
    assert first.json()["local_relative_path"].endswith(".png")
    assert second.json()["local_relative_path"] == first.json()["local_relative_path"]

    asset_path = (
        sample_config.vault_path
        / "AI"
        / "_ChatGPTSyncTest"
        / "Image Chat - conv-img"
        / first.json()["local_relative_path"]
    )
    assert asset_path.exists()

    assets_dir = asset_path.parent
    assert len(list(assets_dir.glob("img-*.png"))) == 1


def test_export_includes_image_wiki_links_after_message_text(sample_config, tmp_path):
    client = TestClient(create_app(sample_config, config_path=tmp_path / "config.json"))

    asset = client.post(
        "/api/assets",
        json={
            "conversation_id": "conv-img-md",
            "title": "Markdown Images",
            "message_id": "assistant-1",
            "source_url": "data:image/png;base64,redacted",
            "mime_type": "image/png",
            "base64_data": PNG_1X1,
            "suggested_ext": ".png",
        },
    ).json()

    response = client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-img-md",
            "title": "Markdown Images",
            "messages": [
                {
                    "id": "assistant-1",
                    "role": "assistant",
                    "content": "Here is the generated image.",
                    "position": 0,
                    "assets": [
                        {
                            "kind": "image",
                            "local_relative_path": asset["local_relative_path"],
                        }
                    ],
                }
            ],
        },
    )

    assert response.status_code == 200
    part = (
        sample_config.vault_path
        / "AI"
        / "_ChatGPTSyncTest"
        / "Markdown Images - conv-img-md"
        / "part-001.md"
    )
    markdown = part.read_text(encoding="utf-8")

    assert markdown == (
        "## 🤖 Assistant\n\n"
        "Here is the generated image.\n\n"
        f"![[{asset['local_relative_path']}]]\n"
    )
