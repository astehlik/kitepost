"""Offering a reload when a new version of the web client is deployed."""

from playwright.sync_api import expect

from helpers import open_chat


def deploy_new_version(page):
    def serve(route):
        html = route.fetch().text().replace("assets/index-", "assets/index-next-")
        route.fulfill(body=html, content_type="text/html")
    page.route("**/index.html", serve)


def return_to_tab(page):
    page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")


def test_offers_reload_after_a_deploy(web):
    page = web.page
    return_to_tab(page)
    page.wait_for_timeout(1000)
    expect(page.locator(".update-bar")).to_have_count(0)

    deploy_new_version(page)
    return_to_tab(page)
    bar = page.locator(".update-bar")
    expect(bar).to_contain_text("A new version of Kitepost is available.")
    with page.expect_navigation():
        bar.get_by_role("button", name="Reload").click()
    expect(page.locator(".update-bar")).to_have_count(0)


def test_failed_lazy_load_offers_reload(web):
    page = web.page
    page.route("**/assets/compact-*.js", lambda route: route.fulfill(status=404))
    deploy_new_version(page)
    open_chat(page, "Phone")
    page.get_by_role("button", name="Insert emoji").click()
    expect(page.locator(".update-bar")).to_be_visible()


def test_bar_follows_the_language(web):
    page = web.page
    deploy_new_version(page)
    return_to_tab(page)
    expect(page.locator(".update-bar")).to_contain_text("A new version")
    page.get_by_role("button", name="Edit profile").click()
    page.get_by_label("Language").select_option("de")
    page.get_by_role("button", name="Speichern").click()
    expect(page.locator(".update-bar")).to_contain_text("Eine neue Version von Kitepost ist verfügbar.")
    expect(page.locator(".update-bar").get_by_role("button", name="Neu laden")).to_be_visible()
