"""End-to-end interop test: the web client (headless Chromium) against Delta Chat core.

Requires a built app (`web/dist`), the bridge dependencies and a venv with
`deltachat-rpc-client deltachat-rpc-server playwright`. Uses the public test relay
nine.testrun.org.
"""

import os
import secrets
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from deltachat_rpc_client import DeltaChat, EventType, Rpc
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
RELAY = os.environ.get("RELAY", "nine.testrun.org")
# Set for relays without public DNS, e.g. the local one from e2e/relay (RELAY=_chatmail.test RELAY_IP=172.30.99.10).
RELAY_IP = os.environ.get("RELAY_IP")
PORT = 8099
URL = f"http://127.0.0.1:{PORT}/"
TIMEOUT = 120_000


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def wait_event(acc, kind, pred=lambda e: True):
    while True:
        ev = acc.wait_for_event()
        if ev.kind == kind and pred(ev):
            return ev


def wait_text(acc, text):
    while True:
        snap = acc.wait_for_incoming_msg().get_snapshot()
        if snap.text == text:
            return snap


def new_core_account(dc, name):
    acc = dc.add_account()
    acc.set_config("displayname", name)
    if RELAY_IP:
        acc.add_or_update_transport({
            "addr": f"{''.join(secrets.choice('abcdefghijklmnopqrstuvwxyz0123456789') for _ in range(9))}@{RELAY}",
            "password": secrets.token_urlsafe(16),
            "imapServer": RELAY_IP, "imapPort": 993, "imapSecurity": "ssl",
            "smtpServer": RELAY_IP, "smtpPort": 465, "smtpSecurity": "ssl",
            "certificateChecks": "acceptInvalidCertificates",
        })
    else:
        acc.add_transport_from_qr(f"dcaccount:{RELAY}")
    acc.start_io()
    log(f"core account {name}: {acc.list_transports()[0]}")
    return acc


def setup_web(page):
    page.goto(URL)
    page.locator('input[type="password"]').nth(0).fill("correct horse battery")
    page.locator('input[type="password"]').nth(1).fill("correct horse battery")
    page.get_by_role("button", name="Continue").click()
    page.locator(".field", has_text="Display name").locator("input").fill("Webby")
    page.locator(".field", has_text="Chatmail relay").locator("input").fill(RELAY)
    page.get_by_role("button", name="Create profile").click()
    expect(page.locator(".status.ok")).to_be_visible(timeout=TIMEOUT)
    addr = page.locator(".profile small").inner_text()
    log(f"web account: {addr}")
    return addr


def open_chat(page, title):
    page.locator(".chatlist li", has_text=title).first.click()


