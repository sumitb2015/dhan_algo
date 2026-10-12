"""
Wire-format parser for Dhan's Global Stocks (US) Live Feed.

Pure functions only - no sockets, no files - so the layout can be unit tested against
packets built straight from the spec (docs.dhanhq.co/api/v2/global-stocks/data-apis/broadcast-websocket).
The bridge that owns the socket is scripts/tools/live_us_ws.py.

Wire facts (spec, 2026-10-12):
  * little-endian, packed, no alignment padding;
  * one WebSocket message may hold several packets back to back - loop until the buffer is used;
  * 11-byte header: u8 exchange segment (14 = INX_EQ), i32 security id, i32 security id again,
    u8 total packet length, u8 MsgCode. MsgCode is byte 10, NOT byte 0 (byte 0 is the segment);
  * Error packets (MsgCode 50) arrive alone, never batched with market data.

The installed dhanhq SDK predates GlobalStocksFeed, and the SDK's own first parser read Trade as 37
bytes and Previous Close as 19 (real sizes: 27 and 15) and detected errors at byte 0 - so every
size below is taken from the spec, and the length byte is cross-checked against it.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Iterator

HEADER_SIZE = 11
SEG_INX_EQ = 14

MSG_TRADE = 1
MSG_OHLC = 3
MSG_MARKET_STATUS = 29
MSG_PREV_CLOSE = 32
MSG_CIRCUIT = 33
MSG_WEEK52 = 36
MSG_ERROR = 50

# MsgCode -> total packet size in bytes.
SIZES = {
    MSG_TRADE: 27,
    MSG_OHLC: 27,
    MSG_MARKET_STATUS: 18,
    MSG_PREV_CLOSE: 15,
    MSG_CIRCUIT: 19,
    MSG_WEEK52: 19,
    MSG_ERROR: 13,
}

# Error packet codes (spec "Feed Disconnect"). All of them are followed by a server-side close.
ERROR_TEXT = {
    805: 'connection limit exceeded (5 per client; the oldest connection is dropped)',
    806: 'payment not done for broadcast (US feed not enabled on this account)',
    807: 'token expired',
    808: 'authentication failure',
    809: 'invalid token',
}
# Retrying cannot fix these and >10 bad attempts can get the IP blocked, so the bridge must stop.
FATAL_ERRORS = frozenset(ERROR_TEXT)

_HDR = struct.Struct('<BiiBB')
_TRADE = struct.Struct('<fiii')
_OHLC = struct.Struct('<ffff')
_ONE_F = struct.Struct('<f')
_TWO_F = struct.Struct('<ff')
_STATUS = struct.Struct('<3Bi')
_ERR = struct.Struct('<h')


@dataclass(frozen=True)
class Packet:
    kind: str                 # 'trade' | 'ohlc' | 'prev_close' | 'circuit' | 'week52' | 'market_status' | 'error' | 'unknown'
    security_id: int          # 0 on zero-filled "no data yet" reference packets and on errors
    segment: int
    code: int
    data: dict


def _px(v: float) -> float:
    # float32 on the wire: 247.32 arrives as 247.32000732421875.
    return round(float(v), 4)


def parse_packets(buf: bytes) -> tuple[list[Packet], bytes]:
    """Parse every complete packet in `buf`. Returns (packets, leftover) where leftover is a truncated
    trailing fragment (b'' normally). Never raises on a short or odd buffer - it stops instead of
    reading past the end, which is what a half-delivered frame looks like."""
    out: list[Packet] = []
    off = 0
    n = len(buf)
    while n - off >= HEADER_SIZE:
        seg, sid, _sid2, length, code = _HDR.unpack_from(buf, off)
        size = SIZES.get(code, 0)
        # The length byte is authoritative when present; fall back to the spec size when the server
        # sends 0 (seen in the SDK's captured feed) and to nothing for an unknown code with no length.
        if length >= HEADER_SIZE:
            size = length
        if size < HEADER_SIZE:
            return out, bytes(buf[off:])          # cannot step over an unknown, length-less packet
        if off + size > n:
            return out, bytes(buf[off:])          # truncated tail
        body = off + HEADER_SIZE
        pkt = _decode(code, seg, sid, buf, body, size)
        out.append(pkt)
        off += size
    return out, bytes(buf[off:])


def _decode(code: int, seg: int, sid: int, buf: bytes, body: int, size: int) -> Packet:
    avail = size - HEADER_SIZE
    try:
        if code == MSG_TRADE and avail >= _TRADE.size:
            ltp, vol, ltt, lut = _TRADE.unpack_from(buf, body)
            return Packet('trade', sid, seg, code, {'ltp': _px(ltp), 'volume': vol, 'ltt': ltt, 'lut': lut})
        if code == MSG_OHLC and avail >= _OHLC.size:
            o, c, h, l = _OHLC.unpack_from(buf, body)        # NB spec order: Open, Close, High, Low
            return Packet('ohlc', sid, seg, code, {'open': _px(o), 'close': _px(c), 'high': _px(h), 'low': _px(l)})
        if code == MSG_PREV_CLOSE and avail >= _ONE_F.size:
            return Packet('prev_close', sid, seg, code, {'prev_close': _px(_ONE_F.unpack_from(buf, body)[0])})
        if code == MSG_CIRCUIT and avail >= _TWO_F.size:
            u, l = _TWO_F.unpack_from(buf, body)
            return Packet('circuit', sid, seg, code, {'upper': _px(u), 'lower': _px(l)})
        if code == MSG_WEEK52 and avail >= _TWO_F.size:
            h, l = _TWO_F.unpack_from(buf, body)
            return Packet('week52', sid, seg, code, {'high': _px(h), 'low': _px(l)})
        if code == MSG_MARKET_STATUS and avail >= _STATUS.size:
            a, b, c, st = _STATUS.unpack_from(buf, body)
            return Packet('market_status', sid, seg, code, {'market_type': bytes((a, b, c)).hex(), 'status': st})
        if code == MSG_ERROR and avail >= _ERR.size:
            return Packet('error', sid, seg, code, {'error_code': _ERR.unpack_from(buf, body)[0]})
    except struct.error:
        pass
    return Packet('unknown', sid, seg, code, {})


def is_zero_fill(pkt: Packet) -> bool:
    """Spec: before the open the server may send a Circuit/52-week packet with ScripId 0 and 0.00
    values. That means 'no data yet' - it is valid and must not overwrite a real value."""
    return pkt.security_id == 0 and pkt.kind in ('circuit', 'week52', 'prev_close')


def fatal_error(pkt: Packet) -> str | None:
    """Reason text if this packet is a disconnect the bridge must not retry, else None.

    Only the codes in FATAL_ERRORS stop the bridge. An error code the spec does not list is reported by
    `error_text` and logged, but the connection is left to the server and the normal reconnect path: a new or
    transient code must not permanently kill the feed."""
    if pkt.kind != 'error':
        return None
    code = pkt.data.get('error_code')
    return f'{code}: {ERROR_TEXT[code]}' if code in FATAL_ERRORS else None


def error_text(pkt: Packet) -> str | None:
    """Human text for any error packet, fatal or not (None for non-errors)."""
    if pkt.kind != 'error':
        return None
    code = pkt.data.get('error_code')
    return f'{code}: {ERROR_TEXT[code]}' if code in ERROR_TEXT else f'{code}: unlisted feed error code'


class CredentialsError(RuntimeError):
    """No usable access token / client id on disk. Retrying cannot fix it - run login.py."""


# HTTP statuses on the WebSocket upgrade that mean "your credentials or plan are wrong", not "try again later".
AUTH_HTTP_STATUSES = frozenset({401, 403})


def classify_connect_error(exc: BaseException) -> str | None:
    """Reason text if a failed connect/handshake must NOT be retried, else None (retry with backoff).

    Duck-typed so this module needs no websockets import: websockets' InvalidStatus carries the rejected HTTP
    response as `.response.status_code`. Repeated invalid connects can get the source IP blocked (spec), so a
    credentials problem has to stop the bridge instead of looping every 30 s."""
    if isinstance(exc, CredentialsError):
        return f'credentials: {exc}'
    if isinstance(exc, FileNotFoundError):
        return 'credentials: access_token.json not found - run login.py'
    status = getattr(getattr(exc, 'response', None), 'status_code', None)
    if status in AUTH_HTTP_STATUSES:
        return f'handshake rejected with HTTP {status} (token invalid/expired or feed not enabled)'
    return None


def apply_packet(state: dict[int, dict], pkt: Packet) -> bool:
    """Fold one market-data packet into `state` ({security_id: quote}). Returns True if it changed anything.
    Only fields the feed actually sent are set - a Trade packet carries no volume-weighted price, no OI and
    no day range, and those are never invented here.

    `ltt` is stored as received. Observed live it runs 19,800 s (5 h 30 m) ahead of `lut`, i.e. it looks like an
    IST-shifted epoch while `lut` is a true UTC epoch - use `lut` for "how fresh is this quote"""
    if pkt.kind in ('error', 'unknown', 'market_status') or pkt.security_id == 0 or is_zero_fill(pkt):
        return False
    q = state.setdefault(pkt.security_id, {})
    d = pkt.data
    before = dict(q)
    if pkt.kind == 'trade':
        if d['ltp'] > 0:
            q['ltp'] = d['ltp']
        q['volume'] = d['volume']
        q['ltt'] = d['ltt']
        q['lut'] = d['lut']
    elif pkt.kind == 'ohlc':
        # An all-zero OHLC is a pre-open placeholder, not a day that opened at 0.
        # The packet's "Close" field is NOT stored. Observed live (2026-10-12, mid-session): it equals the previous
        # close (AAPL/MSFT/NVDA all matched their PClose packet), so reading it as a day close would show yesterday's price.
        if any(d[k] > 0 for k in ('open', 'high', 'low')):
            q['open'], q['high'], q['low'] = d['open'], d['high'], d['low']
    elif pkt.kind == 'prev_close':
        if d['prev_close'] > 0:
            q['prev_close'] = d['prev_close']
    elif pkt.kind == 'circuit':
        if d['upper'] > 0 and d['lower'] > 0:
            q['upper_circuit'], q['lower_circuit'] = d['upper'], d['lower']
    elif pkt.kind == 'week52':
        if d['high'] > 0 and d['low'] > 0:
            q['wk52_high'], q['wk52_low'] = d['high'], d['low']
    return q != before


def iter_ids(state: dict[int, dict]) -> Iterator[int]:
    return iter(state)
