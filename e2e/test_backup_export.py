"""A profile created in the web client, exported as a backup, restored by Delta Chat core."""

from pathlib import Path

from deltachat_rpc_client import DeltaChat, EventType
from playwright.sync_api import expect

from helpers import PNG, RELAY_IP, addr_of, message_action, new_chat, open_chat, own_state, set_passphrase, solid_png, transport, wait_event, wait_own_msg, wait_text, web_send


def test_export_restores_in_core(web, dora, rpc, make_account, tmp_path):
    page = web.page
    (tmp_path / "dora.png").write_bytes(solid_png(64, 64))
    dora.acc.set_config("selfavatar", str(tmp_path / "dora.png"))
    web_send(page, "question\nin two lines")
    question = wait_text(dora.acc, "question\nin two lines")
    dora.chat.send_message(text="hello web", quoted_msg=question.id)
    expect(page.locator(".msg.in", has_text="hello web").locator(".quote")).to_be_visible()
    message_action(page, page.locator(".msg.in", has_text="hello web"), "Pin")
    expect(page.locator(".pinbar")).to_contain_text("hello web")
    message_action(page, page.locator(".msg.in", has_text="hello web"), "Save")
    expect(page.locator(".msg.in", has_text="hello web").get_by_role("button", name="Show in saved messages")).to_be_visible()
    png = tmp_path / "dot.png"
    png.write_bytes(PNG)
    page.locator('.composer input[type="file"]').set_input_files(str(png))
    web_send(page, "hello dora")
    read = wait_text(dora.acc, "hello dora")
    dora.acc.mark_seen_messages([dora.acc.get_message_by_id(read.id)])
    expect(own_state(page, "hello dora")).to_have_attribute("data-state", "read")
    new_chat(page, "New group")
    (tmp_path / "group.png").write_bytes(solid_png(64, 64))
    page.locator("dialog input[type=file]").set_input_files(str(tmp_path / "group.png"))
    page.locator("dialog .field input").fill("Export group")
    page.locator("dialog .members label", has_text="Dora").locator("input").check()
    page.get_by_role("button", name="Create", exact=True).click()
    expect(page.locator(".info", has_text="Group created")).to_be_visible()
    web_send(page, "group from web")
    page.locator(".chatlist li[data-chat]", has_text="Export group").click(button="right")
    page.locator(".menu").get_by_role("menuitem", name="Pin chat").click()
    expect(page.locator(".chatlist li", has_text="Export group").get_by_role("img", name="Pinned chat")).to_be_visible()
    page.locator(".chatlist li[data-chat]", has_text="Export group").click(button="right")
    page.locator(".menu").get_by_role("menuitem", name="Disappearing messages").click()
    page.locator("dialog select").select_option(label="1 week")
    page.get_by_role("button", name="Save", exact=True).click()
    expect(page.locator(".messages .info", has_text="You set disappearing messages to 1 week.")).to_be_visible()
    dora_group = dora.acc.get_chat_by_id(wait_text(dora.acc, "group from web").chat_id)
    open_chat(page, "Phone")
    page.locator(".chathead").get_by_role("button", name="Edit chat").click()
    page.locator("dialog input").fill("My phone")
    page.get_by_role("button", name="Save", exact=True).click()
    expect(page.locator(".chathead strong")).to_have_text("My phone")
    erin = make_account("Erin")
    new_chat(page, "Add contact")
    page.locator("dialog textarea").fill(erin.get_qr_code())
    page.get_by_role("button", name="Connect").click()
    wait_event(erin, EventType.SECUREJOIN_INVITER_PROGRESS, lambda e: e.progress == 1000)
    page.locator(".chathead").get_by_role("button", name="Edit chat").click()
    page.locator("dialog").get_by_role("button", name="Block contact").click()
    page.locator("dialog", has_text="Block this contact?").get_by_role("button", name="Block contact").click()
    expect(page.locator(".chatlist li[data-chat]", has_text="Erin")).to_have_count(0)

    page.get_by_role("button", name="Settings").click()
    (tmp_path / "webby.png").write_bytes(solid_png(64, 64))
    page.locator(".settings input[type=file]").set_input_files(str(tmp_path / "webby.png"))
    expect(page.locator(".profile .avatar img")).to_be_visible()

    unsecured = page.locator(".profile .icon-button.attention")
    expect(unsecured).to_be_visible()
    page.get_by_role("button", name="Settings").click()
    expect(page.locator(".settings")).to_contain_text("only in this browser")
    page.get_by_role("button", name="Export backup").click()
    with page.expect_download() as download:
        page.get_by_role("button", name="Download").click()
    backup = tmp_path / download.value.suggested_filename
    download.value.save_as(backup)
    expect(unsecured).to_have_count(0)
    expect(page.locator(".settings")).not_to_contain_text("only in this browser")
    assert backup.name.startswith("delta-chat-backup-") and backup.suffix == ".tar", backup.name

    restored = DeltaChat(rpc).add_account()
    try:
        restored.import_backup(backup)
        login = restored.list_transports()[0]
        assert login["addr"] == web.addr, login
        if RELAY_IP:
            restored.add_or_update_transport(transport(web.addr, login["password"]))
        restored.start_io()
        assert restored.get_config("displayname") == "Webby"
        assert restored.get_config("selfavatar")
        chats = {c.get_basic_snapshot().name: c for c in restored.get_chatlist()}
        assert {"Dora", "Export group", "My phone", "Saved messages"} <= set(chats), list(chats)
        assert "Erin" not in chats
        assert [c.address for c in restored.get_blocked_contacts()] == [addr_of(erin)]
        phone = restored.get_contact_by_addr(addr_of(web.phone)).get_snapshot()
        assert (phone.name, phone.auth_name) == ("My phone", "Phone"), phone
        assert chats["Export group"].get_basic_snapshot().pinned
        assert chats["Export group"].get_basic_snapshot().profile_image
        assert rpc.get_chat_ephemeral_timer(restored.id, chats["Export group"].id) == 604_800
        assert restored.get_contact_by_addr(addr_of(dora.acc)).get_snapshot().last_seen > 0
        assert restored.get_contact_by_addr(addr_of(dora.acc)).get_snapshot().profile_image
        snaps = [m.get_snapshot() for m in chats["Dora"].get_messages()]
        assert {"hello web", "hello dora"} <= {s.text for s in snaps}
        quoted = next(s for s in snaps if s.text == "hello web")
        assert quoted.quote.text == "question\nin two lines", quoted.quote
        assert restored.get_message_by_id(quoted.quote.message_id).get_snapshot().text == "question\nin two lines"
        assert rpc.get_pinned_messages(restored.id, chats["Dora"].id) == [quoted.id]
        copy = restored.get_message_by_id(quoted.saved_message_id).get_snapshot()
        assert copy.chat_id == chats["Saved messages"].id and copy.original_msg_id == quoted.id, copy
        pic = next(s for s in snaps if s.text == "hello dora")
        assert pic.file_name == "dot.png" and Path(pic.file).read_bytes() == PNG, pic
        receipts = rpc.get_message_read_receipts(restored.id, pic.id)
        dora_id = restored.get_contact_by_addr(addr_of(dora.acc)).id
        assert [r["contactId"] for r in receipts] == [dora_id], receipts
        contact = restored.get_contact_by_addr(addr_of(dora.acc)).get_snapshot()
        assert contact.is_key_contact and contact.e2ee_avail, contact

        chats["Dora"].send_text("from the restored phone")
        snap = wait_text(dora.acc, "from the restored phone")
        assert snap.chat_id == dora.chat.id and snap.show_padlock, snap
        open_chat(page, "Dora")
        expect(page.locator(".msg.out", has_text="from the restored phone")).to_be_visible()
        chats["Export group"].send_text("group from the phone")
        assert wait_text(dora.acc, "group from the phone").chat_id == dora_group.id

        dora.chat.send_text("dora to both")
        wait_text(restored, "dora to both")
        expect(page.locator(".msg.in", has_text="dora to both")).to_be_visible()
        web_send(page, "web after export")
        assert wait_own_msg(restored, "web after export").chat_id == chats["Dora"].id
    finally:
        restored.stop_io()
        restored.remove()


