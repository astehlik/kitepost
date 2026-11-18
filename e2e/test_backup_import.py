"""A Delta Chat core profile imported into the web client from a backup, then used on both devices."""

import re
import sqlite3
import tarfile
import time
from types import SimpleNamespace

import pytest
from deltachat_rpc_client import EventType
from deltachat_rpc_client.const import MessageState
from playwright.sync_api import expect

from helpers import open_chat_info, EVENT_TIMEOUT, PNG, addr_of, mailbox_size, message_action, open_chat, open_profile, own_state, set_nickname, set_passphrase, solid_png, wait_event, wait_own_msg, wait_text, web_send


@pytest.fixture
def imported(page, make_account, tmp_path):
    """The phone's profile with history, exported by core and imported into the web client."""
    phone = make_account("Alice Phone")
    bob = make_account("Bob")
    bob.secure_join(phone.get_qr_code())
    wait_event(phone, EventType.SECUREJOIN_INVITER_PROGRESS, lambda e: e.progress == 1000)
    phone_bob = phone.get_contact_by_addr(addr_of(bob)).create_chat()
    hello_sent = phone_bob.send_text("hello from alice\nsecond line")
    hello = wait_text(bob, "hello from alice\nsecond line")
    bob.mark_seen_messages([bob.get_message_by_id(hello.id)])
    bob_chat = bob.get_chat_by_id(hello.chat_id)
    (tmp_path / "bob.png").write_bytes(solid_png(64, 64))
    bob.set_config("selfavatar", str(tmp_path / "bob.png"))
    bob_chat.send_message(text="reply from bob", quoted_msg=hello.id)
    reply = wait_text(phone, "reply from bob")
    deadline = time.monotonic() + EVENT_TIMEOUT
    while hello_sent.get_snapshot().state != MessageState.OUT_MDN_RCVD:
        assert time.monotonic() < deadline, "the phone got no read receipt from Bob"
        time.sleep(0.2)
    phone._rpc.set_pinned_message_state(phone.id, reply.id, True)
    phone._rpc.save_msgs(phone.id, [hello_sent.id])
    png = tmp_path / "pic.png"
    png.write_bytes(PNG)
    phone_bob.send_file(str(png))
    (tmp_path / "alice.png").write_bytes(solid_png(64, 64))
    phone.set_config("selfavatar", str(tmp_path / "alice.png"))
    phone_saved = phone.get_contact_by_id(1).create_chat()
    phone_saved.send_text("note before export")
    phone_saved.pin()
    group = phone.create_group("Backup group")
    group.set_image(str(tmp_path / "alice.png"))
    group.add_contact(phone.get_contact_by_addr(addr_of(bob)))
    group.send_text("group hello")
    group.set_ephemeral_timer(604_800)
    bob_group = bob.get_chat_by_id(wait_text(bob, "group hello").chat_id)

    backup_dir = tmp_path / "backup"
    backup_dir.mkdir()
    phone.stop_io()
    phone.export_backup(str(backup_dir), "")
    phone.start_io()

    set_passphrase(page)
    page.locator('.import input[type="file"]').set_input_files(str(next(backup_dir.glob("*.tar"))))
    expect(page.locator(".status.ok")).to_be_visible()
    return SimpleNamespace(page=page, phone=phone, bob=bob, phone_bob=phone_bob, bob_chat=bob_chat,
                           phone_saved=phone_saved, bob_group=bob_group, reply=reply)


def test_history_is_imported(imported):
    page = imported.page
    assert page.locator(".profile small").inner_text() == addr_of(imported.phone)
    open_chat(page, "Bob")
    expect(page.locator(".msg.out", has_text="hello from alice")).to_be_visible()
    reply = page.locator(".msg.in", has_text="reply from bob")
    expect(reply.locator(".quote strong")).to_have_text("Me")
    expect(reply.locator(".quote span")).to_have_text("hello from alice\nsecond line")
    expect(reply.locator(".text")).to_have_text("reply from bob")
    expect(page.locator(".msg.out .attachment img")).to_be_visible()
    expect(page.locator(".chathead small")).to_contain_text("Last seen")
    expect(page.locator(".chathead")).not_to_contain_text(addr_of(imported.bob))
    open_chat(page, "Backup group")
    expect(page.locator(".msg.out", has_text="group hello")).to_be_visible()


