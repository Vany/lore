#!/usr/bin/env python3
"""
The second ChatGPT subscription, as a credential opencode can use: `openai2` (D-157).

WHY THIS EXISTS. opencode 2.x serves ChatGPT logins through ONE integration, `openai`, and
answers with its single ACTIVE credential (`connection.active("openai")`, checked in 2.0.20
and 2.0.26). A second login does not add a second route; it replaces the first. So the
second account goes in the way the second Z.ai plan went in (`zai-coding-plan2`): a custom
provider in the host's opencode.json, `@ai-sdk/openai` at `https://chatgpt.com/backend-api/codex`,
whose API key is the ChatGPT ACCESS TOKEN. Measured 2026-10-09: a review-shaped turn with a
tool call answered through it, and account #1's token through the same provider got
"usage limit reached" — the backend authenticates and bills by the token alone.

WHAT IT COSTS: nobody renews it. opencode refreshes `openai` itself; a custom provider's key
is just a string, and the access token dies after about ten days. This script is the only
thing that renews account #2, and it MUST stay the only one: OpenAI rotates the refresh
token on every use, so a second renewer — a leftover login somewhere, another copy of this
state — would kill the login for both the first time either ran.

HOW IT RUNS. A filter in front of `lore creds-sync`:

    opencode api GET /api/credential | ./openai2-creds.py | lore creds-sync

It passes the host's list through and appends `openai2` with the current access token,
renewing first when the token is within RENEW_WITHIN of expiry. `make sync-creds` and
`make up` both run it; `make renew-daemon` runs `make sync-creds` daily so renewal does not
wait for a person.

    ./openai2-creds.py --import -     # an `opencode auth export` on stdin: `make login-openai2`

The state — refresh token, access token, expiry — is one file, mode 0600, outside the
deploy directory (`make push` rsyncs that with --delete, which would erase it).
"""

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

INTEGRATION = "openai2"
STATE = os.environ.get("OPENAI2_STATE") or os.path.expanduser("~/.config/lore/openai2.json")
# opencode's own ChatGPT OAuth client and token endpoint (2.0.20, `refresh` of the
# `chatgpt-browser` method). The refresh is a form POST of exactly these three fields.
TOKEN_URL = "https://auth.openai.com/oauth/token"
CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
# Three days of slack on a ten-day token: the daily renewal can miss two runs (laptop
# asleep, host down) and still renew before the token dies.
RENEW_WITHIN = 3 * 86400


def say(msg):
    print(f"openai2: {msg}", file=sys.stderr)


def account_of(access):
    """The ChatGPT account a token belongs to — the claim opencode itself reads."""
    payload = access.split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    return (claims.get("https://api.openai.com/auth") or {}).get("chatgpt_account_id")


def save(state):
    # Written BEFORE the token is used anywhere: after a refresh, the old refresh token is
    # already dead, so losing the new one here means losing the account until a re-login.
    d = os.path.dirname(STATE)
    os.makedirs(d, mode=0o700, exist_ok=True)
    tmp = STATE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(state, f)
    os.replace(tmp, STATE)


class LoginLost(Exception):
    """OpenAI answered the refresh — so the stored refresh token is already dead — and the
    new pair could not be kept. Not a retryable failure: no later sync can renew from what
    is on disk. `usable` is the new state when its access token still works for now."""

    def __init__(self, why, usable=None):
        super().__init__(why)
        self.usable = usable