def web_send(page, text):
    page.locator(".composer textarea").fill(text)
    page.locator(".composer textarea").press("Enter")
    expect(page.locator(".msg.out", has_text=text).locator(".meta")).to_contain_text("✓", timeout=TIMEOUT)


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

            web_addr = setup_web(page)
            dora = new_core_account(dc, "Dora")

            log("1. web joins core's invite (SecureJoin v3, web = joiner)")
            page.get_by_role("button", name="Add contact").click()
            page.locator("dialog textarea").fill(dora.get_qr_code())
            page.get_by_role("button", name="Connect").click()
            ev = wait_event(dora, "SecurejoinInviterProgress", lambda e: e.progress == 1000)
            expect(page.locator(".info", has_text="Secure connection established")).to_be_visible(timeout=TIMEOUT)
            dora_chat = dora.get_chat_by_contact(ev.contact_id)
            assert dora.get_contact_by_id(ev.contact_id).get_snapshot().is_key_contact, "core has no key contact for web"
            log("   verified on both sides")

            log("2. core -> web text")
            msg = dora_chat.send_text("Hello from Delta Chat core ✓")
            expect(page.locator(".msg.in", has_text="Hello from Delta Chat core ✓")).to_be_visible(timeout=TIMEOUT)

            log("3. web -> core text")
            web_send(page, "Hi from the browser 🌐")
            incoming = dora.wait_for_incoming_msg().get_snapshot()
            assert incoming.text == "Hi from the browser 🌐", incoming.text
            assert incoming.show_padlock, "message not shown as encrypted in core"

            log("4. core reaction -> web")
            msg.send_reaction("👍")
            expect(page.locator(".msg .reactions", has_text="👍")).to_be_visible(timeout=TIMEOUT)

            log("5. web attachment -> core")
            png = Path(tmp) / "dot.png"
            png.write_bytes(bytes.fromhex(
                "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                "1f15c4890000000d49444154789c6360f8cf000000020101007ed6ac"
                "970000000049454e44ae426082"))
            page.locator('.composer input[type="file"]').set_input_files(str(png))
            web_send(page, "a picture")
            snap = dora.wait_for_incoming_msg().get_snapshot()
            assert snap.text == "a picture" and snap.file_name == "dot.png", snap

            log("6. core group with web member")
            group = dora.create_group("Interop group")
            group.add_contact(dora.get_contact_by_id(ev.contact_id))
            group.send_text("Welcome to the group")
            page.locator(".chatlist li", has_text="Interop group").first.wait_for(timeout=TIMEOUT)
            open_chat(page, "Interop group")
            expect(page.locator(".msg.in", has_text="Welcome to the group")).to_be_visible(timeout=TIMEOUT)
            web_send(page, "Group reply from web")
            snap = dora.wait_for_incoming_msg().get_snapshot()
            assert snap.text == "Group reply from web" and snap.chat_id == group.id, snap

            log("7. core joins web's invite (SecureJoin v3, web = inviter)")
            erin = new_core_account(dc, "Erin")
            page.get_by_role("button", name="My invite").click()
            link = page.locator("dialog input").input_value()
            page.get_by_role("button", name="Close").click()
            erin.secure_join(link)
            wait_event(erin, "SecurejoinJoinerProgress", lambda e: e.progress == 1000)
            expect(page.locator(".chatlist li", has_text="Erin")).to_be_visible(timeout=TIMEOUT)
            erin_contact = erin.get_contact_by_addr(web_addr)
            assert erin_contact.get_snapshot().e2ee_avail, "core cannot encrypt to web inviter"
            erin.get_chat_by_contact(erin_contact).send_text("Erin here")
            open_chat(page, "Erin")
            expect(page.locator(".msg.in", has_text="Erin here")).to_be_visible(timeout=TIMEOUT)
            expect(page.locator(".request")).to_have_count(0)
            web_send(page, "Welcome Erin")
            assert erin.wait_for_incoming_msg().get_snapshot().text == "Welcome Erin"

            log("8. web group invite -> core joins")
            page.get_by_role("button", name="New group").click()
            page.locator("dialog .field input").fill("Web group")
            page.locator("dialog .members label", has_text="Dora").locator("input").check()
            page.get_by_role("button", name="Create", exact=True).click()
            expect(page.locator(".chatlist li", has_text="Web group")).to_have_count(1)
            web_send(page, "First message in web group")
            snap = dora.wait_for_incoming_msg().get_snapshot()
            assert snap.text == "First message in web group", snap
            assert dora.get_chat_by_id(snap.chat_id).get_basic_snapshot().name == "Web group"
            page.get_by_role("button", name="Invite link").click()
            glink = page.locator("dialog input").input_value()
            page.get_by_role("button", name="Close").click()
            erin.secure_join(glink)
            wait_event(erin, "SecurejoinJoinerProgress", lambda e: e.progress == 1000)
            expect(page.locator(".info", has_text="joined the group")).to_be_visible(timeout=TIMEOUT)
            erin_group = [c for c in erin.get_chatlist() if c.get_basic_snapshot().name == "Web group"][0]
            erin_group.send_text("Erin in web group")
            expect(page.locator(".msg.in", has_text="Erin in web group")).to_be_visible(timeout=TIMEOUT)
            snap = wait_text(dora, "Erin in web group")
            assert dora.get_chat_by_id(snap.chat_id).get_basic_snapshot().name == "Web group", snap

            log("9. reload: encrypted storage unlocks and history persists")
            page.reload()
            page.locator('input[type="password"]').fill("correct horse battery")
            page.get_by_role("button", name="Unlock").click()
            expect(page.locator(".chatlist li", has_text="Web group")).to_be_visible()

            log("ALL TESTS PASSED")
            browser.close()
    finally:
        bridge.terminate()


if __name__ == "__main__":
    main()
