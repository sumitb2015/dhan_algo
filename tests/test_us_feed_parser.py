"""lib/us_feed.py parses Dhan's Global Stocks live feed.

Packets are built here with struct from the byte layout in the spec (docs.dhanhq.co ... broadcast-websocket), not from the
parser's own constants, so a mistake in the parser's layout does not cancel out. Pure unit tests: no network, no broker session.
Run:  venv/bin/python -m unittest tests.test_us_feed_parser   (from the project root)
"""
import os
import struct
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib import us_feed as uf  # noqa: E402


def hdr(sid, length, code, seg=14):
    return struct.pack('<BiiBB', seg, sid, sid, length, code)


def trade(sid, ltp, vol=1000, ltt=1_790_000_000, lut=1_790_000_001):
    return hdr(sid, 27, 1) + struct.pack('<fiii', ltp, vol, ltt, lut)


def ohlc(sid, o, c, h, l):
    return hdr(sid, 27, 3) + struct.pack('<ffff', o, c, h, l)


def pclose(sid, p):
    return hdr(sid, 15, 32) + struct.pack('<f', p)


def circuit(sid, u, l):
    return hdr(sid, 19, 33) + struct.pack('<ff', u, l)


def week52(sid, h, l):
    return hdr(sid, 19, 36) + struct.pack('<ff', h, l)


def mstatus(sid, a, b, c, st):
    return hdr(sid, 18, 29) + struct.pack('<3Bi', a, b, c, st)


def error(code):
    return hdr(0, 13, 50, seg=0) + struct.pack('<h', code)


AAPL = 10000025


