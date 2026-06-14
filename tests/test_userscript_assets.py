from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read_userscript() -> str:
    return (ROOT / "userscript" / "chatgpt-obsidian-sync.user.js").read_text(
        encoding="utf-8"
    )


def test_userscript_collects_and_uploads_current_page_images():
    script = read_userscript()

    assert "const ASSET_URL = \"http://127.0.0.1:8765/api/assets\"" in script
    assert "function shouldCollectImage" in script
    assert "async function collectImageAsset" in script
    assert "imgElement.currentSrc || imgElement.src" in script
    assert "src.startsWith(\"data:image/\")" in script
    assert "src.startsWith(\"blob:\") || src.startsWith(\"https:\")" in script
    assert "fetch(src, { credentials: \"include\" })" in script
    assert "base64_data: base64Data" in script
    assert "local_relative_path: result.local_relative_path" in script
    assert "image asset sync failed" in script


def test_userscript_is_marked_as_legacy_fallback():
    script = read_userscript()

    assert "Legacy developer fallback only" in script
    assert "Legacy only, not recommended for production sync." in script


def test_userscript_filters_favicons_icons_svg_and_small_link_preview_images():
    script = read_userscript()

    assert "google.com/s2/favicons" in script
    assert "data:image/svg+xml" in script
    assert ".endsWith(\".svg\")" in script
    assert "naturalWidth < 128 || naturalHeight < 128" in script
    assert "closest(\"a\")" in script
    assert "naturalWidth < 160 || naturalHeight < 160" in script
    assert "button, nav, header, footer" in script
    assert "role=\"button\"" in script
    assert "avatar" in script
    assert "favicon" in script
    assert "DEBUG_ASSETS = false" in script


def test_userscript_message_payload_includes_assets_without_blocking_text_sync():
    script = read_userscript()

    assert "assets: await collectImagesForMessage" not in script
    assert "const assets = await collectImagesForMessage" in script
    assert "assets," in script
    assert "syncInProgress" in script
    assert "window.setTimeout(async () =>" in script
    assert "assets processed:" in script
