"""The invite service against the local relay with registration closed."""

import re

import pytest
from deltachat_rpc_client import DeltaChat
from playwright.sync_api import expect

from helpers import ADMIN_TOKEN, INVITE, RELAY, URL, relay_exec, set_passphrase, transport

pytestmark = pytest.mark.local_relay


@pytest.fixture(scope="module", autouse=True)
def registration_closed():
    relay_exec("touch", "/etc/chatmail-nocreate")
    yield
    relay_exec("rm", "-f", "/etc/chatmail-nocreate")


@pytest.fixture
def admin(context):
    page = context.new_page()
    page.goto(INVITE + "admin")
    page.locator('input[type="password"]').fill(ADMIN_TOKEN)
    page.get_by_role("button", name="Sign in").click()
    expect(page.get_by_role("button", name="Create invite link")).to_be_visible()
    return page


def create_invite(admin, note=""):
    admin.locator('input[name="note"]').fill(note)
    admin.get_by_role("button", name="Create invite link").click()
    link = admin.locator("#link").inner_text()
    assert link.startswith(INVITE) and len(link) == len(INVITE) + 24, link
    return link


def redeem(page, link):
    """Creates the account and returns its address and dclogin link."""
    page.goto(link)
    page.get_by_role("button", name="Create my account").click()
    expect(page.locator("h1")).to_have_text("Your account is ready")
    addr = page.locator("strong").first.inner_text()
    return addr, page.locator('a[href^="dclogin:"]').get_attribute("href")


def test_open_registration_is_closed(page):
    set_passphrase(page)
    page.locator(".field", has_text="Chatmail relay").locator("input").fill(RELAY)
    page.get_by_role("button", name="Create profile").click()
    expect(page.locator("form .error")).to_contain_text("failed")


def test_admin_needs_the_token(context):
    page = context.new_page()
    page.goto(INVITE + "admin")
    page.locator('input[type="password"]').fill("wrong-token-wrong-token-wrong")
    page.get_by_role("button", name="Sign in").click()
    expect(page.locator(".error")).to_have_text("Wrong admin token")


def test_copy_gives_feedback(admin):
    create_invite(admin)
    admin.get_by_role("button", name="Copy").click()
    expect(admin.locator(".linkrow button")).to_have_text(re.compile("Copied|copy it with Ctrl"))
    expect(admin.locator(".linkrow button")).to_have_text("Copy", timeout=5000)


def test_invite_works_once(admin, context):
    link = create_invite(admin, "For Frieda")
    friend = context.new_page()
    friend.goto(link)
    friend.goto(link)
    expect(friend.locator("h1")).to_contain_text("invited")
    expect(friend.locator(".note")).to_have_text("For Frieda")

    addr, dclogin = redeem(friend, link)
    assert addr.endswith("@" + RELAY) and dclogin.startswith(f"dclogin:{addr}?p=") and "ic=3" in dclogin

    again = context.new_page()
    assert again.goto(link).status == 410
    expect(again.locator("h1")).to_contain_text("no longer valid")
    assert again.request.post(link).status == 410
    admin.reload()
    expect(admin.locator("tbody tr").first).to_contain_text("used")
    expect(admin.locator("tbody tr").first).to_contain_text(addr)


def test_result_page_offers_the_phone_only_path(admin, context):
    friend = context.new_page()
    redeem(friend, create_invite(admin))
    friend.get_by_text("Only use Delta Chat on the phone").click()
    expect(friend.locator("ol.steps > li h2")).to_have_text(["Install Delta Chat on your phone", "Log in on your phone"])
    expect(friend.locator("img.qr")).to_have_count(2)

    friend.get_by_role("link", name="Download page").click()
    assert friend.url == INVITE + "install"
    expect(friend.get_by_role("link", name="Google Play")).to_have_attribute(
        "href", "https://play.google.com/store/apps/details?id=chat.delta")
    expect(friend.get_by_role("link", name="F-Droid")).to_have_attribute(
        "href", "https://f-droid.org/packages/com.b44t.messenger/")


def test_web_client_logs_in_from_invite(admin, context):
    friend = context.new_page()
    addr, _ = redeem(friend, create_invite(admin))
    web_link = friend.get_by_role("link", name="Continue in the browser").get_attribute("href")
    assert web_link.startswith(URL + "#login=dclogin"), web_link

    web = context.new_page()
    web.route("**/config.json", lambda route: route.fulfill(json={"handoffUrl": INVITE}))
    set_passphrase(web, web_link)
    expect(web.locator(".field", has_text="E-mail address").locator("input")).to_have_value(addr)
    web.get_by_role("button", name="Create profile").click()
    expect(web.get_by_role("heading", name="Use it on your phone too")).to_be_visible()
    expect(web.locator(".phone-setup svg")).to_be_visible()
    web.get_by_role("button", name="Continue").click()
    expect(web.locator(".status.ok")).to_be_visible()
    assert web.locator(".profile small").inner_text() == addr


def test_core_logs_in_from_invite(admin, context, rpc):
    addr, dclogin = redeem(context.new_page(), create_invite(admin))
    password = dclogin.split("?p=", 1)[1].split("&", 1)[0]
    acc = DeltaChat(rpc).add_account()
    try:
        acc.add_or_update_transport(transport(addr, password))
        acc.start_io()
        assert acc.list_transports()[0]["addr"] == addr
    finally:
        acc.stop_io()
        acc.remove()


def test_create_button_is_disabled_while_submitting(admin, context):
    friend = context.new_page()
    friend.goto(create_invite(admin))
    # Keeps the page, so the state during the submission can be inspected.
    friend.evaluate("document.querySelector('form').addEventListener('submit', e => e.preventDefault())")
    button = friend.get_by_role("button", name="Create my account")
    button.click()
    expect(button).to_be_disabled()
    expect(button).to_have_attribute("aria-busy", "true")


def test_revoked_invite_stops_working(admin, context):
    link = create_invite(admin)
    release = []
    admin.route("**/api/invites/*", lambda route: release.append(route))
    revoke = admin.get_by_role("button", name="Revoke").first
    revoke.click()
    expect(revoke).to_be_disabled()
    expect(revoke).to_have_attribute("aria-busy", "true")
    release[0].continue_()
    admin.unroute("**/api/invites/*")
    expect(admin.locator("tbody tr").first).to_contain_text("revoked")
    assert context.new_page().goto(link).status == 410