def test_nicknames_sync_between_browsers(web, dora, browser, tmp_path):
    page = web.page
    page.get_by_role("button", name="Settings").click()
    page.get_by_role("button", name="Export backup").click()
    with page.expect_download() as download:
        page.get_by_role("button", name="Download").click()
    backup = tmp_path / download.value.suggested_filename
    download.value.save_as(backup)
    page.keyboard.press("Escape")
    open_chat(page, "Dora")

    other = browser.new_context().new_page()
    set_passphrase(other)
    other.locator('.import input[type="file"]').set_input_files(str(backup))
    expect(other.locator(".status.ok")).to_be_visible()
    other_entry = other.locator(".chatlist li[data-chat] strong", has_text="Dora")
    expect(other_entry).to_have_text("Dora")

    page.locator(".chathead").get_by_role("button", name="Edit chat").click()
    page.locator("dialog input").fill("Dora from work")
    page.get_by_role("button", name="Save", exact=True).click()
    expect(other_entry).to_have_text("Dora from work")
    open_chat(other, "Dora")
    expect(other.locator(".chathead strong")).to_have_text("Dora from work")

    other.locator(".chathead").get_by_role("button", name="Edit chat").click()
    other.locator("dialog input").fill("Dora at home")
    other.get_by_role("button", name="Save", exact=True).click()
    expect(page.locator(".chatlist li[data-chat] strong", has_text="Dora")).to_have_text("Dora at home")
    expect(page.locator(".chathead strong")).to_have_text("Dora at home")
