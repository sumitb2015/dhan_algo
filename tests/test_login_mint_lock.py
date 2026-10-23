"""Tests for login.py's token-mint lock: concurrent callers mint ONE Dhan token, a stale lock is taken over.

Stubbed: DhanLogin is replaced by a fake and the token / lock files point at a temp dir, so this never talks to Dhan
and never touches the real access_token.json.
"""
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import login  # noqa: E402

FAKE_ENV = {'client_id': '1000000001', 'dhan_pin': '0000', 'totp_key': 'JBSWY3DPEHPK3PXP'}


class FakeLogin:
    """Counts mints; each one takes a moment, like the real call, and returns a new token."""
    mints = 0
    lock = threading.Lock()

    def __init__(self, client_id):
        pass

    def generate_token(self, pin, totp):
        with FakeLogin.lock:
            FakeLogin.mints += 1
            n = FakeLogin.mints
        time.sleep(0.3)
        expiry = (datetime.now(login.IST) + timedelta(hours=24)).replace(tzinfo=None).isoformat()
        return {'accessToken': f'token-{n}', 'expiryTime': expiry}


class MintLockTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        FakeLogin.mints = 0
        self.patches = [
            mock.patch.object(login, 'TOKEN_FILE', os.path.join(self.dir, 'access_token.json')),
            mock.patch.object(login, 'MINT_LOCK', os.path.join(self.dir, 'debug', 'dhan_token_mint.lock')),
            mock.patch.object(login, 'DhanLogin', FakeLogin),
            mock.patch.dict(os.environ, FAKE_ENV),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()

    def test_concurrent_callers_mint_once_and_share_the_token(self):
        results = []
        threads = [threading.Thread(target=lambda: results.append(login.get_new_access_token_via_totp())) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        self.assertEqual(FakeLogin.mints, 1)
        self.assertEqual(results, ['token-1'] * 4)
        with open(login.TOKEN_FILE) as f:
            self.assertEqual(json.load(f)['accessToken'], 'token-1')
        self.assertFalse(os.path.exists(login.MINT_LOCK))

    def test_a_later_call_with_no_one_else_minting_still_mints(self):
        # --force semantics: a sequential second call is a deliberate new login, not a reuse.
        self.assertEqual(login.get_new_access_token_via_totp(), 'token-1')
        self.assertEqual(login.get_new_access_token_via_totp(), 'token-2')
        self.assertEqual(FakeLogin.mints, 2)

    def test_a_stale_lock_from_a_dead_process_is_taken_over(self):
        os.makedirs(os.path.dirname(login.MINT_LOCK), exist_ok=True)
        with open(login.MINT_LOCK, 'w') as f:
            f.write('99999')
        old = time.time() - login.MINT_LOCK_STALE_S - 5
        os.utime(login.MINT_LOCK, (old, old))
        self.assertEqual(login.get_new_access_token_via_totp(), 'token-1')

    def test_a_live_lock_held_too_long_gives_up_without_minting(self):
        os.makedirs(os.path.dirname(login.MINT_LOCK), exist_ok=True)
        open(login.MINT_LOCK, 'w').close()
        with mock.patch.object(login, 'MINT_WAIT_S', 1):
            self.assertIsNone(login.get_new_access_token_via_totp())
        self.assertEqual(FakeLogin.mints, 0)
        self.assertIn('minting', login.LAST_TOTP_ERROR)


if __name__ == '__main__':
    unittest.main()
