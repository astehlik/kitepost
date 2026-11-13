"""End-to-end test: a Delta Chat core profile is exported as a backup, imported into the web
client and then used on both devices at once.

Same requirements as test_interop.py.
"""

import base64
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from deltachat_rpc_client import DeltaChat, EventType, Rpc
from deltachat_rpc_client.const import MessageState
from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_interop import (
    PORT, RELAY, RELAY_IP, ROOT, TIMEOUT, log, new_core_account, open_chat, set_passphrase, wait_event, wait_text,
    web_send,
)

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==")


def wait_own_msg(acc, text):
    """Waits until a message with `text` sent from another device shows up as outgoing."""
    while True:
        ev = acc.wait_for_event()
        if ev.kind == EventType.MSGS_CHANGED and ev.msg_id:
            snap = acc.get_message_by_id(ev.msg_id).get_snapshot()
            if snap.text == text and snap.from_id == 1:
                return snap


def main():
    bridge = subprocess.Popen(
        ["node", str(ROOT / "bridge/server.mjs")],
        env={**os.environ, "PORT": str(PORT), "HOST_MAP": f"{RELAY}={RELAY_IP}" if RELAY_IP else ""},
    )
    rpc_path = str(Path(sys.executable).parent / "deltachat-rpc-server")
    try:
        with tempfile.TemporaryDirectory() as tmp, Rpc(accounts_dir=tmp, rpc_server_path=rpc_path) as rpc, sync_playwright() as pw:
            dc = DeltaChat(rpc)
            log("1. core profile with history")
            phone = new_core_account(dc, "Alice Phone")
            bob = new_core_account(dc, "Bob")
            bob.secure_join(phone.get_qr_code())
            wait_event(phone, EventType.SECUREJOIN_INVITER_PROGRESS, lambda e: e.progress == 1000)
            bob_addr = bob.list_transports()[0]["addr"]
            phone_bob = phone.get_contact_by_addr(bob_addr).create_chat()
            phone_bob.send_text("hello from alice")
            bob_chat = bob.get_chat_by_id(wait_text(bob, "hello from alice").chat_id)
            bob_chat.send_text("reply from bob")
            reply_on_phone = wait_text(phone, "reply from bob")
            png = Path(tmp) / "pic.png"
            png.write_bytes(PNG)
            phone_bob.send_file(str(png))
            phone_saved = phone.get_contact_by_id(1).create_chat()
            phone_saved.send_text("note before export")
            group = phone.create_group("Backup group")
            group.add_contact(phone.get_contact_by_addr(bob_addr))
            group.send_text("group hello")
            bob_group = bob.get_chat_by_id(wait_text(bob, "group hello").chat_id)

            log("2. export backup")
            backup_dir = Path(tmp) / "backup"
            backup_dir.mkdir()
            phone.stop_io()
            phone.export_backup(str(backup_dir), "")
            phone.start_io()
            backup = next(backup_dir.glob("*.tar"))

            browser = pw.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH") or None)
            page = browser.new_page()
            page.on("console", lambda m: m.type in ("error", "warning") and log(f"browser {m.type}: {m.text}"))
            page.on("pageerror", lambda e: log(f"page error: {e}"))
            page.set_default_timeout(TIMEOUT)

            log("3. import into the web client")
            set_passphrase(page)
            page.locator('.import input[type="file"]').set_input_files(str(backup))
            expect(page.locator(".status.ok")).to_be_visible(timeout=TIMEOUT)
            assert page.locator(".profile small").inner_text() == phone.list_transports()[0]["addr"]
            open_chat(page, "Bob")
            expect(page.locator(".msg.out", has_text="hello from alice")).to_be_visible()
            expect(page.locator(".msg.in", has_text="reply from bob")).to_be_visible()
            expect(page.locator(".msg.out .attachment img")).to_be_visible()
            expect(page.locator(".chathead small")).to_contain_text(bob_addr)

            log("4. web -> bob, copy reaches the phone")
            web_send(page, "sent from the browser")
            assert wait_text(bob, "sent from the browser").chat_id == bob_chat.id
            assert wait_own_msg(phone, "sent from the browser").chat_id == phone_bob.id

            log("5. phone -> bob shows up as outgoing in the web client")
            phone_bob.send_text("sent from the phone")
            expect(page.locator(".msg.out", has_text="sent from the phone")).to_be_visible(timeout=TIMEOUT)

            log("6. bob -> both devices")
            bob_chat.send_text("bob to both")
            expect(page.locator(".msg.in", has_text="bob to both")).to_be_visible(timeout=TIMEOUT)
            on_phone = wait_text(phone, "bob to both")

            log("7. reading it in the web client marks it read on the phone")
            deadline = time.time() + 60
            while phone.get_message_by_id(on_phone.id).get_snapshot().state != MessageState.IN_SEEN:
                assert time.time() < deadline, "phone did not pick up the \\Seen flag"
                time.sleep(0.5)

            log("8. imported group works")
            open_chat(page, "Backup group")
            expect(page.locator(".msg.out", has_text="group hello")).to_be_visible()
            web_send(page, "group from web")
            assert wait_text(bob, "group from web").chat_id == bob_group.id

            log("9. reading on the phone clears the unread badge in the web client")
            bob_chat.send_text("read me on the phone")
            badge = page.locator(".chatlist li", has_text="Bob").locator(".badge")
            expect(badge).to_have_text("1", timeout=TIMEOUT)
            phone.mark_seen_messages([phone.get_message_by_id(wait_text(phone, "read me on the phone").id)])
            expect(badge).to_have_count(0, timeout=TIMEOUT)

            log("10. Saved messages: imported, notes in both directions, saving a message on the phone")
            open_chat(page, "Saved messages")
            expect(page.locator(".msg.out", has_text="note before export")).to_be_visible()
            phone_saved.send_text("note after import")
            expect(page.locator(".msg.out", has_text="note after import")).to_be_visible(timeout=TIMEOUT)
            rpc.save_msgs(phone.id, [reply_on_phone.id])
            expect(page.locator(".messages .msg", has_text="reply from bob")).to_be_visible(timeout=TIMEOUT)
            web_send(page, "note from the browser")
            assert wait_own_msg(phone, "note from the browser").chat_id == phone_saved.id

            log("ALL TESTS PASSED")
            browser.close()
    finally:
        bridge.terminate()


if __name__ == "__main__":
    main()
