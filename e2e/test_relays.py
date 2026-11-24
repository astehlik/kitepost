import secrets
import time

from deltachat_rpc_client import DeltaChat, EventType
from playwright.sync_api import expect

from helpers import EVENT_TIMEOUT, RELAY, URL, addr_of, close_view, new_chat, open_profile, mailbox_size, open_chat, relay_exec, reload_and_unlock, set_passphrase, transport, wait_event, wait_text, web_send


def add_relay(acc):
    addr = "".join(secrets.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(9)) + f"@{RELAY}"
    acc.add_or_update_transport(transport(addr, secrets.token_urlsafe(16)))
    return addr


def wait_mailbox(addr, more_than):
    deadline = time.monotonic() + EVENT_TIMEOUT
    while mailbox_size(addr) <= more_than:
        assert time.monotonic() < deadline, f"no new mail for {addr}"
        time.sleep(0.2)


def clear_mailbox(addr):
    relay_exec("sh", "-c", f"rm -f /home/vmail/mail/{RELAY}/{addr}/cur/* /home/vmail/mail/{RELAY}/{addr}/new/*")


def only_on_second_relay(bob, phone, first, second, text):
    """Bob writes to both relays of the phone; the mail is then removed from the first one."""
    before = mailbox_size(second)
    bob.get_contact_by_addr(first).create_chat().send_text(text)
    wait_text(phone, text)
    wait_mailbox(second, before)
    clear_mailbox(first)


def relays_in_settings(page):
    page.get_by_role("button", name="Settings").first.click()
    return page.locator(".settings section", has_text="Relays").locator(".relays li")


def test_relays_from_the_backup(page, make_account, rpc, tmp_path):
    phone = make_account("Alice Phone")
    first = addr_of(phone)
    second = add_relay(phone)
    bob = make_account("Bob")
    bob.secure_join(phone.get_qr_code())
    wait_event(phone, EventType.SECUREJOIN_INVITER_PROGRESS, lambda e: e.progress == 1000)
    phone.stop_io()
    phone.export_backup(str(tmp_path), "")
    phone.start_io()
    only_on_second_relay(bob, phone, first, second, "only on the second relay")

    set_passphrase(page)
    page.locator('.import input[type="file"]').set_input_files(str(next(tmp_path.glob("*.tar"))))
    expect(page.locator(".status.ok")).to_be_visible()
    open_chat(page, "Bob")
    expect(page.locator(".msg.in", has_text="only on the second relay")).to_be_visible()
    expect(relays_in_settings(page)).to_have_text([first, second])

    page.get_by_role("button", name="Export backup").click()
    with page.expect_download() as download:
        page.get_by_role("button", name="Download").click()
    backup = tmp_path / "out" / download.value.suggested_filename
    download.value.save_as(backup)
    restored = DeltaChat(rpc).add_account()
    try:
        restored.import_backup(backup)
        assert sorted(t["addr"] for t in restored.list_transports()) == sorted([first, second])
    finally:
        restored.remove()


def test_relays_from_the_phone(page, make_account, tmp_path):
    phone = make_account("Alice Phone")
    first = addr_of(phone)
    bob = make_account("Bob")
    bob.secure_join(phone.get_qr_code())
    wait_event(phone, EventType.SECUREJOIN_INVITER_PROGRESS, lambda e: e.progress == 1000)
    phone.stop_io()
    phone.export_backup(str(tmp_path), "")
    phone.start_io()
    set_passphrase(page)
    page.locator('.import input[type="file"]').set_input_files(str(next(tmp_path.glob("*.tar"))))
    expect(page.locator(".status.ok")).to_be_visible()

    second = add_relay(phone)
    relays = relays_in_settings(page)
    expect(relays).to_have_text([first, second])

    # Bob learns the new relay from the phone's key.
    phone.get_contact_by_addr(addr_of(bob)).create_chat().send_text("I have a second relay")
    wait_text(bob, "I have a second relay")
    page.goto("about:blank")
    only_on_second_relay(bob, phone, first, second, "sent while the browser was closed")
    page.goto(URL)
    reload_and_unlock(page)
    open_chat(page, "Bob")
    expect(page.locator(".msg.in", has_text="sent while the browser was closed")).to_be_visible()

    phone.delete_transport(second)
    expect(relays_in_settings(page)).to_have_text([first])