def test_avatars_are_imported(imported):
    expect(imported.page.locator(".chatlist li[data-chat]", has_text="Bob").locator(".avatar img")).to_be_visible()
    expect(imported.page.locator(".profile .avatar img")).to_be_visible()
    expect(imported.page.locator(".chatlist li[data-chat]", has_text="Backup group").locator(".avatar img")).to_be_visible()


def test_own_avatar_syncs_between_devices(imported, tmp_path):
    page, phone = imported.page, imported.phone
    own = page.locator(".profile .avatar img")
    phone.set_config("selfavatar", None)
    expect(own).to_have_count(0)
    page.get_by_role("button", name="Settings").click()
    (tmp_path / "web.png").write_bytes(solid_png(300, 300))
    page.locator(".settings input[type=file]").set_input_files(str(tmp_path / "web.png"))
    expect(own).to_be_visible()
    deadline = time.monotonic() + EVENT_TIMEOUT
    while not phone.get_config("selfavatar"):
        assert time.monotonic() < deadline, "the phone did not get the avatar"
        time.sleep(0.2)


def test_both_devices_send_and_receive(imported):
    page, phone, bob = imported.page, imported.phone, imported.bob
    open_chat(page, "Bob")
    web_send(page, "sent from the browser")
    assert wait_text(bob, "sent from the browser").chat_id == imported.bob_chat.id
    assert wait_own_msg(phone, "sent from the browser").chat_id == imported.phone_bob.id

    imported.phone_bob.send_text("sent from the phone")
    expect(page.locator(".msg.out", has_text="sent from the phone")).to_be_visible()

    imported.bob_chat.send_text("bob to both")
    expect(page.locator(".msg.in", has_text="bob to both")).to_be_visible()
    wait_text(phone, "bob to both")

    open_chat(page, "Backup group")
    web_send(page, "group from web")
    assert wait_text(bob, "group from web").chat_id == imported.bob_group.id
    expect(page.locator(".key-warning")).to_be_hidden()


def test_read_state_syncs_both_ways(imported):
    page, phone = imported.page, imported.phone
    open_chat(page, "Bob")
    imported.bob_chat.send_text("read me in the browser")
    expect(page.locator(".msg.in", has_text="read me in the browser")).to_be_visible()
    on_phone = wait_text(phone, "read me in the browser")
    deadline = time.time() + 60
    while phone.get_message_by_id(on_phone.id).get_snapshot().state != MessageState.IN_SEEN:
        assert time.time() < deadline, "the phone did not mark the message read"
        time.sleep(0.5)

    open_chat(page, "Backup group")
    imported.bob_chat.send_text("read me on the phone")
    badge = page.locator(".chatlist li", has_text="Bob").locator(".badge")
    expect(badge).to_have_text("1")
    phone.mark_seen_messages([phone.get_message_by_id(wait_text(phone, "read me on the phone").id)])
    expect(badge).to_have_count(0)


def test_saved_messages(imported, rpc):
    page, phone = imported.page, imported.phone
    open_chat(page, "Saved messages")
    expect(page.locator(".msg.out", has_text="note before export")).to_be_visible()
    imported.phone_saved.send_text("note after import")
    expect(page.locator(".msg.out", has_text="note after import")).to_be_visible()
    rpc.save_msgs(phone.id, [imported.reply.id])
    expect(page.locator(".messages .msg", has_text="reply from bob")).to_be_visible()
    web_send(page, "note from the browser")
    assert wait_own_msg(phone, "note from the browser").chat_id == imported.phone_saved.id