class ParserTests(unittest.TestCase):
    def test_sizes_match_spec(self):
        self.assertEqual(len(trade(1, 1.0)), 27)
        self.assertEqual(len(ohlc(1, 1, 1, 1, 1)), 27)
        self.assertEqual(len(pclose(1, 1.0)), 15)
        self.assertEqual(len(circuit(1, 1, 1)), 19)
        self.assertEqual(len(week52(1, 1, 1)), 19)
        self.assertEqual(len(mstatus(1, 0, 0, 0, 0)), 18)
        self.assertEqual(len(error(808)), 13)
        for code, size in uf.SIZES.items():
            self.assertGreaterEqual(size, uf.HEADER_SIZE, code)

    def test_trade(self):
        pk, rest = uf.parse_packets(trade(AAPL, 247.32, vol=123456))
        self.assertEqual(rest, b'')
        self.assertEqual(len(pk), 1)
        p = pk[0]
        self.assertEqual((p.kind, p.security_id, p.segment), ('trade', AAPL, 14))
        self.assertAlmostEqual(p.data['ltp'], 247.32, places=4)       # float32 noise rounded away
        self.assertEqual(p.data['volume'], 123456)
        self.assertEqual(p.data['ltt'], 1_790_000_000)

    def test_ohlc_field_order_is_open_close_high_low(self):
        p = uf.parse_packets(ohlc(AAPL, 100.0, 104.0, 105.0, 99.0))[0][0]
        self.assertEqual((p.data['open'], p.data['close'], p.data['high'], p.data['low']), (100.0, 104.0, 105.0, 99.0))

    def test_reference_packets(self):
        pcl, cir, wk = uf.parse_packets(pclose(AAPL, 245.5) + circuit(AAPL, 384.5, 207.25) + week52(AAPL, 260.1, 164.08))[0]
        self.assertEqual(pcl.data['prev_close'], 245.5)
        self.assertEqual((cir.data['upper'], cir.data['lower']), (384.5, 207.25))
        self.assertAlmostEqual(wk.data['high'], 260.1, places=3)
        self.assertAlmostEqual(wk.data['low'], 164.08, places=3)

    def test_market_status(self):
        p = uf.parse_packets(mstatus(0, 0x55, 0x53, 0x00, 2))[0][0]
        self.assertEqual(p.kind, 'market_status')
        self.assertEqual(p.data['status'], 2)
        self.assertEqual(p.data['market_type'], '555300')

    def test_batched_message_is_consumed_in_a_loop(self):
        buf = trade(1, 10.0) + pclose(1, 9.0) + trade(2, 20.0) + ohlc(2, 19, 20, 21, 18)
        pk, rest = uf.parse_packets(buf)
        self.assertEqual([p.kind for p in pk], ['trade', 'prev_close', 'trade', 'ohlc'])
        self.assertEqual([p.security_id for p in pk], [1, 1, 2, 2])
        self.assertEqual(rest, b'')

    def test_message_code_is_byte_10_not_byte_0(self):
        # Byte 0 is the segment (14). Reading it as the code would see an unknown packet type.
        buf = trade(AAPL, 5.0)
        self.assertEqual(buf[0], 14)
        self.assertEqual(buf[10], 1)
        self.assertEqual(uf.parse_packets(buf)[0][0].kind, 'trade')

    def test_error_packet_is_recognised_and_fatal(self):
        p = uf.parse_packets(error(808))[0][0]
        self.assertEqual(p.kind, 'error')
        self.assertEqual(p.data['error_code'], 808)
        self.assertIn('authentication', uf.fatal_error(p))
        for code in (805, 806, 807, 809):
            self.assertIsNotNone(uf.fatal_error(uf.parse_packets(error(code))[0][0]), code)
        self.assertIsNone(uf.fatal_error(uf.parse_packets(trade(1, 1.0))[0][0]))

    def test_unlisted_error_code_is_logged_not_fatal(self):
        p = uf.parse_packets(error(999))[0][0]
        self.assertIsNone(uf.fatal_error(p))              # a new/transient code must not permanently kill the feed
        self.assertIn('unlisted', uf.error_text(p))
        self.assertIn('token expired', uf.error_text(uf.parse_packets(error(807))[0][0]))
        self.assertIsNone(uf.error_text(uf.parse_packets(trade(1, 1.0))[0][0]))

    def test_truncated_tail_is_returned_not_read_past(self):
        full = trade(1, 10.0) + trade(2, 20.0)
        pk, rest = uf.parse_packets(full[:-5])
        self.assertEqual(len(pk), 1)
        self.assertEqual(rest, full[27:-5])
        # and the remainder completes once the rest arrives
        pk2, rest2 = uf.parse_packets(rest + full[-5:])
        self.assertEqual((len(pk2), rest2), (1, b''))

    def test_short_or_empty_buffers_never_raise(self):
        for b in (b'', b'\x0e', b'\x00' * 10, os.urandom(7)):
            pk, rest = uf.parse_packets(b)
            self.assertEqual(pk, [])
            self.assertEqual(rest, b)

    def test_zero_length_byte_falls_back_to_spec_size(self):
        raw = bytearray(trade(AAPL, 12.5))
        raw[9] = 0
        pk, rest = uf.parse_packets(bytes(raw) + pclose(AAPL, 12.0))
        self.assertEqual([p.kind for p in pk], ['trade', 'prev_close'])
        self.assertEqual(rest, b'')

    def test_unknown_code_with_a_length_is_skipped_not_fatal(self):
        unk = hdr(AAPL, 15, 77) + b'\x00\x00\x00\x00'
        pk, _ = uf.parse_packets(unk + trade(AAPL, 1.5))
        self.assertEqual([p.kind for p in pk], ['unknown', 'trade'])

    def test_unknown_code_without_a_length_stops_parsing(self):
        unk = hdr(AAPL, 0, 77)
        pk, rest = uf.parse_packets(unk + trade(AAPL, 1.5))
        self.assertEqual(pk, [])
        self.assertEqual(len(rest), 11 + 27)


class _Resp:
    def __init__(self, status_code):
        self.status_code = status_code


class _Rejected(Exception):
    """Shaped like websockets' InvalidStatus: the rejected HTTP response hangs off `.response`."""
    def __init__(self, status_code):
        super().__init__(f'server rejected WebSocket connection: HTTP {status_code}')
        self.response = _Resp(status_code)


