"""A profile created in the web client, exported as a backup, restored by Delta Chat core."""

from pathlib import Path

from deltachat_rpc_client import DeltaChat
from playwright.sync_api import expect

from helpers import PNG, RELAY_IP, addr_of, message_action, open_chat, own_state, transport, wait_own_msg, wait_text, web_send


def test_export_restores_in_core(web, dora, rpc, tmp_path):
    page = web.page
    web_send(page, "question\nin two lines")
    question = wait_text(dora.acc, "question\nin two lines")
    dora.chat.send_message(text="hello web", quoted_msg=question.id)
    expect(page.locator(".msg.in", has_text="hello web").locator(".quote")).to_be_visible()
    message_action(page, page.locator(".msg.in", has_text="hello web"), "Pin")
    expect(page.locator(".pinbar")).to_contain_text("hello web")
    message_action(page, page.locator(".msg.in", has_text="hello web"), "Save")
    expect(page.locator(".msg.in", has_text="hello web").get_by_role("img", name="Saved")).to_be_visible()
    png = tmp_path / "dot.png"
    png.write_bytes(PNG)
    page.locator('.composer input[type="file"]').set_input_files(str(png))
    web_send(page, "hello dora")
    read = wait_text(dora.acc, "hello dora")
    dora.acc.mark_seen_messages([dora.acc.get_message_by_id(read.id)])
    expect(own_state(page, "hello dora")).to_have_attribute("data-state", "read")
    page.get_by_role("button", name="New group").click()
    page.locator("dialog .field input").fill("Export group")
    page.locator("dialog .members label", has_text="Dora").locator("input").check()
    page.get_by_role("button", name="Create", exact=True).click()
    expect(page.locator(".info", has_text="Group created")).to_be_visible()
    web_send(page, "group from web")
    dora_group = dora.acc.get_chat_by_id(wait_text(dora.acc, "group from web").chat_id)

    unsecured = page.locator(".profile .icon-button.attention")
    expect(unsecured).to_be_visible()
    page.get_by_role("button", name="Edit profile").click()
    expect(page.locator("dialog")).to_contain_text("only in this browser")
    page.get_by_role("button", name="Export backup").click()
    with page.expect_download() as download:
        page.get_by_role("button", name="Download").click()
    backup = tmp_path / download.value.suggested_filename
    download.value.save_as(backup)
    expect(unsecured).to_have_count(0)
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
        chats = {c.get_basic_snapshot().name: c for c in restored.get_chatlist()}
        assert {"Dora", "Export group", "Phone", "Saved messages"} <= set(chats), list(chats)
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
