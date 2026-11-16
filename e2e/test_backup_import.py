"""A Delta Chat core profile imported into the web client from a backup, then used on both devices."""

import re
import time
from types import SimpleNamespace

import pytest
from deltachat_rpc_client import EventType
from deltachat_rpc_client.const import MessageState
from playwright.sync_api import expect

from helpers import EVENT_TIMEOUT, PNG, addr_of, message_action, open_chat, own_state, set_passphrase, wait_event, wait_own_msg, wait_text, web_send


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
    phone_saved = phone.get_contact_by_id(1).create_chat()
    phone_saved.send_text("note before export")
    group = phone.create_group("Backup group")
    group.add_contact(phone.get_contact_by_addr(addr_of(bob)))
    group.send_text("group hello")
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
    expect(page.locator(".chathead small")).to_contain_text(addr_of(imported.bob))
    open_chat(page, "Backup group")
    expect(page.locator(".msg.out", has_text="group hello")).to_be_visible()


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
    expect(reply.get_by_role("img", name="Saved")).to_be_visible()
    saved_on_phone(phone, imported.reply.id, True)
    copy = phone.get_message_by_id(phone.get_message_by_id(imported.reply.id).get_snapshot().saved_message_id).get_snapshot()
    assert copy.chat_id == imported.phone_saved.id and copy.text == "reply from bob", copy
    open_chat(page, "Saved messages")
    expect(page.locator(".messages .msg", has_text="reply from bob")).to_be_visible()

    bob.click()
    message_action(page, reply, "Remove from saved")
    expect(reply.get_by_role("img", name="Saved")).to_have_count(0)
    saved_on_phone(phone, imported.reply.id, False)

    imported.bob_chat.send_text("saved on the phone")
    on_phone = wait_text(phone, "saved on the phone")
    incoming = page.locator(".msg.in", has_text="saved on the phone")
    expect(incoming).to_be_visible()
    rpc.save_msgs(phone.id, [on_phone.id])
    expect(incoming.get_by_role("img", name="Saved")).to_be_visible()
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


def test_saved_copies_are_imported(imported):
    page = imported.page
    open_chat(page, "Bob")
    own = page.locator(".msg.out", has_text="hello from alice")
    expect(own.get_by_role("img", name="Saved")).to_be_visible()
    message_action(page, own, "Remove from saved")
    open_chat(page, "Saved messages")
    expect(page.locator(".messages .msg", has_text="hello from alice")).to_have_count(0)