def test_read_receipts_with_the_phone_online(imported):
    page, bob = imported.page, imported.bob
    open_chat(page, "Bob")
    web_send(page, "read me, bob")
    snap = wait_text(bob, "read me, bob")
    bob.mark_seen_messages([bob.get_message_by_id(snap.id)])
    expect(own_state(page, "read me, bob")).to_have_attribute("data-state", "read")

    imported.phone_bob.send_text("sent on the phone, read by bob")
    snap = wait_text(bob, "sent on the phone, read by bob")
    bob.mark_seen_messages([bob.get_message_by_id(snap.id)])
    expect(own_state(page, "sent on the phone, read by bob")).to_have_attribute("data-state", "read")


def test_deleting_for_me_syncs_between_devices(imported):
    page, phone = imported.page, imported.phone
    open_chat(page, "Bob")
    reply = page.locator(".msg.in", has_text="reply from bob")
    message_action(page, reply, "Delete message")
    page.locator("dialog").get_by_role("button", name="Delete for me").click()
    expect(reply).to_have_count(0)
    wait_event(phone, EventType.MSG_DELETED, lambda e: e.msg_id == imported.reply.id)

    imported.bob_chat.send_text("delete me on the phone")
    expect(page.locator(".msg.in", has_text="delete me on the phone")).to_be_visible()
    phone.delete_messages([phone.get_message_by_id(wait_text(phone, "delete me on the phone").id)])
    expect(page.locator(".msg.in", has_text="delete me on the phone")).to_have_count(0)


def wait_visibility(chat, archived, pinned):
    deadline = time.monotonic() + EVENT_TIMEOUT
    while (snap := chat.get_basic_snapshot()).archived != archived or snap.pinned != pinned:
        assert time.monotonic() < deadline, f"phone chat: {snap}"
        time.sleep(0.2)


def test_chat_visibility_syncs_between_devices(imported):
    page, phone = imported.page, imported.phone
    entry = page.locator(".chatlist li[data-chat]", has_text="Backup group")
    entry.click(button="right")
    page.locator(".menu").get_by_role("menuitem", name="Archive").click()
    expect(entry).to_have_count(0)
    phone_group = phone.get_chat_by_id(next(c.id for c in phone.get_chatlist() if c.get_basic_snapshot().name == "Backup group"))
    wait_visibility(phone_group, True, False)

    saved = page.locator(".chatlist li[data-chat]", has_text="Saved messages")
    expect(saved.get_by_role("img", name="Pinned chat")).to_be_visible()

    phone_group.unarchive()
    phone_group.pin()
    expect(entry.get_by_role("img", name="Pinned chat")).to_be_visible()


def test_nicknames_sync_between_devices(imported):
    page, phone = imported.page, imported.phone
    bob = phone.get_contact_by_addr(addr_of(imported.bob))
    bob.set_name("Bobby")
    entry = page.locator(".chatlist li[data-chat] strong", has_text="Bob")
    expect(entry).to_have_text("Bobby")

    open_chat(page, "Bobby")
    set_nickname(page, "Bob from work")
    expect(entry).to_have_text("Bob from work")
    wait_contact_name(bob, "Bob from work")

    set_nickname(page, "")
    expect(entry).to_have_text("Bob")
    wait_contact_name(bob, "")


def wait_config(acc, key, value):
    deadline = time.monotonic() + EVENT_TIMEOUT
    while acc.get_config(key) != value:
        assert time.monotonic() < deadline, f"the phone did not set {key} to {value!r}"
        time.sleep(0.2)


def test_display_name_syncs_between_devices(imported):
    page, phone = imported.page, imported.phone
    phone.set_config("displayname", "Alice Laptop")
    expect(page.locator(".profile")).to_contain_text("Alice Laptop")
    page.get_by_role("button", name="Settings").click()
    name = page.locator(".settings .field", has_text="Display name").locator("input")
    expect(name).to_have_value("Alice Laptop")
    name.fill("Alice Web")
    name.press("Enter")
    expect(page.locator(".profile")).to_contain_text("Alice Web")
    wait_config(phone, "displayname", "Alice Web")