def renew(state):
    body = urllib.parse.urlencode(
        {"grant_type": "refresh_token", "refresh_token": state["refresh"], "client_id": CLIENT_ID}
    ).encode()
    req = urllib.request.Request(TOKEN_URL, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
    # lore-ok[7b5b0e7c]: the URL is the constant TOKEN_URL above, never data from outside.
    with urllib.request.urlopen(req, timeout=30) as r:
        t = json.load(r)
    renewed = {
        "access": t["access_token"],
        # Rotation is the rule, but a response without a new one means the old one stands.
        "refresh": t.get("refresh_token") or state["refresh"],
        "expires": int(time.time() * 1000) + int(t.get("expires_in") or 3600) * 1000,
        "accountID": state["accountID"],
    }
    # FROM HERE ON THE OLD REFRESH TOKEN IS DEAD: OpenAI rotated it when it answered. A
    # failure below is therefore not "the next sync retries" — that sync would present a
    # revoked token — and is raised as LoginLost so it is reported as what it is.
    # A token for some other account would be billed to it without anyone noticing.
    got = account_of(renewed["access"])
    if got != state["accountID"]:
        raise LoginLost(f"the renewed token belongs to account {got}, not {state['accountID']}")
    try:
        save(renewed)
    except OSError as e:
        raise LoginLost(f"could not write {STATE}: {e}", usable=renewed) from e
    return renewed


def import_login(src):
    creds = json.load(sys.stdin if src == "-" else open(src))
    logins = [c for c in creds if c.get("integrationID") == "openai" and (c.get("value") or {}).get("type") == "oauth"]
    if len(logins) != 1:
        sys.exit(f"openai2: expected exactly one ChatGPT login in the export, found {len(logins)}")
    v = logins[0]["value"]
    # lore-ok[45fe0dfc]: which account this is gets checked in main(), where the host's list
    # is at hand: a state file holding the host's `openai` account is never renewed or sent,
    # and `make login-openai2` runs that sync immediately, so the mistake is named at once.
    account = (v.get("metadata") or {}).get("accountID") or account_of(v["access"])
    save({"access": v["access"], "refresh": v["refresh"], "expires": v["expires"], "accountID": account})
    say(f"saved account {account} to {STATE} (expires {iso(v['expires'])})")


def iso(ms):
    return time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(ms / 1000))


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--import":
        return import_login(sys.argv[2])
    if len(sys.argv) != 1:
        sys.exit("usage: openai2-creds.py < host-credentials   |   openai2-creds.py --import <export.json|->")

    raw = sys.stdin.read()
    try:
        listing = json.loads(raw)
    except ValueError:
        # Not ours to diagnose: creds-sync already explains an empty or broken host list in
        # its own words, so hand it on exactly as it came.
        sys.stdout.write(raw)
        return
    creds = listing if isinstance(listing, list) else listing.get("data")
    if not isinstance(creds, list):
        sys.stdout.write(raw)
        return
    if any(c.get("integrationID") == INTEGRATION for c in creds):
        # Two sources for one integration and no rule for which wins: refuse rather than guess.
        sys.exit(f"openai2: the host's opencode already holds an '{INTEGRATION}' credential — "
                 f"remove it (`opencode auth logout {INTEGRATION}`); {STATE} is the only source")

    state = None
    if not os.path.exists(STATE):
        # Not every deployment has a second account. A ladder that names `openai2/…` without
        # one fails at the route, where lore parks it and says so — not here.
        say(f"no login at {STATE} — not synced (`make login-openai2` to add one)")
    else:
        state = json.load(open(STATE))
        now = time.time() * 1000
        # lore-ok[45fe0dfc]: checked here, before any renewal, on every sync.
        # ACCOUNT #1 SAVED AS ACCOUNT #2 is the one mistake `make login-openai2` invites: a
        # browser that remembers account #1 signs it in without asking. Renewing that copy
        # would rotate account #1's refresh token and kill the host's and the deployment's
        # `openai` login, while `openai2` billed the plan it exists to relieve. So a state
        # file holding an account the host already has as `openai` is never renewed and never
        # sent — said loudly, and the other providers still sync.
        # ACTIVE only, as creds-sync reads the list: an inactive login is history that nothing
        # renews, so it cannot be killed — and counting it refused a genuine account #2 whose
        # first attempt had gone through `opencode auth login` and been switched away from.
        # lore-ok[2d68df19]: filtered on `active` here.
        # lore-ok[ed7e8408]: the account is also read off the token, and a guard that still
        # cannot tell says so instead of passing in silence.
        host_accounts = set()
        unreadable = False
        for c in creds:
            if c.get("integrationID") != "openai" or not c.get("active"):
                continue
            v = c.get("value") or {}
            try:
                account = (v.get("metadata") or {}).get("accountID") or account_of(v.get("access") or "")
            except (IndexError, ValueError):
                account = None
            if account:
                host_accounts.add(account)
            else:
                unreadable = True
        if unreadable:
            say("cannot tell which account the host's active `openai` login is (no account id on it), "
                "so the check that account #2 is not account #1 could NOT run — verify by hand")
        if state["accountID"] in host_accounts:
            say(f"REFUSED: {STATE} holds account {state['accountID']}, which is the host's `openai` "
                "login — not a second account. Delete it and `make login-openai2` signed in as "
                "account #2 (a private window).")
            state = None
        elif state["expires"] - now < RENEW_WITHIN * 1000:
            try:
                state = renew(state)
                say(f"renewed, valid until {iso(state['expires'])}")
            # lore-ok[efe6d9b3]: a save failure after rotation is LoginLost, reported as lost.
            except LoginLost as e:
                state = e.usable
                say(f"LOGIN LOST: {e} — OpenAI already rotated the refresh token, so no later sync "
                    "can renew account #2. " + (
                        f"The new access token is sent and works until {iso(state['expires'])}; "
                        if state else "Nothing usable is sent; ") + "run `make login-openai2` before then.")
            # lore-ok[387b0600]: everything, deliberately — a timeout or a dropped connection
            # mid-response is not a URLError, and an uncaught one exits non-zero, which
            # pipefail turns into the whole sync failing: one dead login blocking the rest.
            except Exception as e:  # noqa: BLE001
                detail = e.read().decode(errors="replace")[:300] if isinstance(e, urllib.error.HTTPError) else ""
                # LOUD, but the other providers still sync — one dead login must not block a
                # fresh Z.ai key (D-156). If the token has run out, lore's park on
                # `openai2/…` ("rejected our credentials") is the alarm that stays visible.
                # lore-ok[607047c1]: an AUTH refusal is a dead login, and nothing is sent for it.
                # OpenAI REFUSING the refresh token (400/401: invalid_grant, expired, revoked)
                # is not a hiccup to retry — that token will never work again. The usual way
                # to get here is a renewal that rotated but could not be saved (LoginLost
                # above): the deployment then holds the NEW ten-day token, and sending the
                # stale one from disk would replace it — a `key` credential has no expiry
                # creds-sync can compare — cutting the grace to the old token's last days.
                # Sending nothing leaves the deployment's credential exactly as it is.
                if isinstance(e, urllib.error.HTTPError) and e.code in (400, 401):
                    say(f"LOGIN DEAD: OpenAI refused the refresh token ({e.code} {detail}) — no sync can "
                        "renew account #2 again. Nothing is sent, so the deployment keeps the token it "
                        "holds until it expires; run `make login-openai2`.")
                    state = None
                elif state["expires"] > now:
                    say(f"RENEWAL FAILED ({e} {detail}) — the current token still works until "
                        f"{iso(state['expires'])}; the next sync retries")
                else:
                    say(f"RENEWAL FAILED and the token EXPIRED {iso(state['expires'])} ({e} {detail}) — "
                        "account #2 is out until `make login-openai2`")
    if state is not None:
        creds = creds + [{
            "id": "lore-openai2",
            "integrationID": INTEGRATION,
            "label": "ChatGPT account #2",
            "active": True,
            "value": {"type": "key", "key": state["access"]},
        }]

    out = creds if isinstance(listing, list) else {**listing, "data": creds}
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
