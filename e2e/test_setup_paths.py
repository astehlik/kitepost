"""The ways to start: a new profile, the profile from Delta Chat, or from Kitepost in another browser."""

from playwright.sync_api import expect

from helpers import set_passphrase


def test_start_page_offers_three_ways(page):
    set_passphrase(page)
    expect(page.get_by_role("radio", name="New profile")).to_be_checked()
    expect(page.get_by_role("button", name="Create profile")).to_be_visible()
    expect(page.get_by_label("Use an existing chatmail or e-mail address").locator("xpath=../..")).to_contain_text(
        "I already use Delta Chat")

    page.get_by_role("radio", name="I already use Delta Chat").check()
    expect(page.get_by_role("button", name="Create profile")).to_be_hidden()
    way = page.locator(".way:not([hidden])")
    expect(way).to_contain_text("Settings → Chats and media → Export backup")
    expect(way).to_contain_text("different key")
    expect(way.get_by_role("button", name="Import backup file")).to_be_visible()
    expect(way.get_by_role("button", name="Scan QR from phone")).to_be_visible()
    expect(way).to_contain_text("current releases do not do yet")

    page.get_by_role("radio", name="I already use Kitepost in another browser").check()
    expect(way).to_contain_text("Settings → Export backup")
    expect(way.get_by_role("button", name="Import backup file")).to_be_visible()
    expect(page.get_by_role("button", name="Scan QR from phone")).to_be_hidden()
    expect(way.get_by_text("current releases do not do yet")).to_be_hidden()