def wait_blocked(contact, blocked):
    deadline = time.monotonic() + EVENT_TIMEOUT
    while contact.get_snapshot().is_blocked != blocked:
        assert time.monotonic() < deadline, f"the phone did not see blocked={blocked}"
        time.sleep(0.2)


def test_blocking_syncs_between_devices(imported):
    page, phone = imported.page, imported.phone
    bob = phone.get_contact_by_addr(addr_of(imported.bob))
    entry = page.locator(".chatlist li[data-chat]", has_text="Bob")
    open_chat(page, "Bob")
    open_profile(page).get_by_role("button", name="Block contact").click()
    page.locator("dialog", has_text="Block this contact?").get_by_role("button", name="Block contact").click()
    expect(entry).to_have_count(0)
    wait_blocked(bob, True)

    bob.unblock()
    expect(entry).to_have_count(1)
    bob.block()
    expect(entry).to_have_count(0)


def test_chat_deletion_syncs_between_devices(imported):
    page, phone = imported.page, imported.phone
    open_chat(page, "Backup group")
    settings = open_chat_info(page)
    expect(settings).to_contain_text("Messages are end-to-end encrypted for every member of the group.")
    expect(settings).to_contain_text("here and on your other devices")
    settings.get_by_role("button", name="Delete chat").click()
    page.locator("dialog", has_text="This cannot be undone.").get_by_role("button", name="Delete").click()
    expect(settings).to_have_count(0)
    expect(page.locator(".chatlist li[data-chat]", has_text="Backup group")).to_have_count(0)
    deadline = time.monotonic() + EVENT_TIMEOUT
    while any(c.get_basic_snapshot().name == "Backup group" for c in phone.get_chatlist()):
        assert time.monotonic() < deadline, "the phone kept the deleted group"
        time.sleep(0.2)

    open_chat(page, "Saved messages")
    note = page.locator(".msg", has_text="note before export")
    expect(note).to_be_visible()
    imported.phone_saved.delete()
    expect(note).to_have_count(0)
    expect(page.locator(".chatlist li[data-chat]", has_text="Saved messages")).to_have_count(1)


def test_clearing_a_chat_syncs_between_devices(imported):
    page, phone = imported.page, imported.phone
    open_chat(page, "Bob")
    expect(page.locator(".msg", has_text="reply from bob")).to_be_visible()
    profile = open_profile(page)
    profile.get_by_role("button", name="Clear chat").click()
    page.locator("dialog", has_text="Clear chat?").get_by_role("button", name="Clear chat").click()
    profile.locator(".chathead :is(.back, .close):visible").click()
    expect(page.locator(".messages .msg")).to_have_count(0)
    expect(page.locator(".chatlist li[data-chat]", has_text="Bob")).to_have_count(1)
    deadline = time.monotonic() + EVENT_TIMEOUT
    while any(m.get_snapshot().text in ("reply from bob", "hello from alice\nsecond line") for m in imported.phone_bob.get_messages()):
        assert time.monotonic() < deadline, "the phone kept the messages"
        time.sleep(0.2)


def wait_contact_name(contact, name):
    deadline = time.monotonic() + EVENT_TIMEOUT
    while contact.get_snapshot().name != name:
        assert time.monotonic() < deadline, f"the phone did not rename the contact to {name!r}"
        time.sleep(0.2)


def saved_on_phone(phone, msg_id, saved):
    deadline = time.monotonic() + EVENT_TIMEOUT
    while (phone.get_message_by_id(msg_id).get_snapshot().saved_message_id is not None) != saved:
        assert time.monotonic() < deadline, f"the phone did not see saved={saved}"
        time.sleep(0.2)


