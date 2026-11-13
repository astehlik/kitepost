"""End-to-end test of the German translation: detection from the browser language, switching
in the web client and on the invite pages, and the shared language cookie.

Same requirements as test_interop.py and test_invite.py.
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

from deltachat_rpc_client import DeltaChat, EventType, Rpc
from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_interop import PORT, RELAY, RELAY_IP, ROOT, TIMEOUT, URL, log, new_core_account, wait_event
from test_invite import ADMIN_TOKEN, INVITE


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
            page = browser.new_page(locale="de-DE")
            page.set_default_timeout(TIMEOUT)

            log("1. a German browser gets the German web client, switching works before signing in")
            page.goto(URL)
            expect(page.get_by_role("heading", name="Willkommen bei Kitepost")).to_be_visible()
            page.get_by_label("Sprache").select_option("en")
            expect(page.get_by_role("heading", name="Welcome to Kitepost")).to_be_visible()
            page.get_by_label("Language").select_option("de")

            log("2. German profile setup and main view")
            page.locator('input[type="password"]').nth(0).fill("correct horse battery")
            page.locator('input[type="password"]').nth(1).fill("correct horse battery")
            page.get_by_role("button", name="Weiter").click()
            page.locator(".field", has_text="Anzeigename").locator("input").fill("Webby")
            page.locator(".field", has_text="Chatmail-Relay").locator("input").fill(RELAY)
            page.get_by_role("button", name="Profil erstellen").click()
            expect(page.get_by_role("heading", name="Handy verbinden")).to_be_visible(timeout=TIMEOUT)
            phone = new_core_account(dc, "Phone")
            phone.secure_join(page.get_by_label("Einladungslink").input_value())
            wait_event(phone, EventType.SECUREJOIN_JOINER_PROGRESS, lambda e: e.progress == 1000)
            expect(page.locator(".nav-actions")).to_contain_text("Meine Einladung")
            page.locator(".chatlist li", has_text="Phone").click()
            expect(page.locator(".chathead")).to_contain_text("Verschlüsselung")

            log("3. switching in the profile keeps the open chat and survives a reload")
            page.get_by_role("button", name="Profil bearbeiten").click()
            page.locator("dialog").get_by_label("Sprache").select_option("en")
            expect(page.locator(".nav-actions")).to_contain_text("My invite")
            expect(page.locator(".chathead strong")).to_have_text("Phone")
            page.reload()
            expect(page.get_by_role("heading", name="Unlock Kitepost")).to_be_visible()

            log("4. invite pages follow the browser language and switch via ?lang=")
            admin = browser.new_page(locale="de-DE")
            admin.goto(INVITE + "admin")
            admin.fill("input[type=password]", ADMIN_TOKEN)
            admin.get_by_role("button", name="Anmelden").click()
            admin.get_by_role("button", name="Einladungslink erstellen").click()
            link = admin.locator("#link").inner_text()
            friend = browser.new_page(locale="de-DE")
            friend.goto(link)
            expect(friend.get_by_role("button", name="Mein Konto erstellen")).to_be_visible()
            friend.get_by_role("link", name="English").click()
            expect(friend.get_by_role("button", name="Create my account")).to_be_visible()
            assert {c["name"]: c["value"] for c in friend.context.cookies()}["kitepost_lang"] == "en"

            log("ALL I18N TESTS PASSED")
            browser.close()
    finally:
        bridge.terminate()


if __name__ == "__main__":
    main()
