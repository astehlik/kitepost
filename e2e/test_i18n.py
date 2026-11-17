"""German translation: detection from the browser language, switching and the shared cookie."""

import pytest
from playwright.sync_api import expect

from helpers import INVITE, RELAY, TIMEOUT, URL, wait_event
from deltachat_rpc_client import EventType

from test_invite import create_invite


@pytest.fixture
def german(browser):
    context = browser.new_context(locale="de-DE")
    context.set_default_timeout(TIMEOUT)
    yield context
    context.close()


def test_web_client_in_german(german, make_account):
    page = german.new_page()
    page.goto(URL)
    expect(page.get_by_role("heading", name="Willkommen bei Kitepost")).to_be_visible()
    page.get_by_label("Sprache").select_option("en")
    expect(page.get_by_role("heading", name="Welcome to Kitepost")).to_be_visible()
    page.get_by_label("Language").select_option("de")

    page.locator('input[type="password"]').nth(0).fill("correct horse battery")
    page.locator('input[type="password"]').nth(1).fill("correct horse battery")
    page.get_by_role("button", name="Weiter").click()
    page.locator(".field", has_text="Anzeigename").locator("input").fill("Webby")
    page.locator(".field", has_text="Chatmail-Relay").locator("input").fill(RELAY)
    page.get_by_role("button", name="Profil erstellen").click()
    expect(page.get_by_role("heading", name="Handy verbinden")).to_be_visible()
    phone = make_account("Phone")
    phone.secure_join(page.get_by_label("Einladungslink").input_value())
    wait_event(phone, EventType.SECUREJOIN_JOINER_PROGRESS, lambda e: e.progress == 1000)
    expect(page.locator(".nav-actions")).to_contain_text("Meine Einladung")
    page.locator(".chatlist li", has_text="Phone").click()
    page.locator(".chathead").get_by_role("button", name="Chat bearbeiten").click()
    expect(page.locator("dialog")).to_contain_text("Ende-zu-Ende-Verschlüsselung")
    page.locator("dialog").get_by_role("button", name="Abbrechen").click()

    page.get_by_role("button", name="Profil bearbeiten").click()
    page.locator("dialog").get_by_label("Sprache").select_option("en")
    expect(page.locator(".nav-actions")).to_contain_text("My invite")
    expect(page.locator(".chathead strong")).to_have_text("Phone")
    page.reload()
    expect(page.get_by_role("heading", name="Unlock Kitepost")).to_be_visible()


@pytest.mark.local_relay
def test_invite_pages_in_german(german, context):
    admin = context.new_page()
    admin.goto(INVITE + "admin")
    admin.locator('input[type="password"]').fill("test-admin-token-0123456789abcdef")
    admin.get_by_role("button", name="Sign in").click()
    link = create_invite(admin)

    friend = german.new_page()
    friend.goto(link)
    expect(friend.get_by_role("button", name="Meine Adresse erstellen")).to_be_visible()
    friend.get_by_role("link", name="English").click()
    expect(friend.get_by_role("button", name="Create my address")).to_be_visible()
    assert {c["name"]: c["value"] for c in german.cookies()}["kitepost_lang"] == "en"