def test_saving_syncs_between_devices(imported, rpc):
    page, phone = imported.page, imported.phone
    bob = page.locator(".chatlist li").filter(has=page.get_by_text("Bob", exact=True))
    bob.click()
    reply = page.locator(".msg.in", has_text="reply from bob")
    message_action(page, reply, "Save")
    expect(reply.get_by_role("button", name="Show in saved messages")).to_be_visible()
    saved_on_phone(phone, imported.reply.id, True)
    copy = phone.get_message_by_id(phone.get_message_by_id(imported.reply.id).get_snapshot().saved_message_id).get_snapshot()
    assert copy.chat_id == imported.phone_saved.id and copy.text == "reply from bob", copy
    open_chat(page, "Saved messages")
    expect(page.locator(".messages .msg", has_text="reply from bob")).to_be_visible()

    bob.click()
    message_action(page, reply, "Remove from saved")
    expect(reply.get_by_role("button", name="Show in saved messages")).to_have_count(0)
    saved_on_phone(phone, imported.reply.id, False)

    imported.bob_chat.send_text("saved on the phone")
    on_phone = wait_text(phone, "saved on the phone")
    incoming = page.locator(".msg.in", has_text="saved on the phone")
    expect(incoming).to_be_visible()
    rpc.save_msgs(phone.id, [on_phone.id])
    expect(incoming.get_by_role("button", name="Show in saved messages")).to_be_visible()
    message_action(page, incoming, "Remove from saved")
    saved_on_phone(phone, on_phone.id, False)


def test_receive_times_and_read_receipts_are_imported(imported):
    page = imported.page
    open_chat(page, "Bob")
    own = page.locator(".msg.out", has_text="hello from alice")
    message_action(page, own, "Message info")
    expect(page.locator("dialog")).to_contain_text("Read by")
    expect(page.locator("dialog")).to_contain_text("Bob")
    page.locator("dialog").get_by_role("button", name="Close").click()

    received = imported.phone.get_message_by_id(imported.reply.id).get_snapshot().received_timestamp
    shown = page.evaluate("ts => new Date(ts * 1000).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'medium' })", received)
    reply = page.locator(".msg.in", has_text="reply from bob")
    message_action(page, reply, "Message info")
    expect(page.locator("dialog dd").nth(1)).to_have_text(shown)


def test_pins_are_imported(imported):
    page = imported.page
    open_chat(page, "Bob")
    reply = page.locator(".msg.in", has_text="reply from bob")
    expect(reply.get_by_role("img", name="Pinned")).to_be_visible()
    expect(page.locator(".pinbar")).to_contain_text("reply from bob")
    page.locator(".messages .info", has_text="You pinned a message.").click()
    expect(reply).to_have_class(re.compile("flash"))


def test_last_seen_is_imported(imported):
    page = imported.page
    expect(page.locator(".chatlist li[data-chat]", has_text="Bob").first.locator(".avatar.seen")).to_be_visible()


def test_disappearing_messages_are_imported(imported):
    page = imported.page
    open_chat(page, "Backup group")
    expect(page.get_by_role("button", name="Disappearing messages: 1 week")).to_be_visible()


def test_pins_from_the_phone(imported):
    page, phone = imported.page, imported.phone
    open_chat(page, "Bob")
    reply = page.locator(".msg.in", has_text="reply from bob")
    phone._rpc.set_pinned_message_state(phone.id, imported.reply.id, False)
    expect(page.locator(".messages .info", has_text="You unpinned a message.")).to_be_visible()
    expect(reply.get_by_role("img", name="Pinned")).to_have_count(0)
    phone._rpc.set_pinned_message_state(phone.id, imported.reply.id, True)
    expect(reply.get_by_role("img", name="Pinned")).to_be_visible()


