"""Tests for the Dhan account-read diagnosis (lib/dhan_health.diagnose_account_reads) and its checker script.

Built from the 2026-10-23 incident: every account read answered 400 DH-905 while /profile and orders worked, then
recovered on its own between 10:09 and 10:11 IST. The bodies below are the ones Dhan actually sent that day.

Stubbed: no network, no broker session; the checker's token file points at a temp dir and requests.get is a fake.
"""
import base64
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from lib.dhan_health import VERDICT_ADVICE, dhan_error_code, diagnose_account_reads, static_ip_problems  # noqa: E402

_spec = importlib.util.spec_from_file_location('check_dhan_account_reads', os.path.join(ROOT, 'scripts', 'testing', 'check_dhan_account_reads.py'))
checker = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(checker)

DH905 = {'errorType': 'Input_Exception', 'errorCode': 'DH-905', 'errorMessage': 'Missing required fields, bad values for parameters etc.'}
DH906 = {'errorType': 'Invalid_Authentication', 'errorCode': 'DH-906', 'errorMessage': 'Invalid Token'}
PROFILE = {'tokenValidity': '24/10/2026 10:08', 'activeSegment': 'Equity, Derivative, Currency, Commodity'}
GET_IP = {'modifyDatePrimary': '2026-06-23', 'modifyDateSecondary': '2026-08-13', 'primaryIP': '10.0.0.1',
          'secondaryIP': '10.0.0.2', 'detectedIP': '10.0.0.1', 'ipMatchStatus': 'PRIMARY_MATCH', 'ordersAllowed': True}
ACCOUNT_READS = ['/positions', '/orders', '/trades', '/fundlimit', '/holdings']
# A position row carrying a marker: the checker must print counts only, never account contents.
SECRET = 'SECRET-ROW-MARKER'


def round_(**overrides):
    """One healthy round of the checker's endpoints, with per-endpoint (status, body) overrides."""
    base = {'/profile': (200, PROFILE), '/positions': (200, [{'tradingSymbol': SECRET}]), '/orders': (200, []),
            '/trades': (200, []), '/fundlimit': (200, {'availabelBalance': 1}), '/holdings': (200, []), '/ip/getIP': (200, GET_IP)}
    base.update({'/' + k.replace('_', '/'): v for k, v in overrides.items()})  # ip_getIP -> /ip/getIP
    return base


INCIDENT = round_(positions=(400, DH905), orders=(400, DH905), trades=(400, DH905), fundlimit=(400, DH905),
                  holdings=(400, DH905), ip_getIP=(400, DH905))


class DiagnoseTest(unittest.TestCase):
    def test_incident_pattern_is_account_reads_blocked(self):
        verdict, notes = diagnose_account_reads(INCIDENT)
        self.assertEqual(verdict, 'account_reads_blocked')
        self.assertEqual(notes, ['DH-905 on: ' + ', '.join(ACCOUNT_READS)])
        # The advice must steer away from the two wrong fixes tried that day.
        self.assertIn('Do not re-mint', VERDICT_ADVICE[verdict])
        self.assertIn('not the token', VERDICT_ADVICE[verdict])

    def test_one_read_failing_with_dh905_is_the_same_pattern(self):
        self.assertEqual(diagnose_account_reads(round_(positions=(400, DH905)))[0], 'account_reads_blocked')

    def test_recovered_round_is_ok(self):
        self.assertEqual(diagnose_account_reads(round_()), ('ok', []))

    def test_superseded_token_is_token_invalid_not_account_reads(self):
        # A newer mint kills the old token at once: DH-906 even on /profile.
        dead = {ep: (401, DH906) for ep in round_()}
        self.assertEqual(diagnose_account_reads(dead)[0], 'token_invalid')
        self.assertEqual(diagnose_account_reads(round_(profile=(400, DH906)))[0], 'token_invalid')

    def test_dh905_without_a_working_profile_is_not_blamed_on_dhan(self):
        self.assertEqual(diagnose_account_reads(round_(profile=(500, None), positions=(400, DH905)))[0], 'partial')

    def test_rate_limit(self):
        self.assertEqual(diagnose_account_reads(round_(orders=(429, None)))[0], 'rate_limited')
        self.assertEqual(diagnose_account_reads(round_(orders=(400, {'errorCode': 'DH-904'})))[0], 'rate_limited')

    def test_network(self):
        self.assertEqual(diagnose_account_reads({ep: (None, None) for ep in round_()})[0], 'network')

    def test_mixed_errors_are_partial(self):
        self.assertEqual(diagnose_account_reads(round_(positions=(500, None), orders=(400, DH905)))[0], 'partial')

    def test_static_ip_mismatch_or_orders_not_allowed(self):
        moved = dict(GET_IP, detectedIP='10.9.9.9', ipMatchStatus='NO_MATCH')
        verdict, notes = diagnose_account_reads(round_(ip_getIP=(200, moved)))
        self.assertEqual(verdict, 'ip_orders_blocked')
        self.assertIn('Detected IP 10.9.9.9 is not a registered static IP', notes)
        self.assertEqual(diagnose_account_reads(round_(ip_getIP=(200, dict(GET_IP, ordersAllowed=False))))[0], 'ip_orders_blocked')
        self.assertEqual(static_ip_problems(dict(GET_IP, primaryIP='', secondaryIP='')), ['No static IP registered with Dhan'])
        # Missing fields are not guessed at.
        self.assertEqual(static_ip_problems({'primaryIP': '10.0.0.1'}), [])

    def test_error_code_from_rest_and_sdk_shapes(self):
        self.assertEqual(dhan_error_code(DH905), 'DH-905')
        # The SDK shape, as logged by the market-data hub's session check that day.
        sdk = {'status': 'failure', 'remarks': {'error_code': 'DH-905', 'error_type': 'Input_Exception'}, 'data': ''}
        self.assertEqual(dhan_error_code(sdk), 'DH-905')
        self.assertIsNone(dhan_error_code(None))
        self.assertIsNone(dhan_error_code({'status': 'success'}))