def test_sending_relay_removed_on_the_phone(page, make_account, tmp_path):
    phone = make_account("Alice Phone")
    first = addr_of(phone)
    second = add_relay(phone)
    bob = make_account("Bob")
    bob.secure_join(phone.get_qr_code())
    wait_event(phone, EventType.SECUREJOIN_INVITER_PROGRESS, lambda e: e.progress == 1000)
    phone.stop_io()
    phone.export_backup(str(tmp_path), "")
    phone.start_io()
    set_passphrase(page)
    page.locator('.import input[type="file"]').set_input_files(str(next(tmp_path.glob("*.tar"))))
    expect(page.locator(".status.ok")).to_be_visible()

    phone.delete_transport(first)
    expect(relays_in_settings(page)).to_have_text([second])
    expect(page.locator(".settings .profile-info")).to_contain_text(second)
    open_chat(page, "Bob")
    web_send(page, "from the remaining relay")
    msg = wait_text(bob, "from the remaining relay")
    assert bob.get_contact_by_id(msg.sender.id).get_snapshot().address == second


def imported_with_two_relays(page, make_account, tmp_path, second_relay=True):
    phone = make_account("Alice Phone")
    first = addr_of(phone)
    second = add_relay(phone) if second_relay else None
    bob = make_account("Bob")
    bob.secure_join(phone.get_qr_code())
    wait_event(phone, EventType.SECUREJOIN_INVITER_PROGRESS, lambda e: e.progress == 1000)
    phone.stop_io()
    phone.export_backup(str(tmp_path), "")
    phone.start_io()
    set_passphrase(page)
    page.locator('.import input[type="file"]').set_input_files(str(next(tmp_path.glob("*.tar"))))
    expect(page.locator(".status.ok")).to_be_visible()
    return phone, bob, first, second


def remove_in_settings(page, addr):
    relays = relays_in_settings(page)
    relays.filter(has_text=addr).get_by_role("button", name="Remove relay").click()
    page.locator("dialog", has_text=f'Remove relay "{addr}"?').get_by_role("button", name="Remove relay").click()
    return relays


def wait_transports(phone, addrs):
    deadline = time.monotonic() + EVENT_TIMEOUT
    while sorted(t["addr"] for t in phone.list_transports()) != sorted(addrs):
        assert time.monotonic() < deadline, f"the phone kept {phone.list_transports()}"
        time.sleep(0.2)


def test_removing_a_relay_reaches_the_phone(page, make_account, tmp_path):
    phone, _, first, second = imported_with_two_relays(page, make_account, tmp_path)
    relays = remove_in_settings(page, second)
    expect(relays).to_have_text([first])
    expect(relays.get_by_role("button", name="Remove relay")).to_have_count(0)
    wait_transports(phone, [first])


def test_removing_the_sending_relay(page, make_account, tmp_path):
    phone, bob, first, second = imported_with_two_relays(page, make_account, tmp_path)
    expect(remove_in_settings(page, first)).to_have_text([second])
    expect(page.locator(".settings .profile-info")).to_contain_text(second)
    wait_transports(phone, [second])
    open_chat(page, "Bob")
    web_send(page, "after removing the first relay")
    msg = wait_text(bob, "after removing the first relay")
    assert bob.get_contact_by_id(msg.sender.id).get_snapshot().address == second


def test_sending_switches_to_a_working_relay(page, make_account, tmp_path):
    _, bob, first, second = imported_with_two_relays(page, make_account, tmp_path)
    relay_exec("sh", "-c", f"echo '{{SHA512-CRYPT}}$6$broken$broken' > /home/vmail/mail/{RELAY}/{first}/password")
    open_chat(page, "Bob")
    web_send(page, "through the working relay")
    msg = wait_text(bob, "through the working relay")
    assert bob.get_contact_by_id(msg.sender.id).get_snapshot().address == second


def test_contacts_learn_about_a_removed_relay(page, make_account, tmp_path):
    phone, bob, first, second = imported_with_two_relays(page, make_account, tmp_path)
    bob.get_contact_by_addr(first).create_chat().send_text("hello before")
    wait_text(phone, "hello before")
    bob_addr = addr_of(bob)
    bob.stop_io()
    before = mailbox_size(bob_addr)
    remove_in_settings(page, second)
    wait_mailbox(bob_addr, before)
    bob.start_io()
    deadline = time.monotonic() + EVENT_TIMEOUT
    while mailbox_size(bob_addr) > before:
        assert time.monotonic() < deadline, "Bob did not fetch the keyupdate"
        time.sleep(0.2)

    on_second = mailbox_size(second)
    bob.get_contact_by_addr(first).create_chat().send_text("only to the first relay")
    wait_text(phone, "only to the first relay")
    time.sleep(2)
    assert mailbox_size(second) == on_second