def test_saved_copies_are_imported(imported):
    page = imported.page
    open_chat(page, "Bob")
    own = page.locator(".msg.out", has_text="hello from alice")
    expect(own.get_by_role("button", name="Show in saved messages")).to_be_visible()
    message_action(page, own, "Remove from saved")
    open_chat(page, "Saved messages")
    expect(page.locator(".messages .msg", has_text="hello from alice")).to_have_count(0)


@pytest.mark.local_relay
def test_pins_from_before_kitepost_knew_them_are_repaired(page, make_account, tmp_path):
    phone = make_account("Alice Phone")
    bob = make_account("Bob")
    bob.secure_join(phone.get_qr_code())
    wait_event(phone, EventType.SECUREJOIN_INVITER_PROGRESS, lambda e: e.progress == 1000)
    bob.get_chat_by_id(bob.get_contact_by_addr(addr_of(phone)).create_chat().id).send_text("pin me later")
    pinned = wait_text(phone, "pin me later")
    # With a second device, as in real use, core keeps a copy of its own messages in INBOX.
    phone.set_config("bcc_self", "1")
    phone._rpc.set_pinned_message_state(phone.id, pinned.id, True)
    deadline = time.monotonic() + EVENT_TIMEOUT
    while not mailbox_size(addr_of(phone)):
        assert time.monotonic() < deadline, "the copy of the pin message did not reach the server"
        time.sleep(0.2)
    phone.stop_io()
    phone.export_backup(str(tmp_path), "")
    phone.start_io()

    # The state Kitepost kept before it knew pins: nothing pinned, the pin message as a plain one.
    backup = next(tmp_path.glob("*.tar"))
    with tarfile.open(backup) as tar:
        tar.extractall(tmp_path / "old", filter="data")
    db = sqlite3.connect(tmp_path / "old" / "dc_database_backup.sqlite")
    db.execute("UPDATE msgs SET pinned = 0")
    assert db.execute("UPDATE msgs SET param = '' WHERE txt = 'You pinned a message.'").rowcount == 1
    db.commit()
    db.close()
    old = tmp_path / "old.tar"
    with tarfile.open(old, "w") as tar:
        for f in sorted((tmp_path / "old").rglob("*")):
            tar.add(f, arcname=str(f.relative_to(tmp_path / "old")), recursive=False)

    set_passphrase(page)
    page.locator('.import input[type="file"]').set_input_files(str(old))
    expect(page.locator(".status.ok")).to_be_visible()
    page.locator(".chatlist li[data-chat]", has_text="Bob").click()
    expect(page.locator(".msg.in", has_text="pin me later").get_by_role("img", name="Pinned")).to_be_visible()
    expect(page.locator(".messages .info", has_text="You pinned a message.")).to_be_visible()
    expect(page.locator(".msg.out", has_text="You pinned a message.")).to_have_count(0)



def test_nicknames_are_imported(page, make_account, tmp_path):
    phone = make_account("Alice Phone")
    bob = make_account("Bob")
    bob.secure_join(phone.get_qr_code())
    wait_event(phone, EventType.SECUREJOIN_INVITER_PROGRESS, lambda e: e.progress == 1000)
    phone.get_contact_by_addr(addr_of(bob)).set_name("Bobby")
    phone.stop_io()
    phone.export_backup(str(tmp_path), "")
    phone.start_io()

    set_passphrase(page)
    page.locator('.import input[type="file"]').set_input_files(str(next(tmp_path.glob("*.tar"))))
    expect(page.locator(".status.ok")).to_be_visible()
    open_chat(page, "Bobby")
    bob.get_contact_by_addr(addr_of(phone)).create_chat().send_text("hello after the import")
    expect(page.locator(".msg.in", has_text="hello after the import")).to_be_visible()
    expect(page.locator(".chathead strong")).to_have_text("Bobby")
    profile = open_profile(page)
    expect(profile.get_by_role("textbox", name="Name")).to_have_value("Bobby")
    expect(profile).to_contain_text("“Bob”")
