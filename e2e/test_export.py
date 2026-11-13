"""End-to-end test: a profile created in the web client is exported as a backup, restored by
Delta Chat core and then used on both devices.

Same requirements as test_interop.py.
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

from deltachat_rpc_client import DeltaChat, EventType, Rpc
from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_interop import (
    PORT, RELAY, RELAY_IP, ROOT, TIMEOUT, log, new_core_account, open_chat, set_passphrase, wait_event, wait_text,
    web_send,
)
from test_import import wait_own_msg


def main():
    bridge = subprocess.Popen(
        ["node", str(ROOT / "bridge/server.mjs")],
        env={**os.environ, "PORT": str(PORT), "HOST_MAP": f"{RELAY}={RELAY_IP}" if RELAY_IP else ""},
    )
    rpc_path = str(Path(sys.executable).parent / "deltachat-rpc-server")
    try:
        with tempfile.TemporaryDirectory() as tmp, Rpc(accounts_dir=tmp, rpc_server_path=rpc_path) as rpc, sync_playwright() as pw:
            dc = DeltaChat(rpc)
            browser = pw.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH") or None)
            page = browser.new_page()
            page.on("console", lambda m: m.type in ("error", "warning") and log(f"browser {m.type}: {m.text}"))
            page.on("pageerror", lambda e: log(f"page error: {e}"))
            page.set_default_timeout(TIMEOUT)

            log("1. web profile with a contact, history, attachment and group")
            bob = new_core_account(dc, "Bob")
            set_passphrase(page)
            page.locator(".field", has_text="Display name").locator("input").fill("Webby")
            page.locator(".field", has_text="Chatmail relay").locator("input").fill(RELAY)
            page.get_by_role("button", name="Create profile").click()
            bob.secure_join(page.get_by_label("Invite link").input_value())
            wait_event(bob, EventType.SECUREJOIN_JOINER_PROGRESS, lambda e: e.progress == 1000)
            expect(page.locator(".status.ok")).to_be_visible(timeout=TIMEOUT)
            web_addr = page.locator(".profile small").inner_text()
            bob_chat = bob.get_chat_by_contact(bob.get_contact_by_addr(web_addr))
            bob_chat.send_text("hello web")
            open_chat(page, "Bob")
            expect(page.locator(".msg.in", has_text="hello web")).to_be_visible(timeout=TIMEOUT)
            png = Path(tmp) / "dot.png"
            png.write_bytes(bytes.fromhex(
                "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                "1f15c4890000000d49444154789c6360f8cf000000020101007ed6ac"
                "970000000049454e44ae426082"))
            page.locator('.composer input[type="file"]').set_input_files(str(png))
            web_send(page, "hello bob")
            wait_text(bob, "hello bob")
            page.get_by_role("button", name="New group").click()
            page.locator("dialog .field input").fill("Export group")
            page.locator("dialog .members label", has_text="Bob").locator("input").check()
            page.get_by_role("button", name="Create", exact=True).click()
            expect(page.locator(".chatlist li", has_text="Export group")).to_have_count(1)
            expect(page.locator(".info", has_text="Group created")).to_be_visible()
            web_send(page, "group from web")
            bob_group = bob.get_chat_by_id(wait_text(bob, "group from web").chat_id)

            log("2. export from the web client")
            page.get_by_role("button", name="Edit profile").click()
            page.get_by_role("button", name="Export backup").click()
            with page.expect_download() as dl:
                page.get_by_role("button", name="Download").click()
            backup = Path(tmp) / dl.value.suggested_filename
            dl.value.save_as(backup)
            assert backup.name.startswith("delta-chat-backup-") and backup.suffix == ".tar", backup.name

            log("3. Delta Chat core restores it")
            phone = dc.add_account()
            phone.import_backup(backup)
            transport = phone.list_transports()[0]
            assert transport["addr"] == web_addr, transport
            if RELAY_IP:
                phone.add_or_update_transport({
                    "addr": web_addr, "password": transport["password"],
                    "imapServer": RELAY_IP, "imapPort": 993, "imapSecurity": "ssl",
                    "smtpServer": RELAY_IP, "smtpPort": 465, "smtpSecurity": "ssl",
                    "certificateChecks": "acceptInvalidCertificates",
                })
            phone.start_io()
            assert phone.get_config("displayname") == "Webby"
            chats = {c.get_basic_snapshot().name: c for c in phone.get_chatlist()}
            assert "Bob" in chats and "Export group" in chats, list(chats)
            texts = [m.get_snapshot().text for m in chats["Bob"].get_messages()]
            assert "hello web" in texts and "hello bob" in texts, texts
            pic = next(m.get_snapshot() for m in chats["Bob"].get_messages() if m.get_snapshot().text == "hello bob")
            assert pic.file_name == "dot.png" and Path(pic.file).read_bytes() == png.read_bytes(), pic
            bob_contact = phone.get_contact_by_addr(bob.list_transports()[0]["addr"]).get_snapshot()
            assert bob_contact.is_key_contact and bob_contact.e2ee_avail, bob_contact

            log("4. the restored phone writes to bob, in the existing chats")
            chats["Bob"].send_text("from the restored phone")
            snap = wait_text(bob, "from the restored phone")
            assert snap.chat_id == bob_chat.id and snap.show_padlock, snap
            open_chat(page, "Bob")
            expect(page.locator(".msg.out", has_text="from the restored phone")).to_be_visible(timeout=TIMEOUT)
            chats["Export group"].send_text("group from the phone")
            assert wait_text(bob, "group from the phone").chat_id == bob_group.id

            log("5. bob reaches both devices, web messages reach the phone")
            bob_chat.send_text("bob to both")
            wait_text(phone, "bob to both")
            expect(page.locator(".msg.in", has_text="bob to both")).to_be_visible(timeout=TIMEOUT)
            web_send(page, "web after export")
            assert wait_own_msg(phone, "web after export").chat_id == chats["Bob"].id

            log("ALL EXPORT TESTS PASSED")
            browser.close()
    finally:
        bridge.terminate()


if __name__ == "__main__":
    main()
