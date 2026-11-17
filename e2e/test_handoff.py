"""A new web profile handed over to Delta Chat core through the invite service."""

import base64

import pytest
from deltachat_rpc_client import DeltaChat, EventType
from playwright.sync_api import expect

from helpers import (INVITE, RELAY, RELAY_IP, addr_of, open_chat, set_passphrase, transport, wait_event,
                     wait_own_msg, wait_text, web_send)

pytestmark = pytest.mark.local_relay


@pytest.fixture
def page(page):
    page.route("**/config.json", lambda route: route.fulfill(json={"handoffUrl": INVITE}))
    return page


def create_web_profile(page):
    set_passphrase(page)
    page.locator(".field", has_text="Display name").locator("input").fill("Webby")
    page.locator(".field", has_text="Chatmail relay").locator("input").fill(RELAY)
    page.get_by_role("button", name="Create profile").click()
    expect(page.get_by_role("heading", name="Use it on your phone too")).to_be_visible()
    return page.get_by_role("link", name="Open the link instead").get_attribute("href")


def save_on_phone(context, url, tmp_path):
    phone = context.new_page()
    phone.goto(url)
    with phone.expect_download() as download:
        phone.get_by_role("button", name="Save profile file").click()
    path = tmp_path / download.value.suggested_filename
    download.value.save_as(path)
    return phone, path


def restore(rpc, backup, addr):
    restored = DeltaChat(rpc).add_account()
    restored.import_backup(backup)
    login = restored.list_transports()[0]
    assert login["addr"] == addr, login
    if RELAY_IP:
        restored.add_or_update_transport(transport(addr, login["password"]))
    restored.start_io()
    return restored


def test_handoff_survives_a_link_preview(page, context, tmp_path):
    url = create_web_profile(page)
    # Previews fetch links without a click; some run the page's scripts.
    preview = context.new_page()
    preview.goto(url)
    preview.wait_for_load_state("networkidle")
    preview.close()
    page_url = url.split("#", 1)[0]
    assert context.request.get(page_url).ok
    assert context.request.get(page_url + "/data").status == 405
    expect(page.locator(".phone-setup .ok")).to_have_count(0)

    _, backup = save_on_phone(context, url, tmp_path)
    assert backup.stat().st_size > 0
    expect(page.locator(".phone-setup .ok")).to_contain_text("Your phone has the profile")


def test_handoff_at_signup(page, context, rpc, tmp_path):
    url = create_web_profile(page)
    assert url.startswith(INVITE + "h/") and "#" in url, url
    _, backup = save_on_phone(context, url, tmp_path)
    assert backup.name.startswith("delta-chat-backup-") and backup.suffix == ".tar", backup.name
    expect(page.locator(".phone-setup .ok")).to_contain_text("Your phone has the profile")
    page.get_by_role("button", name="Continue").click()
    expect(page.locator(".chatlist")).to_be_visible()
    expect(page.locator(".profile .icon-button.attention")).to_have_count(0)

    restored = restore(rpc, backup, page.locator(".profile small").inner_text())
    try:
        saved = restored.get_contact_by_id(1).create_chat()
        saved.send_text("note from the phone")
        open_chat(page, "Saved messages")
        expect(page.locator(".msg", has_text="note from the phone")).to_be_visible()
        web_send(page, "note from the browser")
        assert wait_own_msg(restored, "note from the browser").chat_id == saved.id
        expect(page.locator(".key-warning")).to_be_hidden()
    finally:
        restored.stop_io()
        restored.remove()


def test_handoff_from_profile_keeps_contacts(page, context, rpc, make_account, tmp_path):
    create_web_profile(page)
    page.get_by_role("button", name="Continue").click()
    expect(page.get_by_role("heading", name="Back up your profile")).to_be_visible()
    page.get_by_role("button", name="Later").click()
    unsecured = page.locator(".profile .icon-button.attention")
    expect(unsecured).to_be_visible()
    dora = make_account("Dora")
    page.get_by_role("button", name="Add contact").click()
    page.locator("dialog textarea").fill(dora.get_qr_code())
    page.get_by_role("button", name="Connect").click()
    ev = wait_event(dora, EventType.SECUREJOIN_INVITER_PROGRESS, lambda e: e.progress == 1000)
    dora_chat = dora.get_chat_by_contact(ev.contact_id)

    page.get_by_role("button", name="Edit profile").click()
    page.get_by_role("button", name="Set up phone").click()
    url = page.locator("dialog").get_by_role("link", name="Open the link instead").get_attribute("href")
    _, backup = save_on_phone(context, url, tmp_path)
    expect(page.locator("dialog .phone-setup .ok")).to_be_visible()
    page.locator("dialog").get_by_role("button", name="Close").click()
    expect(unsecured).to_have_count(0)

    restored = restore(rpc, backup, page.locator(".profile small").inner_text())
    try:
        restored.get_contact_by_addr(addr_of(dora)).create_chat().send_text("from the phone")
        assert wait_text(dora, "from the phone").chat_id == dora_chat.id
        open_chat(page, "Dora")
        expect(page.locator(".msg.out", has_text="from the phone")).to_be_visible()
        web_send(page, "from the browser")
        assert wait_text(dora, "from the browser").chat_id == dora_chat.id
    finally:
        restored.stop_io()
        restored.remove()


def test_handoff_works_once(page, context, tmp_path):
    url = create_web_profile(page)
    save_on_phone(context, url, tmp_path)
    again = context.new_page()
    assert again.goto(url).status == 410
    expect(again.locator("h1")).to_have_text("This code has expired")


def test_handoff_needs_the_account_password(context):
    assert context.request.get(INVITE + "handoff").json() == {"domain": RELAY}
    auth = base64.b64encode(f"nobody@{RELAY}:wrong".encode()).decode()
    res = context.request.post(INVITE + "handoff", headers={"Authorization": f"Basic {auth}"}, data=b"x" * 64)
    assert res.status == 403
