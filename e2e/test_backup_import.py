"""A Delta Chat core profile imported into the web client from a backup, then used on both devices."""

import time
from types import SimpleNamespace

import pytest
from deltachat_rpc_client import EventType
from deltachat_rpc_client.const import MessageState
from playwright.sync_api import expect

from helpers import PNG, addr_of, open_chat, set_passphrase, wait_event, wait_own_msg, wait_text, web_send


@pytest.fixture
def imported(page, make_account, tmp_path):
    """The phone's profile with history, exported by core and imported into the web client."""
    phone = make_account("Alice Phone")
    bob = make_account("Bob")
    bob.secure_join(phone.get_qr_code())
    wait_event(phone, EventType.SECUREJOIN_INVITER_PROGRESS, lambda e: e.progress == 1000)
    phone_bob = phone.get_contact_by_addr(addr_of(bob)).create_chat()
    phone_bob.send_text("hello from alice")
    bob_chat = bob.get_chat_by_id(wait_text(bob, "hello from alice").chat_id)
    bob_chat.send_text("reply from bob")
    reply = wait_text(phone, "reply from bob")
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
    expect(page.locator(".msg.in", has_text="reply from bob")).to_be_visible()
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