def test_relay_removed_by_a_contact(web, make_account):
    page = web.page
    carol = make_account("Carol")
    carol.set_config("keyupdate_debounce", "0")
    first = addr_of(carol)
    second = add_relay(carol)
    new_chat(page, "Add contact")
    page.locator("dialog textarea").fill(carol.get_qr_code())
    page.get_by_role("button", name="Connect").click()
    expect(page.locator(".info", has_text="Secure connection established")).to_be_visible()
    carol.get_contact_by_addr(web.addr).create_chat().send_text("Carol here")
    expect(page.locator(".msg.in", has_text="Carol here")).to_be_visible()
    relays = open_profile(page).locator(".relays li")
    expect(relays).to_have_text([first, second])

    carol.delete_transport(second)
    expect(relays).to_have_text([first])
    close_view(page.locator(".settings.contact"))
    on_second = mailbox_size(second)
    web_send(page, "only to your first relay")
    wait_text(carol, "only to your first relay")
    time.sleep(2)
    assert mailbox_size(second) == on_second


def submit_add_relay(page, relay=None, login=None):
    """Fills the "Add relay" dialog with a relay for a new address, or with the login of an existing one."""
    page.locator(".settings").get_by_role("button", name="Add relay").click()
    dialog = page.locator("dialog", has_text="Add relay")
    if login:
        dialog.get_by_label("Use an existing address").check()
        dialog.get_by_label("E-mail address").fill(login[0])
        dialog.get_by_label("Password").fill(login[1])
    else:
        dialog.get_by_label("Chatmail relay").fill(relay)
    dialog.get_by_role("button", name="Add relay").click()
    return dialog


def add_in_settings(page, relay=None, login=None):
    relays = relays_in_settings(page)
    expect(submit_add_relay(page, relay, login)).to_have_count(0)
    return relays


def test_adding_a_relay(page, make_account, tmp_path):
    phone, bob, first, _ = imported_with_two_relays(page, make_account, tmp_path, second_relay=False)
    bob_addr = addr_of(bob)
    bob.stop_io()
    before = mailbox_size(bob_addr)
    relays = add_in_settings(page, relay=RELAY)
    expect(relays).to_have_count(2)
    added = relays.nth(1).inner_text()
    assert added != first and added.endswith(f"@{RELAY}")
    wait_transports(phone, [first, added])
    wait_mailbox(bob_addr, before)
    bob.start_io()
    deadline = time.monotonic() + EVENT_TIMEOUT
    while mailbox_size(bob_addr) > before:
        assert time.monotonic() < deadline, "Bob did not fetch the keyupdate"
        time.sleep(0.2)

    only_on_second_relay(bob, phone, first, added, "also to the added relay")
    open_chat(page, "Bob")
    expect(page.locator(".msg.in", has_text="also to the added relay")).to_be_visible()


def test_adding_existing_addresses_up_to_the_limit(page, make_account, tmp_path):
    _, bob, _, _ = imported_with_two_relays(page, make_account, tmp_path)
    for relay, login, error in ((None, (addr_of(bob), "wrong password"), "The relay rejected the address or the password."),
                                ("example.invalid", None, "Kitepost cannot reach example.invalid.")):
        relays_in_settings(page)
        dialog = submit_add_relay(page, relay, login)
        expect(dialog.locator(".error")).to_contain_text(error)
        dialog.get_by_role("button", name="Cancel").click()

    for _ in range(3):
        addr = "".join(secrets.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(9)) + f"@{RELAY}"
        relays = add_in_settings(page, login=(addr, secrets.token_urlsafe(16)))
        expect(relays.filter(has_text=addr)).to_have_count(1)
    expect(relays).to_have_count(5)
    expect(page.locator(".settings").get_by_role("button", name="Add relay")).to_have_count(0)


def set_server_password(addr, password):
    relay_exec("sh", "-c", f"doveadm pw -s SHA512-CRYPT -p '{password}' > /home/vmail/mail/{RELAY}/{addr}/password")


def test_password_of_the_sending_relay_changed_on_the_phone(page, make_account, tmp_path):
    phone, bob, first, second = imported_with_two_relays(page, make_account, tmp_path)
    phone.delete_transport(first)
    expect(relays_in_settings(page)).to_have_text([second])
    password = secrets.token_urlsafe(16)
    set_server_password(second, password)
    phone.add_or_update_transport(transport(second, password))
    # Sync items arrive in order, and the open connection outlives the password change.
    phone.set_config("displayname", "Alice New Password")
    expect(page.locator(".profile")).to_contain_text("Alice New Password")
    reload_and_unlock(page)
    (bob.get_contact_by_addr(second) or bob.get_contact_by_addr(first)).create_chat().send_text("after logging in again")
    open_chat(page, "Bob")
    expect(page.locator(".msg.in", has_text="after logging in again")).to_be_visible()