class FakeResponse:
    def __init__(self, status, body):
        self.status_code, self._body = status, body

    def json(self):
        if self._body is None:
            raise ValueError('no json')
        return self._body


class FakeDhan:
    """Answers the checker's GETs from a list of rounds; records the headers it was sent."""

    def __init__(self, rounds):
        self.rounds, self.calls, self.headers = rounds, 0, []

    def __call__(self, url, headers=None, timeout=None):
        ep = url[len(checker.BASE):]
        rnd = self.rounds[min(self.calls // len(checker.ENDPOINTS), len(self.rounds) - 1)]
        self.calls += 1
        self.headers.append(headers)
        return FakeResponse(*rnd[ep])


def fake_jwt(claims):
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip('=')  # noqa: E731
    return f"{enc({'alg': 'HS512'})}.{enc(claims)}.sig"


class CheckerScriptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.token_file = os.path.join(self.tmp.name, 'access_token.json')
        with open(self.token_file, 'w') as f:
            json.dump({'accessToken': fake_jwt({'tokenConsumerType': 'APP', 'iat': 1792730338}), 'dhanClientId': '1000000001',
                       'createdAt': '2026-10-23T10:08:58+05:30', 'expiryTime': '2026-10-24T10:08:58'}, f)
        self._orig = checker.TOKEN_FILE
        checker.TOKEN_FILE = self.token_file

    def tearDown(self):
        checker.TOKEN_FILE = self._orig
        self.tmp.cleanup()

    def test_report_prints_counts_and_verdict_never_contents(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            verdict = checker.report(checker.collect(*checker.load_token(), get=FakeDhan([round_()])))
        text = out.getvalue()
        self.assertEqual(verdict, 'ok')
        self.assertIn('7/7 endpoints OK', text)
        self.assertIn('ipMatchStatus=PRIMARY_MATCH, ordersAllowed=True', text)
        self.assertNotIn(SECRET, text)
        self.assertNotIn('10.0.0.1', text)  # IP addresses are not echoed

    def test_report_on_incident_names_dh905(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            verdict = checker.report(checker.collect(*checker.load_token(), get=FakeDhan([INCIDENT])))
        self.assertEqual(verdict, 'account_reads_blocked')
        self.assertIn('/positions   400 DH-905  Missing required fields', out.getvalue())
        self.assertIn('1/7 endpoints OK', out.getvalue())

    def test_sends_documented_headers(self):
        fake = FakeDhan([round_()])
        checker.collect(*checker.load_token(), get=fake)
        self.assertEqual(fake.calls, len(checker.ENDPOINTS))
        self.assertEqual(set(fake.headers[0]), {'access-token', 'client-id', 'Content-Type', 'Accept'})

    def test_watch_logs_each_verdict_change_and_stops_when_ok(self):
        fake, sleeps, out = FakeDhan([INCIDENT, INCIDENT, round_()]), [], io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = checker.watch(1, get=fake, sleep=sleeps.append)
        lines = out.getvalue().splitlines()
        self.assertEqual(rc, 0)
        self.assertEqual(len(lines), 2)  # the repeat INCIDENT round prints nothing
        self.assertIn('account_reads_blocked  (1/7 OK)', lines[0])
        self.assertIn('ok  (7/7 OK)', lines[1])
        self.assertEqual(sleeps, [checker.MIN_WATCH_S] * 2)  # interval floored, no sleep after OK

    def test_token_claims(self):
        self.assertEqual(checker.token_claims(fake_jwt({'tokenConsumerType': 'APP', 'iat': 1792730338}))['tokenConsumerType'], 'APP')
        self.assertEqual(checker.token_claims(fake_jwt({'iat': 1792730338}))['iat'], '2026-10-23 10:08:58')
        self.assertEqual(checker.token_claims('not-a-jwt'), {})


if __name__ == '__main__':
    unittest.main()