class ConnectErrorTests(unittest.TestCase):
    def test_auth_rejections_and_missing_credentials_are_not_retried(self):
        self.assertIn('401', uf.classify_connect_error(_Rejected(401)))
        self.assertIn('403', uf.classify_connect_error(_Rejected(403)))
        self.assertIn('credentials', uf.classify_connect_error(uf.CredentialsError('run login.py')))
        self.assertIn('login.py', uf.classify_connect_error(FileNotFoundError('access_token.json')))

    def test_transient_failures_are_retried(self):
        for exc in (_Rejected(429), _Rejected(502), _Rejected(503), ConnectionResetError(), TimeoutError(), OSError('network down'), ValueError('x')):
            self.assertIsNone(uf.classify_connect_error(exc), repr(exc))


class StateTests(unittest.TestCase):
    def feed(self, state, *bufs):
        changed = []
        for b in bufs:
            for p in uf.parse_packets(b)[0]:
                changed.append(uf.apply_packet(state, p))
        return changed

    def test_snapshot_sequence_builds_a_quote(self):
        st = {}
        self.feed(st, trade(AAPL, 247.5, vol=900), pclose(AAPL, 245.0), circuit(AAPL, 384.0, 207.0), week52(AAPL, 260.0, 164.0),
                  ohlc(AAPL, 246.0, 0.0, 248.0, 245.5))
        q = st[AAPL]
        self.assertEqual((q['ltp'], q['volume'], q['prev_close']), (247.5, 900, 245.0))
        self.assertEqual((q['open'], q['high'], q['low']), (246.0, 248.0, 245.5))
        self.assertNotIn('day_close', q)              # OHLC "Close" is the previous close on the live feed; never stored
        self.assertEqual((q['upper_circuit'], q['wk52_low']), (384.0, 164.0))

    def test_zero_filled_reference_packets_do_not_clobber_real_values(self):
        st = {}
        self.feed(st, circuit(AAPL, 384.0, 207.0), week52(AAPL, 260.0, 164.0))
        changed = self.feed(st, circuit(0, 0.0, 0.0), week52(0, 0.0, 0.0), circuit(AAPL, 0.0, 0.0), week52(AAPL, 0.0, 0.0))
        self.assertEqual(changed, [False] * 4)
        self.assertEqual((st[AAPL]['upper_circuit'], st[AAPL]['wk52_high']), (384.0, 260.0))
        self.assertEqual(list(st), [AAPL])             # nothing was created under security id 0

    def test_zero_ltp_trade_keeps_last_price(self):
        st = {}
        self.feed(st, trade(AAPL, 100.0), trade(AAPL, 0.0, vol=5))
        self.assertEqual(st[AAPL]['ltp'], 100.0)
        self.assertEqual(st[AAPL]['volume'], 5)

    def test_ohlc_close_field_is_never_taken_as_a_day_close(self):
        st = {}
        self.feed(st, ohlc(AAPL, 338.0, 336.64, 342.0, 337.0))     # Close == previous close, as observed live
        self.assertNotIn('day_close', st[AAPL])
        self.assertNotIn('close', st[AAPL])

    def test_all_zero_ohlc_placeholder_is_ignored(self):
        st = {}
        self.assertEqual(self.feed(st, ohlc(AAPL, 0.0, 0.0, 0.0, 0.0)), [False])
        self.assertNotIn('open', st.get(AAPL, {}))

    def test_changed_flag_reflects_real_change_only(self):
        st = {}
        self.assertEqual(self.feed(st, trade(AAPL, 10.0)), [True])
        self.assertEqual(self.feed(st, trade(AAPL, 10.0)), [False])
        self.assertEqual(self.feed(st, trade(AAPL, 10.5)), [True])

    def test_error_and_status_packets_do_not_touch_state(self):
        st = {}
        self.assertEqual(self.feed(st, error(807), mstatus(0, 1, 2, 3, 1)), [False, False])
        self.assertEqual(st, {})


if __name__ == '__main__':
    unittest.main()
