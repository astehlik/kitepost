"""End-to-end test of the invite service against the local relay with registration closed.

Needs `docker compose -f e2e/relay/compose.yaml up -d --build` and a built `web/dist`.
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

from deltachat_rpc_client import DeltaChat, Rpc
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
RELAY = "_chatmail.test"
RELAY_IP = "172.30.99.10"
INVITE = "http://127.0.0.1:8084/"
APP = "http://127.0.0.1:8099/"
ADMIN_TOKEN = "test-admin-token-0123456789abcdef"
TIMEOUT = 60_000


def log(msg):
    print(msg, flush=True)


def relay_exec(*cmd):
    subprocess.run(["docker", "exec", "kitepost-test-chatmail", *cmd], check=True)


def unlock_new_profile(page, url):
    page.goto(url)
    page.locator('input[type="password"]').nth(0).fill("correct horse battery")
    page.locator('input[type="password"]').nth(1).fill("correct horse battery")
    page.get_by_role("button", name="Continue").click()


def main():
    relay_exec("touch", "/etc/chatmail-nocreate")
    bridge = subprocess.Popen(
        ["node", str(ROOT / "bridge/server.mjs")],
        env={**os.environ, "PORT": "8099", "HOST_MAP": f"{RELAY}={RELAY_IP}"},
    )
    rpc_path = str(Path(sys.executable).parent / "deltachat-rpc-server")
    try:
        with tempfile.TemporaryDirectory() as tmp, Rpc(accounts_dir=tmp, rpc_server_path=rpc_path) as rpc, sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH") or None)
            page = browser.new_page()
            page.set_default_timeout(TIMEOUT)

            log("1. open registration is closed")
            unlock_new_profile(page, APP)
            page.locator(".field", has_text="Chatmail relay").locator("input").fill(RELAY)
            page.get_by_role("button", name="Create profile").click()
            expect(page.locator(".error")).to_contain_text("failed", timeout=TIMEOUT)

            log("2. admin creates a one-time invite")
            admin = browser.new_page()
            admin.goto(INVITE + "admin")
            admin.locator('input[type="password"]').fill("wrong-token-wrong-token-wrong")
            admin.get_by_role("button", name="Sign in").click()
            expect(admin.locator(".error")).to_have_text("Wrong admin token")
            admin.locator('input[type="password"]').fill(ADMIN_TOKEN)
            admin.get_by_role("button", name="Sign in").click()
            admin.locator('input[name="note"]').fill("For Frieda")
            admin.get_by_role("button", name="Create invite link").click()
            link = admin.locator("#link").inner_text()
            assert link.startswith(INVITE) and len(link) == len(INVITE) + 24, link

            log("3. a link preview (GET) does not consume the invite")
            friend = browser.new_page()
            friend.goto(link)
            friend.goto(link)
            expect(friend.locator("h1")).to_contain_text("invited")
            expect(friend.locator(".note")).to_have_text("For Frieda")

            log("4. friend redeems the invite")
            friend.get_by_role("button", name="Create my account").click()
            expect(friend.locator("h1")).to_have_text("Your account is ready")
            addr = friend.locator("strong").first.inner_text()
            dclogin = friend.get_by_role("link", name="Open in Delta Chat").get_attribute("href")
            assert addr.endswith("@" + RELAY) and dclogin.startswith(f"dclogin:{addr}?p=") and "ic=3" in dclogin
            web_link = friend.get_by_role("link", name="Open the web client").get_attribute("href")

            log("5. the link cannot be used twice")
            again = browser.new_page()
            assert again.goto(link).status == 410
            expect(again.locator("h1")).to_contain_text("no longer valid")
            again.request.post(link)  # direct POST is refused as well
            admin.reload()
            expect(admin.locator("tbody tr").first).to_contain_text("used")
            expect(admin.locator("tbody tr").first).to_contain_text(addr)

            log("6. the web client logs in with the invite credentials")
            web = browser.new_page()
            unlock_new_profile(web, web_link)
            expect(web.locator(".field", has_text="E-mail address").locator("input")).to_have_value(addr)
            web.get_by_role("button", name="Create profile").click()
            web.get_by_role("button", name="Continue").click()
            expect(web.locator(".status.ok")).to_be_visible(timeout=TIMEOUT)
            assert web.locator(".profile small").inner_text() == addr

            log("7. Delta Chat core logs in with the same kind of credentials")
            friend2 = browser.new_page()
            admin.get_by_role("button", name="Create invite link").click()
            friend2.goto(admin.locator("#link").inner_text())
            friend2.get_by_role("button", name="Create my account").click()
            core_login = friend2.get_by_role("link", name="Open in Delta Chat").get_attribute("href")
            core_addr = friend2.locator("strong").first.inner_text()
            password = core_login.split("?p=", 1)[1].split("&", 1)[0]
            dc = DeltaChat(rpc)
            acc = dc.add_account()
            acc.add_or_update_transport({
                "addr": core_addr, "password": password,
                "imapServer": RELAY_IP, "imapPort": 993, "imapSecurity": "ssl",
                "smtpServer": RELAY_IP, "smtpPort": 465, "smtpSecurity": "ssl",
                "certificateChecks": "acceptInvalidCertificates",
            })
            acc.start_io()
            log(f"   core configured as {core_addr}")

            log("8. revoked invites stop working")
            admin.get_by_role("button", name="Create invite link").click()
            revoked = admin.locator("#link").inner_text()
            admin.get_by_role("button", name="Revoke").first.click()
            assert browser.new_page().goto(revoked).status == 410

            log("ALL INVITE TESTS PASSED")
            browser.close()
    finally:
        bridge.terminate()
        relay_exec("rm", "-f", "/etc/chatmail-nocreate")


if __name__ == "__main__":
    main()
